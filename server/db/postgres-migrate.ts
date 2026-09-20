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
 * Two schema decisions, both deliberate:
 *
 *  - `name` is `UNIQUE`. The template's `CREATE TABLE migrations`
 *    (`:24-30`) was not, and neither was the `migrations` table in template's
 *    `schema.sql:10-14`. Two runners starting together would therefore both see an
 *    empty history, both apply the same file, and record it twice with no error.
 *    With the constraint the second insert fails and the second runner's
 *    transaction rolls back — a loud failure instead of a doubled migration. It is
 *    additive against an existing table only if that table has no duplicate names,
 *    which is exactly the state this constraint is meant to prevent.
 *  - `applied_at` is not stored separately. `created_at` in the template's shape
 *    already records when the row was inserted, and that insert is the last
 *    statement of the migration's transaction, so it is the application time.
 */

import { type Migration, type MigrationDriver } from "./migrate.ts"
import type { Sql } from "./ports.ts"

/** The default history table name, matching the template's `migrations` table. */
export const DEFAULT_MIGRATIONS_TABLE = "migrations"

/** Options for {@link PostgresMigrationDriver}. */
export interface PostgresMigrationDriverOptions {
  /** Client to run through. */
  sql: Sql
  /** History table name. Defaults to `migrations`. */
  table?: string
}

/** A row of the history table, read for its name alone. */
interface MigrationRow {
  name: string
}

/**
 * Applies migrations to Postgres, one transaction per migration.
 *
 * `applyWithoutTransaction` exists because a `CREATE INDEX CONCURRENTLY` cannot
 * run inside a transaction block; it runs the script and records it as two
 * statements, which is why a failing no-transaction migration can be recorded as
 * applied without having finished. Suffix the file `.no_transaction.sql` only when
 * the statement genuinely requires it.
 */
export class PostgresMigrationDriver implements MigrationDriver {
  private readonly sql: Sql
  private readonly table: string

  constructor(options: PostgresMigrationDriverOptions) {
    this.sql = options.sql
    this.table = options.table ?? DEFAULT_MIGRATIONS_TABLE
  }

  /** Create the history table when absent, leaving an existing one untouched. */
  async createHistoryTable(): Promise<void> {
    const existing = await this.sql<{ exists: boolean }[]>`
      SELECT exists (
        SELECT FROM information_schema.tables WHERE table_name = ${this.table}
      ) AS exists
    `
    if (existing[0]?.exists) return
    await this.sql`
      CREATE TABLE ${this.sql(this.table)}
      (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(100) NOT NULL UNIQUE,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `
  }

  /** Every recorded name, oldest first. Order is not used by the runner; it is stable for readers. */
  async appliedNames(): Promise<string[]> {
    const rows = await this.sql<MigrationRow[]>`
      SELECT name FROM ${this.sql(this.table)} ORDER BY id
    `
    return rows.map((row) => row.name)
  }

  async applyInTransaction(migration: Migration): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction.unsafe(migration.sqlText)
      await transaction`INSERT INTO ${transaction(this.table)} (name) VALUES (${migration.name})`
    })
  }

  async applyWithoutTransaction(migration: Migration): Promise<void> {
    await this.sql.unsafe(migration.sqlText)
    await this.sql`INSERT INTO ${this.sql(this.table)} (name) VALUES (${migration.name})`
  }
}
