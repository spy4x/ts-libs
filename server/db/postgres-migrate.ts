/**
 * The Postgres side of the migration runner.
 *
 * `template/libs/server/db/migrate.ts` was an 88-line script: it hardcoded
 * `./libs/server/db/migrations` (`:6`), printed progress and called `Deno.exit`
 * from inside its own `try` blocks (`:35,47,61,80,84`). Here the same mechanics
 * live behind {@link MigrationDriver} in `migrate.ts`, so the folder is an
 * argument, the report is a return value, and the SQLite adapter shares the file
 * discovery, the sort order, the history filter and the `.no_transaction` switch.
 *
 * Three schema decisions, all deliberate:
 *
 *  - `name` is `UNIQUE`. The template's `CREATE TABLE migrations`
 *    (`:24-30`) was not, and neither was the `migrations` table in template's
 *    `schema.sql:10-14`. Two runners starting together would therefore both see an
 *    empty history, both apply the same file, and record it twice with no error.
 *    With the constraint the second insert fails and the second runner's
 *    transaction rolls back — a loud failure instead of a doubled migration. It is
 *    additive against an existing table only if that table has no duplicate names,
 *    which is exactly the state this constraint is meant to prevent. It is a backstop
 *    now rather than the whole defence: {@link PostgresMigrationDriver.withLock} is
 *    what stops the two runners racing in the first place.
 *  - `name` is `TEXT`, not `VARCHAR(100)`. Postgres stores the two identically and a
 *    hundred characters is an arbitrary ceiling on a file name. An existing table keeps
 *    the column it has; this changes newly created tables only.
 *  - `applied_at` is not stored separately. `created_at` in the template's shape
 *    already records when the row was inserted, and that insert is the last
 *    statement of the migration's transaction, so it is the application time.
 *
 * `checksum` is added to an existing history table as well as to a new one, because a
 * deployment that already ran migrations is exactly the one that needs the drift check.
 * Rows written before the column existed hold `NULL`, which the runner reads as unknown.
 */

import { type AppliedMigration, type Migration, type MigrationDriver } from "./migrate.ts"
import type { Sql } from "./ports.ts"

/** The default history table name, matching the template's `migrations` table. */
export const DEFAULT_MIGRATIONS_TABLE = "migrations"

/**
 * How long a runner waits for another runner's lock before giving up, in milliseconds.
 *
 * A minute, which is longer than any migration run this library has measured and short
 * enough that a deployment blocked behind a stuck runner says so rather than hanging. A
 * deployment whose slowest honest run is longer raises it with
 * {@link PostgresMigrationDriverOptions.lockWaitMs}; failing loudly is the trade.
 */
export const DEFAULT_MIGRATION_LOCK_WAIT_MS = 60_000

/** How long a runner waits between attempts to take the lock, in milliseconds. */
export const DEFAULT_MIGRATION_LOCK_RETRY_MS = 250

/**
 * A delay, so a test of the bound does not have to sleep through it.
 *
 * The same shape as `SqliteDelay` in `sqlite.ts` minus the cancellation, which this one
 * does not need: every wait here is awaited to completion before the next attempt.
 */
export type MigrationDelay = (milliseconds: number) => Promise<void>

/** The default delay: `setTimeout`. */
const defaultDelay: MigrationDelay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * Thrown when a runner waited out its bound without taking the migration lock.
 *
 * Another runner is holding the lock on this history table and has been for longer than
 * {@link PostgresMigrationDriverOptions.lockWaitMs}. Nothing has been applied by this
 * runner and nothing is half-done; the run simply did not start.
 *
 * What to do: find the holder. `SELECT * FROM pg_locks WHERE locktype = 'advisory'` names
 * the backend, and `pg_stat_activity` says what it is running. A holder that is genuinely
 * still migrating needs a longer bound on the instances behind it; a holder that is stuck
 * needs to be dealt with, and killing its backend releases the lock with its session.
 */
export class PostgresMigrationLockError extends Error {
  /** The bound that was exceeded, in milliseconds. */
  readonly lockWaitMs: number

  constructor(lockWaitMs: number) {
    super(
      `another migration runner has held the lock on this history table for longer than ` +
        `${lockWaitMs}ms, so this run gave up without applying anything; find the holder ` +
        `in pg_locks and pg_stat_activity, or raise lockWaitMs if the run behind it is ` +
        `honestly that slow`,
    )
    this.name = "PostgresMigrationLockError"
    this.lockWaitMs = lockWaitMs
  }
}

/**
 * Thrown when a second run is started on a driver object that is already running one.
 *
 * {@link PostgresMigrationDriver.withLock} points the instance at one reserved connection
 * for the length of a run, so a second run on the same object would send its statements on
 * the first run's connection. Both then hold an advisory lock, the winner's statements
 * queue behind the loser's, and the process hangs with nothing in the log — measured on
 * issue #109. Two concurrent runs are two driver objects, which is also what two
 * application instances are.
 */
export class PostgresMigrationRunInProgressError extends Error {
  constructor() {
    super(
      `this PostgresMigrationDriver is already running a migration; it pins one connection ` +
        `for the length of a run, so a second run on the same object would deadlock — give ` +
        `the second run its own driver`,
    )
    this.name = "PostgresMigrationRunInProgressError"
  }
}

/**
 * Thrown when the client's own column-name transform would send a table or schema name to
 * Postgres spelled differently than this driver — or {@link purgeDatabase} in
 * `postgres-purge.ts` — was given it, before any statement runs.
 *
 * `sql(name)` — the identifier form every `CREATE TABLE`/`ALTER TABLE`/`INSERT`/`DROP TABLE`
 * in this driver and in {@link purgeDatabase} uses — runs the client's `transform.column.to`
 * on `name` first (`postgres@3.4.7/src/index.js:114`), the transform `PostgresOutboxRepository`
 * also guards against on the read side. `postgres.camel`'s half of it, `fromCamel`, turns a mixed-case
 * name like `x_MixedHist` into `x__mixed_hist`, and `"UserProfile"` into `_user_profile`.
 * Every *other* place this driver or the purge helper names a table or schema —
 * `createHistoryTable`'s probe, `to_regclass`, the advisory-lock key, the purge listing —
 * passes the name as a bound *value*, which that transform never touches. A camelCase
 * client given a name the transform rewrites therefore creates or drops one object and
 * looks the rest of the statements up against a differently-spelled one: `CREATE TABLE`
 * makes `x__mixed_hist` while `createHistoryTable`'s own probe still asks about
 * `x_MixedHist`, finds nothing, and reissues `CREATE TABLE` on the next run — the same
 * "relation already exists" failure this package fixed for the ordinary case, reopened by a
 * name the transform does not leave alone.
 *
 * Reconciling the two spellings is not attempted: a name the transform leaves unchanged has
 * one spelling everywhere, which is the property every other statement here relies on, so a
 * name it would rewrite is refused up front instead — lower-case with underscores, or a
 * client with no `transform.column.to`, is what to use instead.
 */
export class PostgresIdentifierTransformError extends Error {
  /** `"table"` or `"schema"` — which name the transform would rewrite. */
  readonly kind: "table" | "schema"
  /** The name as given to this driver or to {@link purgeDatabase}. */
  readonly identifier: string
  /** What the client's `transform.column.to` would send to Postgres instead. */
  readonly rewrittenTo: string

  constructor(kind: "table" | "schema", identifier: string, rewrittenTo: string) {
    super(
      `this client's transform.column.to would send the ${kind} name ` +
        `${JSON.stringify(identifier)} to Postgres as ${JSON.stringify(rewrittenTo)}, and ` +
        `only some of this driver's statements go through that transform, so the object it ` +
        `creates or drops and the object its other statements look up would not be the ` +
        `same one; use a ${kind} name the transform leaves unchanged — lower-case with ` +
        `underscores, no other case change — or a client with no transform.column.to`,
    )
    this.name = "PostgresIdentifierTransformError"
    this.kind = kind
    this.identifier = identifier
    this.rewrittenTo = rewrittenTo
  }
}

/**
 * `identifier` as `sql`'s own `transform.column.to` would rewrite it, or `undefined` when
 * the client has no such transform, or this identifier already has the one spelling the
 * transform would give it.
 *
 * `postgres@3.4.7` sets `options` on the pool object alone (`src/index.js:69-81`): the handle
 * `sql.begin` passes to its callback and the one `sql.reserve()` returns have none, although
 * both are typed as `Sql`. On such a handle the transform cannot be read, so the name is not
 * checked and `undefined` is returned; pass the pool client to have it checked.
 */
export function identifierRewrittenBy(sql: Sql, identifier: string): string | undefined {
  // Optional: see above. `!to` rather than `=== undefined`, as the driver's own `sql(name)`
  // tests it (`src/index.js:114`).
  const to = sql.options?.transform.column.to
  if (!to) return undefined
  const rewritten = to(identifier)
  return rewritten === identifier ? undefined : rewritten
}

/**
 * Throws {@link PostgresIdentifierTransformError} when `sql`'s own transform would rewrite
 * `identifier` — see that error for why a rewritten name cannot be used as given.
 */
export function assertStableIdentifier(
  sql: Sql,
  kind: "table" | "schema",
  identifier: string,
): void {
  const rewrittenTo = identifierRewrittenBy(sql, identifier)
  if (rewrittenTo !== undefined) {
    throw new PostgresIdentifierTransformError(kind, identifier, rewrittenTo)
  }
}

/** Options for {@link PostgresMigrationDriver}. */
export interface PostgresMigrationDriverOptions {
  /** Client to run through. */
  sql: Sql
  /** History table name. Defaults to `migrations`. */
  table?: string
  /**
   * Milliseconds to wait for another runner's lock before {@link PostgresMigrationLockError}.
   *
   * Defaults to {@link DEFAULT_MIGRATION_LOCK_WAIT_MS}. It counts the time this runner
   * spends *waiting between attempts*; the attempts themselves are round trips to the
   * server and are not added to it, which is what lets a test of the bound inject a delay
   * and finish immediately. `0` gives up on the first refusal.
   */
  lockWaitMs?: number
  /**
   * Milliseconds between attempts to take the lock. Defaults to
   * {@link DEFAULT_MIGRATION_LOCK_RETRY_MS}. Values below 1 are raised to 1, so a run
   * cannot spin.
   */
  lockRetryMs?: number
  /** Delay used while waiting. Defaults to `setTimeout`. See {@link MigrationDelay}. */
  delay?: MigrationDelay
  /**
   * Schema holding the history table. Defaults to the connection's `search_path`.
   *
   * Left out, the table is created and read unqualified, which is what a deployment with
   * one schema wants and what this driver has always done. Given, every statement names
   * the schema, which is what a test or a multi-tenant deployment needs in order to keep
   * two histories apart on one server.
   */
  schema?: string
}

/** A row of the history table, read for its name and its checksum. */
interface MigrationRow {
  name: string
  checksum: string | null
}

/**
 * What `createHistoryTable`'s one probe answers: is the table there, is it up to date.
 *
 * Aliased to one lower-case word with no underscore, not `table_exists`/`checksum_exists`:
 * `postgres.camel` — a transform a caller may configure on its own client, the transform
 * `PostgresOutboxRepository` also guards against — turns a returned `table_exists` into
 * `tableExists`, which left this probe reading `undefined` for both flags on a camelCase
 * client, so
 * `createHistoryTable` treated an existing history table as absent and reissued
 * `CREATE TABLE`, failing every run after the first with `relation already exists`. A
 * bare lower-case word has no underscore for the transform to act on, so it comes back
 * unchanged whether the client transforms or not.
 */
interface HistoryProbe {
  tableexists: boolean
  checksumexists: boolean
}

/**
 * Applies migrations to Postgres, one transaction per migration.
 *
 * `applyWithoutTransaction` exists because a `CREATE INDEX CONCURRENTLY` cannot
 * run inside a transaction block; it runs the script and records it as two
 * statements, which is why a failing no-transaction migration can be recorded as
 * applied without having finished. Suffix the file `.no_transaction.sql` only when
 * the statement genuinely requires it.
 *
 * **One run at a time per instance.** {@link withLock} pins a connection and points this
 * instance's statements at it for the length of the run, so a second run started on the
 * *same instance* while the first is still going would share that connection. That is now
 * refused with {@link PostgresMigrationRunInProgressError} rather than deadlocking (#109).
 * Two concurrent runs are two instances, which is also what two application instances are.
 *
 * **A table or schema name the client's own transform would rewrite is refused at
 * construction**, with {@link PostgresIdentifierTransformError}, before any statement runs —
 * see that error for why this driver cannot reconcile the two spellings on its own.
 */
export class PostgresMigrationDriver implements MigrationDriver {
  /**
   * Not `readonly`: {@link withLock} swaps in the reserved connection for the length of
   * a run, so the lock and the statements it protects share one session.
   */
  private sql: Sql
  /**
   * `true` while {@link withLock} has this instance pointed at a reserved connection.
   *
   * It decides how {@link applyInTransaction} opens its transaction, for a reason that is
   * a defect in the driver rather than a choice here; see that method.
   */
  private pinned = false
  /** `true` between the start and the end of a {@link withLock} run on this object. */
  private running = false
  private readonly table: string
  private readonly schema: string | undefined
  private readonly lockWaitMs: number
  private readonly lockRetryMs: number
  private readonly delay: MigrationDelay
  /** `"migrations"` or `"public.migrations"`, as the driver's identifier helper takes it. */
  private readonly tableRef: string

  constructor(options: PostgresMigrationDriverOptions) {
    this.sql = options.sql
    this.table = options.table ?? DEFAULT_MIGRATIONS_TABLE
    this.schema = options.schema
    this.lockWaitMs = options.lockWaitMs ?? DEFAULT_MIGRATION_LOCK_WAIT_MS
    this.lockRetryMs = Math.max(1, options.lockRetryMs ?? DEFAULT_MIGRATION_LOCK_RETRY_MS)
    this.delay = options.delay ?? defaultDelay
    // Before any SQL runs: see PostgresIdentifierTransformError for why a name the
    // client's own transform would rewrite cannot be used as given.
    assertStableIdentifier(this.sql, "table", this.table)
    if (this.schema !== undefined) assertStableIdentifier(this.sql, "schema", this.schema)
    // `postgres` renders a dot inside an identifier as a quoted separator —
    // `escapeIdentifier` in `postgres@3.4.7/src/types.js:216` turns `a.b` into `"a"."b"`
    // — so one splice carries a qualified name and both halves are still quoted.
    this.tableRef = this.schema === undefined ? this.table : `${this.schema}.${this.table}`
  }

  /**
   * Hold a Postgres advisory lock for the whole run, on one pinned connection.
   *
   * A session-level advisory lock rather than a transaction-scoped one, because the run
   * is not one transaction: it is a transaction per migration plus the bare statements a
   * `.no_transaction` migration needs, and a lock that ended with the first transaction
   * would leave the rest of the run unprotected. A session lock needs a session that
   * outlives the individual transactions, which is what `sql.reserve()` gives — and
   * pinning that connection for the run costs nothing, because the run is sequential
   * anyway and it removes the pool-starvation trap a lock held on a *second* connection
   * would carry for a client with `max: 1`.
   *
   * The key is the first eight bytes of the SHA-256 of the table's **resolved** name,
   * read as a signed 64-bit integer. Resolved, not as the caller spelled it: the server
   * is asked which schema the name reaches, so a driver given `schema: "app"` and a
   * driver that reaches an existing `app.migrations` through its search path take the
   * same key and lock each other out. Deriving it from the spelling alone did not — the
   * two ran at the same time and one of them crashed inside Postgres's own catalogue.
   * {@link resolvedTableRef} has the one case the resolution cannot cover.
   *
   * **The wait is bounded** (#109). `pg_try_advisory_lock` in a retry loop rather than
   * `pg_advisory_lock`, which waits for ever: a second runner starting during a migration
   * should apply nothing and carry on, but one stuck runner used to stop every other
   * instance from starting, with nothing in the log to say why. After
   * {@link PostgresMigrationDriverOptions.lockWaitMs} the runner gives up with
   * {@link PostgresMigrationLockError}, having applied nothing. A runner that dies holding
   * the lock releases it when its connection closes, so there is no stale lock to clear by
   * hand.
   *
   * **A second run on this same object is refused at once**, with
   * {@link PostgresMigrationRunInProgressError}, rather than deadlocking against the
   * connection the first run pinned.
   *
   * **A connection lost mid-run is not a catchable error, and cannot be made one here.**
   * The server releases the advisory lock when the session ends, which is correct, and
   * nothing is applied twice because the run does not continue. What the caller sees is an
   * uncaught `TypeError: Cannot read properties of null (reading 'write')` raised from
   * inside `postgres@3.4.7/src/connection.js:250` on a timer the driver owns, not a
   * rejected promise this method could wrap. Written down rather than dressed up (#109).
   */
  async withLock<T>(run: () => Promise<T>): Promise<T> {
    // Before the first `await`, so two runs started together cannot both pass it.
    if (this.running) throw new PostgresMigrationRunInProgressError()
    this.running = true
    try {
      return await this.withReservedLock(run)
    } finally {
      this.running = false
    }
  }

  /** {@link withLock} with the one-run-per-object guard already passed. */
  private async withReservedLock<T>(run: () => Promise<T>): Promise<T> {
    const reserved = await this.sql.reserve()
    const pooled = this.sql
    this.sql = reserved as unknown as Sql
    this.pinned = true
    try {
      // On the reserved connection, because the answer depends on that session's
      // `search_path` and the run is about to use that same session.
      const key = await advisoryLockKey(await this.resolvedTableRef(reserved as unknown as Sql))
      await this.takeLock(reserved as unknown as Sql, key)
      try {
        return await run()
      } finally {
        await reserved`SELECT pg_advisory_unlock(${key})`
      }
    } finally {
      this.sql = pooled
      this.pinned = false
      reserved.release()
    }
  }

  /**
   * Take the advisory lock, or give up after the bound.
   *
   * One attempt is always made, so `lockWaitMs: 0` means "fail on the first refusal"
   * rather than "do not try". The accumulated wait is what the bound is measured against —
   * see {@link PostgresMigrationDriverOptions.lockWaitMs} — so an injected delay makes this
   * loop finish in no time at all and a test of the bound never sleeps.
   */
  private async takeLock(sql: Sql, key: bigint): Promise<void> {
    let waited = 0
    for (;;) {
      const rows = await sql<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${key}) AS locked
      `
      if (rows[0]?.locked === true) return
      if (waited >= this.lockWaitMs) throw new PostgresMigrationLockError(this.lockWaitMs)
      const step = Math.max(1, Math.min(this.lockRetryMs, this.lockWaitMs - waited))
      await this.delay(step)
      waited += step
    }
  }

  /**
   * `schema.table` for the table this driver will actually read and write.
   *
   * A named schema is the answer already. Without one, the server is asked: `to_regclass`
   * resolves the bare name through this session's `search_path` and gives the schema it
   * found it in, and when the table does not exist yet `current_schema()` is where
   * `CREATE TABLE` will put it. Both are the schema this run ends up working in, which is
   * what the lock key has to follow.
   *
   * The name goes through `quote_ident` first. `to_regclass` parses its argument as SQL
   * text, so a bare `Hist` is folded to `hist` and found nowhere, while every other
   * statement in this driver spells the name exactly as the caller gave it. Measured: with
   * a mixed-case name the lookup missed, the key fell back to `current_schema()`, a driver
   * naming the schema and a driver reaching the same table through its search path took
   * two keys, both held a lock at once and a `.no_transaction` body ran twice.
   * `quote_ident` also doubles an embedded double quote, so a name that carries one
   * resolves too.
   *
   * **One limit stays, and it is not closable here.** The key is resolved before the lock
   * is taken and, on a first run, before the table exists, so `current_schema()` is the
   * answer for both runners — and two runners whose search paths *start* with different
   * schemas resolve two keys. If the second one's existence probe then finds the table the
   * first has just created, they work on one table under two keys. Every runner of one
   * history table must therefore share a `search_path` or pass the same {@link
   * PostgresMigrationDriverOptions.schema}; that is a deployment rule, not something this
   * method can check.
   */
  private async resolvedTableRef(sql: Sql): Promise<string> {
    if (this.schema !== undefined) return `${this.schema}.${this.table}`
    const rows = await sql<{ schema: string | null }[]>`
      SELECT coalesce(
        (
          SELECT n.nspname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = to_regclass(quote_ident(${this.table}))
        ),
        current_schema()
      ) AS schema
    `
    return `${rows[0]?.schema ?? ""}.${this.table}`
  }

  /**
   * Create the history table when absent, leaving an existing one's rows untouched.
   *
   * The existence probe is schema-aware. It used to ask `information_schema.tables` for
   * the name alone, so a table of that name in any schema on the server — a second
   * tenant's, another application's — answered yes and the driver created nothing, and
   * the first history insert then failed on a table that was not there.
   *
   * An existing table gains the `checksum` column, so a deployment upgrading to this
   * version gets the drift check on its next run. The one probe answers both questions —
   * is the table there, and does it have the column — so the usual case, an up-to-date
   * table, costs one round trip and issues no `ALTER` at all. The `ALTER` keeps its
   * `IF NOT EXISTS` anyway, for a caller that runs this outside {@link withLock}.
   */
  async createHistoryTable(): Promise<void> {
    const probe = this.schema === undefined
      ? await this.sql<HistoryProbe[]>`
        SELECT
          exists (
            SELECT FROM information_schema.tables
            WHERE table_name = ${this.table} AND table_schema = ANY (current_schemas(false))
          ) AS tableexists,
          exists (
            SELECT FROM information_schema.columns
            WHERE table_name = ${this.table} AND column_name = 'checksum'
            AND table_schema = ANY (current_schemas(false))
          ) AS checksumexists
      `
      : await this.sql<HistoryProbe[]>`
        SELECT
          exists (
            SELECT FROM information_schema.tables
            WHERE table_name = ${this.table} AND table_schema = ${this.schema}
          ) AS tableexists,
          exists (
            SELECT FROM information_schema.columns
            WHERE table_name = ${this.table} AND column_name = 'checksum'
            AND table_schema = ${this.schema}
          ) AS checksumexists
      `
    if (!probe[0]?.tableexists) {
      await this.sql`
        CREATE TABLE ${this.sql(this.tableRef)}
        (
          id         SERIAL PRIMARY KEY,
          name       TEXT NOT NULL UNIQUE,
          checksum   TEXT,
          created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `
      return
    }
    if (probe[0].checksumexists) return
    await this.sql`
      ALTER TABLE ${this.sql(this.tableRef)} ADD COLUMN IF NOT EXISTS checksum TEXT
    `
  }

  /** Every recorded row, oldest first. Order is not used by the runner; it is stable for readers. */
  async appliedMigrations(): Promise<AppliedMigration[]> {
    const rows = await this.sql<MigrationRow[]>`
      SELECT name, checksum FROM ${this.sql(this.tableRef)} ORDER BY id
    `
    return rows.map((row) => ({ name: row.name, checksum: row.checksum ?? null }))
  }

  /**
   * Apply the body and record it, in one transaction.
   *
   * Two ways of opening that transaction, and the second is a workaround for the driver
   * rather than a preference. On a pooled client it is `sql.begin`, which pins a
   * connection for the callback. On the connection {@link withLock} reserved it has to be
   * the statements themselves: `postgres@3.4.7` puts `begin` on the pool object only
   * (`src/index.js:68-81`), although `ReservedSql` claims to inherit it, so calling it
   * there is a `TypeError`. Sending `BEGIN` by hand is safe in that branch and only in
   * that branch — every statement is going to the one connection the run pinned, which is
   * the thing a pooled client cannot promise.
   */
  async applyInTransaction(migration: Migration): Promise<void> {
    if (!this.pinned) {
      await this.sql.begin(async (transaction) => {
        await transaction.unsafe(migration.sqlText)
        await transaction`
          INSERT INTO ${transaction(this.tableRef)} (name, checksum)
          VALUES (${migration.name}, ${migration.checksum})
        `
      })
      return
    }
    const sql = this.sql
    await sql.unsafe("BEGIN")
    try {
      await sql.unsafe(migration.sqlText)
      await sql`
        INSERT INTO ${sql(this.tableRef)} (name, checksum)
        VALUES (${migration.name}, ${migration.checksum})
      `
      await sql.unsafe("COMMIT")
    } catch (error) {
      try {
        await sql.unsafe("ROLLBACK")
      } catch {
        // The body's error is what the caller can act on, so a rollback that failed on
        // top of it is dropped rather than thrown in its place.
      }
      throw error
    }
  }

  async applyWithoutTransaction(migration: Migration): Promise<void> {
    await this.sql.unsafe(migration.sqlText)
    await this.sql`
      INSERT INTO ${this.sql(this.tableRef)} (name, checksum)
      VALUES (${migration.name}, ${migration.checksum})
    `
  }
}

/**
 * A stable advisory-lock key for a history table.
 *
 * `pg_advisory_lock` takes a 64-bit integer and nothing else, so the table name has to
 * become one. The first eight bytes of its SHA-256, read as a signed 64-bit integer:
 * deterministic across processes and releases, and spread widely enough that two
 * different history tables colliding is not a thing that happens. A collision would cost
 * one runner a wait, never a wrong answer.
 *
 * `qualifiedTable` is always `schema.table` with the schema resolved by the server — see
 * {@link PostgresMigrationDriver.resolvedTableRef} — so two runners that reach one
 * *existing* table lock each other out however each of them spelled it. Before the table
 * exists there is nothing to resolve and the answer is each runner's own
 * `current_schema()`, so every runner of one history table must share a `search_path` or
 * pass the same schema; that limit is stated where the resolution happens.
 */
async function advisoryLockKey(qualifiedTable: string): Promise<bigint> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`ts-libs:migrations:${qualifiedTable}`),
  )
  return BigInt.asIntN(64, new DataView(digest).getBigUint64(0))
}
