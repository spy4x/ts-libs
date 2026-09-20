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

import { assertEquals, assertStrictEquals } from "@std/assert"
import type { Migration } from "./migrate.ts"
import type { Sql, Transaction } from "./ports.ts"
import { DEFAULT_MIGRATIONS_TABLE, PostgresMigrationDriver } from "./postgres-migrate.ts"
import { ENV_NAME, PROD_FLAG, PRODUCTION_ENV_VALUE, purgeDatabase } from "./postgres-purge.ts"

/** Options for {@link createFakeSql}. */
interface FakeSqlOptions {
  /** Answers, drained from the front. A missing entry answers no rows. */
  answers?: unknown[][]
  /** Statement text that should reject when executed through `unsafe`. */
  failOn?: string
}

/**
 * A recorder that renders `postgres` templates into a comparable string.
 *
 * `sql("migrations")` renders as a double-quoted identifier, as the driver does, and every
 * other value renders as `$1`, `$2`, …. Identifiers are recognised by the marker the
 * `sql(value)` call form returns, so the rendering does not depend on the statement text.
 */
function createFakeSql(options: FakeSqlOptions = {}) {
  const topLevel: string[] = []
  const inner: string[] = []
  const answers = options.answers ?? []
  let inTransaction = false

  const render = (strings: TemplateStringsArray, values: unknown[]): string => {
    let text = strings[0]
    const bound: unknown[] = []
    for (let index = 0; index < values.length; index += 1) {
      const tail = strings[index + 1]
      const value = values[index]
      const identifier = identifierOf(value)
      if (identifier !== undefined) {
        text += `"${identifier}"${tail}`
      } else {
        bound.push(value)
        text += `$${bound.length}${tail}`
      }
    }
    return text.trim().replace(/\s+/g, " ")
  }

  const record = (query: string): void => {
    if (inTransaction) inner.push(query)
    else topLevel.push(query)
  }

  const statement = (strings: unknown, ...values: unknown[]): unknown => {
    if (!Array.isArray(strings)) return { __identifier: String(strings) }
    const query = render(strings as unknown as TemplateStringsArray, values)
    record(query)
    return Promise.resolve(answers.shift() ?? [])
  }

  const asTag = statement as (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown>

  const client = Object.assign(asTag, {
    unsafe: (text: string) => {
      const query = text.trim().replace(/\s+/g, " ")
      record(query)
      return options.failOn !== undefined && query.includes(options.failOn)
        ? Promise.reject(new Error(`fake sql rejects: ${query}`))
        : Promise.resolve([])
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

  return { sql: client as unknown as Sql, topLevel, inner }
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
    withoutTransaction: false,
    ...overrides,
  }
}

Deno.test("createHistoryTable creates the table once, with a unique name column", async () => {
  const fake = createFakeSql({ answers: [[{ exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  assertEquals(fake.topLevel, [
    "SELECT exists ( SELECT FROM information_schema.tables WHERE table_name = $1 ) AS exists",
    `CREATE TABLE "migrations" ( id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL UNIQUE, ` +
    `created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP )`,
  ])
})

Deno.test("createHistoryTable leaves an existing table alone", async () => {
  const fake = createFakeSql({ answers: [[{ exists: true }]] })
  await new PostgresMigrationDriver({ sql: fake.sql }).createHistoryTable()

  assertEquals(fake.topLevel.length, 1)
  assertStrictEquals(fake.topLevel[0].startsWith("SELECT exists"), true)
})

Deno.test("createHistoryTable honours a custom table name", async () => {
  const fake = createFakeSql({ answers: [[{ exists: false }]] })
  await new PostgresMigrationDriver({ sql: fake.sql, table: "schema_migrations" })
    .createHistoryTable()

  // The existence probe binds the name as a value; the `CREATE` splices it as an identifier.
  assertEquals(
    fake.topLevel[0],
    [
      "SELECT exists ( SELECT FROM information_schema.tables WHERE table_name = $1 ) AS exists",
    ].join(""),
  )
  assertStrictEquals(fake.topLevel[1].startsWith(`CREATE TABLE "schema_migrations" (`), true)
})

Deno.test("appliedNames reads the recorded names in id order", async () => {
  const fake = createFakeSql({ answers: [[{ name: "0001_init" }, { name: "0002_index" }]] })
  const names = await new PostgresMigrationDriver({ sql: fake.sql }).appliedNames()

  assertEquals(names, ["0001_init", "0002_index"])
  assertEquals(fake.topLevel, [`SELECT name FROM "migrations" ORDER BY id`])
})

Deno.test("applyInTransaction runs the body and the history insert in one transaction", async () => {
  const fake = createFakeSql()
  await new PostgresMigrationDriver({ sql: fake.sql }).applyInTransaction(migration())

  assertEquals(fake.topLevel, ["BEGIN", "COMMIT"])
  assertEquals(fake.inner, [
    "CREATE TABLE users (id SERIAL PRIMARY KEY)",
    `INSERT INTO "migrations" (name) VALUES ($1)`,
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
    `INSERT INTO "migrations" (name) VALUES ($1)`,
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

Deno.test("purgeDatabase refuses in production without the --prod flag and runs no query", async () => {
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({
    sql: fake.sql,
    environment: { [ENV_NAME]: PRODUCTION_ENV_VALUE },
  })

  assertEquals(result, { dropped: [], refused: true })
  assertEquals(fake.topLevel, [])
})

Deno.test("purgeDatabase proceeds in production when --prod is passed", async () => {
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({
    sql: fake.sql,
    environment: { [ENV_NAME]: PRODUCTION_ENV_VALUE },
    args: [PROD_FLAG],
  })

  assertEquals(result, { dropped: ["users"], refused: false })
})

Deno.test("purgeDatabase proceeds in a non-production environment without the flag", async () => {
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({ sql: fake.sql, environment: { [ENV_NAME]: "staging" } })

  assertEquals(result, { dropped: ["users"], refused: false })
})

Deno.test("purgeDatabase drops every base table in public, CASCADE", async () => {
  const fake = createFakeSql({
    answers: [[{ table_name: "users" }, { table_name: "sessions" }, { table_name: "migrations" }]],
  })
  const result = await purgeDatabase({ sql: fake.sql })

  assertEquals(result, { dropped: ["users", "sessions", "migrations"], refused: false })
  assertEquals(fake.topLevel, [
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND " +
    "table_type = 'BASE TABLE'",
    `DROP TABLE "users" CASCADE`,
    `DROP TABLE "sessions" CASCADE`,
    `DROP TABLE "migrations" CASCADE`,
  ])
})

Deno.test("purgeDatabase reports an empty database without dropping anything", async () => {
  const fake = createFakeSql({ answers: [[]] })
  const result = await purgeDatabase({ sql: fake.sql })

  assertEquals(result, { dropped: [], refused: false })
  assertEquals(fake.topLevel.length, 1)
})

Deno.test("purgeDatabase reads the snake_case column a plain client returns", async () => {
  // A client without `transform: postgres.camel` returns `table_name`; reading `tableName`
  // would drop nothing and report success, which is what the source did.
  const fake = createFakeSql({ answers: [[{ table_name: "users" }]] })
  const result = await purgeDatabase({ sql: fake.sql })

  assertEquals(result.dropped, ["users"])
})

Deno.test("purgeDatabase honours a custom schema", async () => {
  const fake = createFakeSql({ answers: [[]] })
  await purgeDatabase({ sql: fake.sql, schema: "tenant_1" })

  assertEquals(fake.topLevel[0].includes("table_schema = $1"), true)
})
