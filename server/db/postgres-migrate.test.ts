/**
 * Tests for the Postgres migration driver and the purge helper.
 *
 * The fake `Sql` here is smaller than the one in `services.test.ts` because these two
 * modules use only tagged templates and `unsafe` — no nested `sql(value)` splices, and no
 * `begin` callback beyond the one the driver opens. It records which statements reached
 * the client and which reached a transaction handle, which is the only way to tell a
 * transactional migration from a no-transaction one.
 *
 * **No test opens a Postgres connection.** The SQL is asserted as text; whether
 * `CREATE TABLE ... UNIQUE` or `DROP TABLE ... CASCADE` behaves as written on a live
 * server is not covered here and is named in the PR body.
 */

import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert"
import type { Migration } from "./migrate.ts"
import type { Sql, Transaction } from "./ports.ts"
import {
  DEFAULT_MIGRATIONS_TABLE,
  PostgresMigrationDriver,
  PostgresMigrationLockError,
  PostgresMigrationRunInProgressError,
} from "./postgres-migrate.ts"
import { ENV_NAME, PROD_FLAG, purgeDatabase, SAFE_ENV_VALUES } from "./postgres-purge.ts"

/** Options for {@link createFakeSql}. */
interface FakeSqlOptions {
  /** Answers, drained from the front. A missing entry answers no rows. */
  answers?: unknown[][]
  /** Statement text that should reject when executed through `unsafe`. */
  failOn?: string
  /** What the server answers for the resolved-schema probe. Defaults to `public`. */
  currentSchema?: string
  /**
   * How many times `pg_try_advisory_lock` answers `false` before it answers `true`.
   *
   * Defaults to `0` — the lock is free. `Infinity` stands for a holder that never lets go,
   * which is what the bound is for.
   */
  lockRefusals?: number
}

/**
 * A recorder that renders `postgres` templates into a comparable string.
 *
 * `sql("migrations")` renders as a double-quoted identifier, as the driver does, and every
 * other value renders as `$1`, `$2`, …. Identifiers are recognised by the marker the
 * `sql(value)` call form returns, so the rendering does not depend on the statement text.
 *
 * A dot inside an identifier becomes a quoted separator, which is what the driver's own
 * `escapeIdentifier` does (`postgres@3.4.7/src/types.js:216`): `sql("public.migrations")`
 * is `"public"."migrations"`, not one identifier with a dot in its name. The driver is the
 * schema-qualified form's only implementation, so a fake that quoted the whole string
 * would assert SQL the driver never produces.
 *
 * **Statements are recorded per handle.** `topLevel` is the pool, `reserved` is the
 * connection `sql.reserve()` handed out, and `inner` is inside a `sql.begin` callback.
 * One list for all of them could not tell them apart, and the whole point of the lock is
 * that it is held on the same session the migrations run on: sending the advisory lock
 * through the pool instead left every assertion green.
 */
function createFakeSql(options: FakeSqlOptions = {}) {
  const topLevel: string[] = []
  const inner: string[] = []
  const reserved: string[] = []
  const boundValues: unknown[] = []
  const answers = options.answers ?? []
  let inTransaction = false
  let reserves = 0
  let releases = 0
  let lockAttempts = 0

  const render = (strings: TemplateStringsArray, values: unknown[]): string => {
    let text = strings[0]
    const bound: unknown[] = []
    for (let index = 0; index < values.length; index += 1) {
      const tail = strings[index + 1]
      const value = values[index]
      const identifier = identifierOf(value)
      if (identifier !== undefined) {
        text += `"${identifier.replaceAll(`"`, `""`).replaceAll(".", `"."`)}"${tail}`
      } else {
        bound.push(value)
        boundValues.push(value)
        text += `$${bound.length}${tail}`
      }
    }
    return text.trim().replace(/\s+/g, " ")
  }

  /** Which handle a statement went through. */
  type Handle = "pool" | "reserved"

  const record = (query: string, handle: Handle): void => {
    if (inTransaction) inner.push(query)
    else if (handle === "reserved") reserved.push(query)
    else topLevel.push(query)
  }

  /** One tag function over the shared recorder, bound to the handle it belongs to. */
  const makeTag = (handle: Handle) => {
    const statement = (strings: unknown, ...values: unknown[]): unknown => {
      if (!Array.isArray(strings)) return { __identifier: String(strings) }
      const query = render(strings as unknown as TemplateStringsArray, values)
      record(query, handle)
      // `withLock`'s own three statements answer themselves and do not draw on the
      // queue. A test scripts what its *driver method* reads; padding the queue for
      // statements the lock sends is a trap that moves every answer along by one the
      // moment the lock changes shape.
      if (query.includes("current_schema()")) {
        return Promise.resolve([{ schema: options.currentSchema ?? "public" }])
      }
      // The lock attempt answers a row, as `pg_try_advisory_lock` does. `lockRefusals`
      // is how a test stands in for another runner holding it.
      if (query.includes("pg_try_advisory_lock")) {
        lockAttempts += 1
        const refused = lockAttempts <= (options.lockRefusals ?? 0)
        return Promise.resolve([{ locked: !refused }])
      }
      if (query.includes("pg_advisory_")) return Promise.resolve([])
      return Promise.resolve(answers.shift() ?? [])
    }
    return Object.assign(
      statement as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>,
      {
        unsafe: (text: string) => {
          const query = text.trim().replace(/\s+/g, " ")
          record(query, handle)
          return options.failOn !== undefined && query.includes(options.failOn)
            ? Promise.reject(new Error(`fake sql rejects: ${query}`))
            : Promise.resolve([])
        },
      },
    )
  }

  const asTag = makeTag("pool")

  const client = Object.assign(asTag, {
    /**
     * `sql.reserve()`, as `postgres@3.4.7` really has it.
     *
     * The lock is a session lock, so the run has to happen on the connection the lock was
     * taken on — a fake without `reserve` would let `withLock` pass while the real driver
     * locked a session the run never used.
     *
     * **The reserved client has no `begin`.** `postgres@3.4.7` assigns `begin` to the pool
     * object alone (`src/index.js:68-81`) although `ReservedSql` is typed as inheriting
     * it, so calling it there is a `TypeError` at runtime and nothing at compile time. The
     * fake leaves it out for that reason: with `begin` on it, a driver that reached for it
     * would pass here and fail against the server.
     */
    reserve: () => {
      reserves += 1
      return Promise.resolve(
        Object.assign(makeTag("reserved"), {
          release: () => {
            releases += 1
          },
        }),
      )
    },
    begin: async <T>(callback: (transaction: Transaction) => Promise<T>): Promise<T> => {
      topLevel.push("BEGIN")
      inTransaction = true
      try {
        const result = await callback(asTag as unknown as Transaction)
        topLevel.push("COMMIT")
        return result
      } catch (error) {
        topLevel.push("ROLLBACK")
        throw error
      } finally {
        inTransaction = false
      }
    },
    end: () => Promise.resolve(),
  })

  return {
    sql: client as unknown as Sql,
    topLevel,
    inner,
    reserved,
    boundValues,
    connections: () => ({ reserves, releases }),
    lockAttempts: () => lockAttempts,
  }
}

function identifierOf(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "__identifier" in value
    ? String((value as { __identifier: unknown }).__identifier)
    : undefined
}

/** A migration as the runner hands it to a driver. */
function migration(overrides: Partial<Migration> = {}): Migration {
  return {
    fileName: "0001_init.sql",
    name: "0001_init",
    sqlText: "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    checksum: "a".repeat(64),
    withoutTransaction: false,
    ...overrides,
  }
}

/**
 * The advisory-lock key for the default `migrations` table resolved to `public`.
 *
 * Written out rather than recomputed from the implementation, so a change to how the key
 * is derived shows up here as a failure instead of agreeing with itself.
 */
const PINNED_LOCK_KEY = 2145828090877900021n

/**
 * The probe `withLock` sends before it derives the key.
 *
 * It asks the server which schema the table name actually reaches, so that a driver given
 * `schema: "public"` and a driver reaching `public.migrations` through its search path
 * take the same key. Deriving the key from the spelling alone gave them different keys
 * and let them run at the same time.
 */
const RESOLVED_SCHEMA_PROBE = "SELECT coalesce( ( SELECT n.nspname FROM pg_class c JOIN " +
  "pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass(quote_ident($1)) ), " +
  "current_schema() ) AS schema"

/**
 * The one probe `createHistoryTable` sends when no schema was named.
 *
 * It answers both questions at once — is the table there, and does it already carry the
 * checksum column — so the ordinary case of an up-to-date table costs one round trip and
 * sends no `ALTER`.
 */
const SEARCH_PATH_PROBE = "SELECT exists ( SELECT FROM information_schema.tables WHERE " +
  "table_name = $1 AND table_schema = ANY (current_schemas(false)) ) AS table_exists, " +
  "exists ( SELECT FROM information_schema.columns WHERE table_name = $2 AND " +
  "column_name = 'checksum' AND table_schema = ANY (current_schemas(false)) ) AS checksum_exists"

Deno.test("createHistoryTable creates the table once, with a unique name column", async () => {
  const fake = createFakeSql({ answers: [[{ table_exists: false, checksum_exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  assertEquals(fake.topLevel, [
    SEARCH_PATH_PROBE,
    `CREATE TABLE "migrations" ( id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, ` +
    `checksum TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP )`,
  ])
})

Deno.test("createHistoryTable adds the checksum column to a table that predates it", async () => {
  // The upgrade path for a deployment that already ran migrations, which is the one that
  // most needs the drift check. `ADD COLUMN IF NOT EXISTS` makes it a no-op afterwards.
  const fake = createFakeSql({ answers: [[{ table_exists: true, checksum_exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  assertEquals(fake.topLevel, [
    SEARCH_PATH_PROBE,
    `ALTER TABLE "migrations" ADD COLUMN IF NOT EXISTS checksum TEXT`,
  ])
})

Deno.test("createHistoryTable touches nothing when the table is already up to date", async () => {
  const fake = createFakeSql({ answers: [[{ table_exists: true, checksum_exists: true }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  assertEquals(fake.topLevel, [SEARCH_PATH_PROBE])
})

Deno.test("the history table is looked for on the search path, not on the whole server", async () => {
  // The probe used to ask for the name alone, so a `migrations` table in any other
  // schema on the server — another tenant's, another application's — answered yes and
  // the driver created nothing. The first history insert then failed on a table that
  // was not there.
  const fake = createFakeSql({ answers: [[{ table_exists: false, checksum_exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  // Each half of the probe carries the scope, and it is the table half that matters here:
  // an unscoped one answers yes for somebody else's table and the driver creates nothing.
  assertStrictEquals(
    fake.topLevel[0].includes(
      "table_name = $1 AND table_schema = ANY (current_schemas(false)) ) AS table_exists",
    ),
    true,
  )
  assertStrictEquals(fake.topLevel[0].split("current_schemas(false)").length - 1, 2)
})

Deno.test("a named schema qualifies both the probe and every statement", async () => {
  const fake = createFakeSql({
    answers: [[{ table_exists: false, checksum_exists: false }], [{ name: "0001_init" }]],
  })
  const driver = new PostgresMigrationDriver({ sql: fake.sql, schema: "tenant_1" })

  await driver.createHistoryTable()
  await driver.appliedMigrations()
  await driver.applyWithoutTransaction(migration({ withoutTransaction: true }))

  assertEquals(fake.topLevel, [
    "SELECT exists ( SELECT FROM information_schema.tables WHERE table_name = $1 AND " +
    "table_schema = $2 ) AS table_exists, exists ( SELECT FROM information_schema.columns " +
    "WHERE table_name = $3 AND column_name = 'checksum' AND table_schema = $4 ) AS " +
    "checksum_exists",
    `CREATE TABLE "tenant_1"."migrations" ( id SERIAL PRIMARY KEY, name TEXT NOT NULL ` +
    `UNIQUE, checksum TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP )`,
    `SELECT name, checksum FROM "tenant_1"."migrations" ORDER BY id`,
    "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    `INSERT INTO "tenant_1"."migrations" (name, checksum) VALUES ($1, $2)`,
  ])
})

Deno.test("createHistoryTable honours a custom table name", async () => {
  const fake = createFakeSql({ answers: [[{ table_exists: false, checksum_exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql, table: "schema_migrations" })
    .createHistoryTable()

  // The existence probe binds the name as a value; the `CREATE` splices it as an identifier.
  assertEquals(fake.topLevel[0], SEARCH_PATH_PROBE)
  assertStrictEquals(fake.topLevel[1].startsWith(`CREATE TABLE "schema_migrations" (`), true)
})

Deno.test("appliedMigrations reads the recorded rows in id order", async () => {
  const fake = createFakeSql({
    answers: [[{ name: "0001_init", checksum: "abc" }, { name: "0002_index", checksum: null }]],
  })
  const rows = await new PostgresMigrationDriver({ sql: fake.sql }).appliedMigrations()

  assertEquals(rows, [
    { name: "0001_init", checksum: "abc" },
    { name: "0002_index", checksum: null },
  ])
  assertEquals(fake.topLevel, [`SELECT name, checksum FROM "migrations" ORDER BY id`])
})

Deno.test("the lock, the run and the unlock all go through the reserved connection", async () => {
  // The lock is a *session* lock, so it has to be taken on the session the migrations run
  // on. Sending it through the pool instead protects a session the run never touches, and
  // that is exactly what a fake recording every handle into one list could not see.
  const fake = createFakeSql({ answers: [[{ table_exists: true, checksum_exists: false }]] })
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  const inside = await driver.withLock(async () => {
    await driver.createHistoryTable()
    return "ran"
  })

  assertStrictEquals(inside, "ran")
  assertEquals(fake.connections(), { reserves: 1, releases: 1 })
  assertEquals(fake.reserved, [
    RESOLVED_SCHEMA_PROBE,
    "SELECT pg_try_advisory_lock($1) AS locked",
    SEARCH_PATH_PROBE,
    `ALTER TABLE "migrations" ADD COLUMN IF NOT EXISTS checksum TEXT`,
    "SELECT pg_advisory_unlock($1)",
  ])
  // Nothing at all went through the pool.
  assertEquals(fake.topLevel, [])
})

Deno.test("withLock unlocks and releases the connection when the run throws", async () => {
  const fake = createFakeSql()
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  await assertRejects(
    () => driver.withLock(() => Promise.reject(new Error("the run failed"))),
    Error,
    "the run failed",
  )

  assertEquals(fake.reserved, [
    RESOLVED_SCHEMA_PROBE,
    "SELECT pg_try_advisory_lock($1) AS locked",
    "SELECT pg_advisory_unlock($1)",
  ])
  assertEquals(fake.topLevel, [])
  assertEquals(fake.connections(), { reserves: 1, releases: 1 })
})

Deno.test("a runner that cannot take the lock within the bound fails by name", async () => {
  // Issue #109: `pg_advisory_lock` waits for ever, so one stuck runner stopped every other
  // instance from starting and the deployment hung with nothing in the log. The bound is
  // measured against the time spent waiting *between* attempts, so this test injects a
  // delay that returns at once and never sleeps.
  const waits: number[] = []
  const fake = createFakeSql({ lockRefusals: Infinity })
  const driver = new PostgresMigrationDriver({
    sql: fake.sql,
    lockWaitMs: 500,
    lockRetryMs: 200,
    delay: (milliseconds) => {
      waits.push(milliseconds)
      return Promise.resolve()
    },
  })

  let ran = false
  const error = await assertRejects(
    () =>
      driver.withLock(() => {
        ran = true
        return Promise.resolve()
      }),
    PostgresMigrationLockError,
    "500ms",
  )

  assertStrictEquals(error.lockWaitMs, 500)
  // Nothing was applied: the run never started.
  assertStrictEquals(ran, false)
  // 200 + 200 + 100 spends exactly the bound, and the fourth refusal is the one that gives
  // up — so four attempts and three waits.
  assertEquals(waits, [200, 200, 100])
  assertStrictEquals(fake.lockAttempts(), 4)
  // The connection is handed back and no lock is left behind: nothing was taken, so there
  // is nothing to unlock.
  assertEquals(fake.connections(), { reserves: 1, releases: 1 })
  assertEquals(fake.reserved, [
    RESOLVED_SCHEMA_PROBE,
    ...Array.from({ length: 4 }, () => "SELECT pg_try_advisory_lock($1) AS locked"),
  ])
})

Deno.test("a lock bound of zero gives up on the first refusal without waiting", async () => {
  const fake = createFakeSql({ lockRefusals: Infinity })
  const driver = new PostgresMigrationDriver({
    sql: fake.sql,
    lockWaitMs: 0,
    delay: () => Promise.reject(new Error("the bound of zero must not wait")),
  })

  await assertRejects(() => driver.withLock(() => Promise.resolve()), PostgresMigrationLockError)
  assertStrictEquals(fake.lockAttempts(), 1)
})

Deno.test("a runner that takes the lock on a later attempt runs normally", async () => {
  // The other half of the bound: waiting is still what a second instance does, and it is
  // only giving up that is new.
  const fake = createFakeSql({ lockRefusals: 2 })
  const driver = new PostgresMigrationDriver({
    sql: fake.sql,
    lockWaitMs: 1_000,
    lockRetryMs: 10,
    delay: () => Promise.resolve(),
  })

  assertStrictEquals(await driver.withLock(() => Promise.resolve("ran")), "ran")
  assertStrictEquals(fake.lockAttempts(), 3)
  assertEquals(fake.reserved.at(-1), "SELECT pg_advisory_unlock($1)")
})

Deno.test("a second run on the same driver object is refused instead of deadlocking", async () => {
  // Issue #109's other half. `withLock` points this instance at the connection it
  // reserved, so a second run on the same object sent its statements down the first run's
  // connection: both held an advisory lock, the winner queued behind the loser, and the
  // process hung until it was killed.
  const fake = createFakeSql()
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = driver.withLock(() => held)

  await assertRejects(
    () => driver.withLock(() => Promise.resolve()),
    PostgresMigrationRunInProgressError,
    "already running a migration",
  )

  release()
  await first
  // One reservation, one release: the refused run touched no connection at all.
  assertEquals(fake.connections(), { reserves: 1, releases: 1 })

  // And the guard is not sticky — the object works again once the first run is over.
  assertStrictEquals(await driver.withLock(() => Promise.resolve("again")), "again")
})

Deno.test("the advisory lock key follows the resolved table and does not drift", async () => {
  // Two deployments sharing a server must lock each other out exactly when they reach the
  // same history table, however each of them spelled it — and the key has to be the same
  // value in every process and every release, or an instance running the old code and one
  // running the new code would lock different things and race each other anyway.
  const keyFor = async (
    options: { table?: string; schema?: string; currentSchema?: string },
  ): Promise<bigint> => {
    const { currentSchema, ...driverOptions } = options
    const fake = createFakeSql(currentSchema === undefined ? {} : { currentSchema })
    await new PostgresMigrationDriver({ sql: fake.sql, ...driverOptions })
      .withLock(() => Promise.resolve())
    return fake.boundValues.find((value) => typeof value === "bigint") as bigint
  }

  const plain = await keyFor({})
  assertStrictEquals(typeof plain, "bigint")
  assertStrictEquals(plain, await keyFor({}))
  assertStrictEquals(plain, PINNED_LOCK_KEY)
  // The one that matters: naming the schema the search path would have resolved to takes
  // the same key. Deriving it from the spelling alone gave these two different keys, and
  // they ran at the same time.
  assertStrictEquals(plain, await keyFor({ schema: "public" }))
  assertStrictEquals(plain === await keyFor({ table: "other" }), false)
  assertStrictEquals(plain === await keyFor({ schema: "tenant_1" }), false)
  assertStrictEquals(plain === await keyFor({ currentSchema: "tenant_1" }), false)
})

Deno.test("the resolution probe quotes the table name before looking it up", async () => {
  // `to_regclass` parses its argument as SQL text, so a bare `Hist` is folded to `hist`
  // and found nowhere, while every other statement in this driver spells the name exactly
  // as given. The key then fell back to `current_schema()`, and a driver naming the schema
  // and a driver reaching the same table through its search path took two keys, held both
  // locks at once, and ran a `.no_transaction` body twice.
  const fake = createFakeSql()
  await new PostgresMigrationDriver({ sql: fake.sql, table: "Hist" })
    .withLock(() => Promise.resolve())

  assertStrictEquals(fake.reserved[0].includes("to_regclass(quote_ident($1))"), true)
  // The name is bound, not spliced, so quoting is the server's job and injection is not
  // a question here.
  assertEquals(fake.boundValues[0], "Hist")
})

Deno.test("applyInTransaction runs the body and the history insert in one transaction", async () => {
  const fake = createFakeSql()
  await new PostgresMigrationDriver({ sql: fake.sql }).applyInTransaction(migration())

  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, [
    "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    `INSERT INTO "migrations" (name, checksum) VALUES ($1, $2)`,
  ])
})

Deno.test("inside the lock the transaction is sent as statements on the pinned connection", async () => {
  // `postgres@3.4.7` puts `begin` on the pool object only, so the reserved connection
  // `withLock` pins has none and the transaction has to be sent as statements. That is
  // safe here because every one of them goes to the one connection the run pinned.
  const fake = createFakeSql()
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  await driver.withLock(() => driver.applyInTransaction(migration()))

  assertEquals(fake.inner, [])
  assertEquals(fake.topLevel, [])
  assertEquals(fake.reserved, [
    RESOLVED_SCHEMA_PROBE,
    "SELECT pg_try_advisory_lock($1) AS locked",
    "BEGIN",
    "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    `INSERT INTO "migrations" (name, checksum) VALUES ($1, $2)`,
    "COMMIT",
    "SELECT pg_advisory_unlock($1)",
  ])
})

Deno.test("a migration that fails inside the lock is rolled back and never recorded", async () => {
  const fake = createFakeSql({ failOn: "CREATE TABLE broken" })
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  await assertRejects(
    () =>
      driver.withLock(() =>
        driver.applyInTransaction(
          migration({ sqlText: "CREATE TABLE broken (id INTEGER", name: "0003_broken" }),
        )
      ),
    Error,
    "fake sql rejects",
  )

  assertEquals(fake.topLevel, [])
  assertEquals(fake.reserved, [
    RESOLVED_SCHEMA_PROBE,
    "SELECT pg_try_advisory_lock($1) AS locked",
    "BEGIN",
    "CREATE TABLE broken (id INTEGER",
    "ROLLBACK",
    "SELECT pg_advisory_unlock($1)",
  ])
})

Deno.test("applyWithoutTransaction runs the body and the history insert with no transaction", async () => {
  const fake = createFakeSql()
  await new PostgresMigrationDriver({ sql: fake.sql }).applyWithoutTransaction(
    migration({
      fileName: "0002_index.no_transaction.sql",
      name: "0002_index",
      sqlText: "CREATE INDEX CONCURRENTLY idx_users ON users (id)",
      withoutTransaction: true,
    }),
  )

  assertEquals(fake.inner, [])
  assertEquals(fake.topLevel, [
    "CREATE INDEX CONCURRENTLY idx_users ON users (id)",
    `INSERT INTO "migrations" (name, checksum) VALUES ($1, $2)`,
  ])
})

Deno.test("a failing transactional migration rolls back and never records", async () => {
  const fake = createFakeSql({ failOn: "CREATE TABLE broken" })
  const driver = new PostgresMigrationDriver({ sql: fake.sql })

  let message = ""
  try {
    await driver.applyInTransaction(
      migration({ sqlText: "CREATE TABLE broken (id INTEGER", name: "0003_broken" }),
    )
  } catch (error) {
    message = (error as Error).message
  }

  assertStrictEquals(message.includes("fake sql rejects"), true)
  assertEquals(fake.topLevel, ["BEGIN", "ROLLBACK"])
  assertEquals(fake.inner, ["CREATE TABLE broken (id INTEGER"])
})

Deno.test("DEFAULT_MIGRATIONS_TABLE is the template's own table name", () => {
  assertStrictEquals(DEFAULT_MIGRATIONS_TABLE, "migrations")
})

/** A `test` environment: one of the values the guard admits without the flag. */
const SAFE_ENVIRONMENT = { [ENV_NAME]: "test" }

Deno.test("purgeDatabase refuses every environment it does not recognise", async () => {
  // The guard used to compare against the single literal "prod", so each of these
  // dropped the database: the ones that spell production differently, and the deployment
  // that sets no ENV at all.
  // The last four are the ones a substring comparison would let through: each contains
  // a safe name inside a name that is not safe. `production-test` is the shape that
  // matters — a production environment whose name happens to end in `test`.
  const unsafe = [
    "prod",
    "production",
    "PROD",
    "Prod",
    "prod ",
    "staging",
    "preview",
    "",
    "testing",
    "production-test",
    "dev-prod",
    "prod-ci",
  ]
  for (const value of unsafe) {
    const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
    const result = await purgeDatabase({ sql: fake.sql, environment: { [ENV_NAME]: value } })

    assertEquals(result, { dropped: [], refused: true })
    // Refused before the listing query, so nothing is even read.
    assertEquals(fake.topLevel, [])
  }
})

Deno.test("purgeDatabase refuses when ENV is unset and when no environment is given", async () => {
  const unset = createFakeSql({ answers: [[{ table_name: "users" }]] })
  assertEquals(await purgeDatabase({ sql: unset.sql, environment: {} }), {
    dropped: [],
    refused: true,
  })
  assertEquals(unset.topLevel, [])

  const missing = createFakeSql({ answers: [[{ table_name: "users" }]] })
  assertEquals(await purgeDatabase({ sql: missing.sql }), { dropped: [], refused: true })
  assertEquals(missing.topLevel, [])
})

Deno.test("purgeDatabase runs for each safe environment, spelled loosely", async () => {
  for (const value of [...SAFE_ENV_VALUES, " Dev ", "TEST", "CI"]) {
    const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
    const result = await purgeDatabase({ sql: fake.sql, environment: { [ENV_NAME]: value } })

    assertEquals(result, { dropped: ["users"], refused: false })
  }
})

Deno.test("SAFE_ENV_VALUES cannot be extended at runtime", () => {
  // `readonly` is a compile-time claim and nothing more. A consumer that casts the array
  // and pushes onto it used to arm the purge for that environment in every module that
  // had imported it, for the rest of the process.
  assertThrows(() => (SAFE_ENV_VALUES as string[]).push("production"), TypeError)
  assertThrows(() => ((SAFE_ENV_VALUES as string[])[0] = "production"), TypeError)
  assertEquals(SAFE_ENV_VALUES, ["dev", "development", "local", "test", "ci"])
})

Deno.test("purgeDatabase is not armed by an argument that is not the flag", async () => {
  // The override is one exact argument. A command line that carries anything at all —
  // a `--dry-run`, a file path, the script's own name — must not count as asking for a
  // production purge.
  for (const args of [["--dry-run"], ["--PROD"], ["--prod=yes"], [" --prod"], ["purge.ts"]]) {
    const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
    const result = await purgeDatabase({
      sql: fake.sql,
      environment: { [ENV_NAME]: "production" },
      args,
    })

    assertEquals(result, { dropped: [], refused: true })
    assertEquals(fake.topLevel, [])
  }
})

Deno.test("purgeDatabase proceeds in an unsafe environment when --prod is passed", async () => {
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({
    sql: fake.sql,
    environment: { [ENV_NAME]: "production" },
    args: [PROD_FLAG],
  })

  assertEquals(result, { dropped: ["users"], refused: false })
})

Deno.test("purgeDatabase drops every base table, schema-qualified and CASCADE", async () => {
  const fake = createFakeSql({
    answers: [[{ table_name: "users" }, { table_name: "sessions" }, { table_name: "migrations" }]],
  })
  const result = await purgeDatabase({ sql: fake.sql, environment: SAFE_ENVIRONMENT })

  assertEquals(result, { dropped: ["users", "sessions", "migrations"], refused: false })
  assertEquals(fake.topLevel, [
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND " +
    "table_type = 'BASE TABLE'",
    `DROP TABLE "public"."users" CASCADE`,
    `DROP TABLE "public"."sessions" CASCADE`,
    `DROP TABLE "public"."migrations" CASCADE`,
  ])
})

Deno.test("purgeDatabase reports an empty database without dropping anything", async () => {
  const fake = createFakeSql({ answers: [[]] })
  const result = await purgeDatabase({ sql: fake.sql, environment: SAFE_ENVIRONMENT })

  assertEquals(result, { dropped: [], refused: false })
  assertEquals(fake.topLevel.length, 1)
})

Deno.test("purgeDatabase reads the snake_case column a plain client returns", async () => {
  // A client without `transform: postgres.camel` returns `table_name`; reading `tableName`
  // would drop nothing and report success, which is what the source did.
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({ sql: fake.sql, environment: SAFE_ENVIRONMENT })

  assertEquals(result.dropped, ["users"])
})

Deno.test("purgeDatabase drops a custom schema's own tables, not public's", async () => {
  // The listing is answered with a table name, so a DROP is actually issued and can be
  // read. The earlier version of this test answered with no rows, so it asserted the
  // listing and never saw that the DROP dropped an unqualified name — which
  // `search_path` resolves to `public`, a different table that happens to share a name.
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({
    sql: fake.sql,
    schema: "tenant_1",
    environment: SAFE_ENVIRONMENT,
  })

  assertEquals(result, { dropped: ["users"], refused: false })
  assertEquals(fake.topLevel[0].includes("table_schema = $1"), true)
  assertEquals(fake.topLevel[1], `DROP TABLE "tenant_1"."users" CASCADE`)
})
