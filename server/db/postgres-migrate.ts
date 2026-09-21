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

/** Options for {@link PostgresMigrationDriver}. */
export interface PostgresMigrationDriverOptions {
  /** Client to run through. */
  sql: Sql
  /** History table name. Defaults to `migrations`. */
  table?: string
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

/** What `createHistoryTable`'s one probe answers: is the table there, is it up to date. */
interface HistoryProbe {
  table_exists: boolean
  checksum_exists: boolean
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
 * *same instance* while the first is still going would share that connection. Two
 * concurrent runs are two instances, which is also what two application instances are.
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
  private readonly table: string
  private readonly schema: string | undefined
  /** `"migrations"` or `"public.migrations"`, as the driver's identifier helper takes it. */
  private readonly tableRef: string

  constructor(options: PostgresMigrationDriverOptions) {
    this.sql = options.sql
    this.table = options.table ?? DEFAULT_MIGRATIONS_TABLE
    this.schema = options.schema
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
   * driver that reaches `app.migrations` through its search path take the same key and
   * lock each other out. Deriving it from the spelling alone did not — the two ran at the
   * same time and one of them crashed inside Postgres's own catalogue.
   *
   * `pg_advisory_lock` waits rather than failing: a second runner starting during a
   * migration should apply nothing and carry on, not crash the instance. A runner that
   * dies holding the lock releases it when its connection closes, so there is no stale
   * lock to clear by hand. It has no bound, which #109 records.
   */
  async withLock<T>(run: () => Promise<T>): Promise<T> {
    const reserved = await this.sql.reserve()
    const pooled = this.sql
    this.sql = reserved as unknown as Sql
    this.pinned = true
    try {
      // On the reserved connection, because the answer depends on that session's
      // `search_path` and the run is about to use that same session.
      const key = await advisoryLockKey(await this.resolvedTableRef(reserved as unknown as Sql))
      await reserved`SELECT pg_advisory_lock(${key})`
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
   * `schema.table` for the table this driver will actually read and write.
   *
   * A named schema is the answer already. Without one, the server is asked: `to_regclass`
   * resolves the bare name through this session's `search_path` and gives the schema it
   * found it in, and when the table does not exist yet `current_schema()` is where
   * `CREATE TABLE` will put it. Both are the schema this run ends up working in, which is
   * what the lock key has to follow.
   */
  private async resolvedTableRef(sql: Sql): Promise<string> {
    if (this.schema !== undefined) return `${this.schema}.${this.table}`
    const rows = await sql<{ schema: string | null }[]>`
      SELECT coalesce(
        (
          SELECT n.nspname
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.oid = to_regclass(${this.table})
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
          ) AS table_exists,
          exists (
            SELECT FROM information_schema.columns
            WHERE table_name = ${this.table} AND column_name = 'checksum'
            AND table_schema = ANY (current_schemas(false))
          ) AS checksum_exists
      `
      : await this.sql<HistoryProbe[]>`
        SELECT
          exists (
            SELECT FROM information_schema.tables
            WHERE table_name = ${this.table} AND table_schema = ${this.schema}
          ) AS table_exists,
          exists (
            SELECT FROM information_schema.columns
            WHERE table_name = ${this.table} AND column_name = 'checksum'
            AND table_schema = ${this.schema}
          ) AS checksum_exists
      `
    if (!probe[0]?.table_exists) {
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
    if (probe[0].checksum_exists) return
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
 * {@link PostgresMigrationDriver.withLock} — so two runners that reach one table lock
 * each other out however each of them spelled it.
 */
async function advisoryLockKey(qualifiedTable: string): Promise<bigint> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`ts-libs:migrations:${qualifiedTable}`),
  )
  return BigInt.asIntN(64, new DataView(digest).getBigUint64(0))
}
