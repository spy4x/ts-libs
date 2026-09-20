/**
 * The SQLite adapter.
 *
 * Ported from `warthunder-stats/libs/server/db/+index.ts` and `reset.ts`, with
 * three changes and one omission:
 *
 *  - **the driver is a port.** The source imported `better-sqlite3` at the top of
 *    the module (`:9`), which put a native npm binary in the dependency graph of
 *    everything that touched the file. {@link SqliteDriver} is one interface with
 *    four methods, and {@link openSqliteDb} takes a factory for it, so the caller
 *    picks `node:sqlite`, `better-sqlite3` or a double. This package ships no
 *    driver.
 *  - **every method is async.** The source's driver is synchronous and the one
 *    `migrate.ts` needs is not; one async port serves both rather than a second
 *    runner. The cost is a `Promise.resolve` in a synchronous wrapper.
 *  - **the table name is a parameter.** The source's `runMigrations` hardcoded
 *    `stats_entries` and its legacy-table `INSERT ... SELECT` column list
 *    (`:72-95`), so the schema apply could not be reused by a second table. Here
 *    {@link SqliteSchema} takes the table name and lets a caller supply an upgrade
 *    step.
 *
 * The omission is the source's module-level singleton (`:18-19,41-69`). A package
 * cannot know when a consumer's process is done with the handle, and a module-level
 * `let db` makes a second open silently return the first one. {@link SqliteDb.close}
 * is exported and the caller owns the lifecycle, which is also what lets a test
 * drive the real driver twice in one process.
 */

import { dirname, isAbsolute, join } from "@std/path"
import type { Migration, MigrationDriver } from "./migrate.ts"

/** One prepared statement. `get` is a single row or `undefined`, never a throw. */
export interface SqliteStatement {
  get(...parameters: unknown[]): Promise<unknown>
  all(...parameters: unknown[]): Promise<unknown[]>
  run(...parameters: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>
}

/**
 * The database handle this adapter drives.
 *
 * Four methods, which is the whole surface used. `node:sqlite`'s `DatabaseSync` and
 * `better-sqlite3`'s `Database` each satisfy the shape as they are, so a consumer
 * writes `createDriver: ({ path }) => new DatabaseSync(path)` and nothing else.
 * Values come back as the driver's own — a `bigint` column stays a `bigint` — so no
 * conversion happens that a caller cannot see.
 */
export interface SqliteDriver {
  exec(sql: string): Promise<void>
  prepare(sql: string): Promise<SqliteStatement>
  close(): Promise<void>
}

/** Options accepted by a driver factory. `:memory:` is passed through resolved. */
export interface SqliteOpenOptions {
  /** Resolved path, or `:memory:`. */
  path: string
}

/** Opens a driver. Injected, so this package needs no SQLite driver of its own. */
export type SqliteDriverFactory = (
  options: SqliteOpenOptions,
) => SqliteDriver | Promise<SqliteDriver>

/** Options for {@link openSqliteDb}. */
export interface OpenSqliteDbOptions {
  /** Driver factory. Required: there is no default and no bundled driver. */
  createDriver: SqliteDriverFactory
  /** Explicit path, absolute or relative to {@link root}. */
  path?: string
  /** Environment record, read for {@link SqliteEnvName.Path}. Defaults to an empty record. */
  environment?: Record<string, string | undefined>
  /** Base for a relative {@link path}. Defaults to the current working directory. */
  root?: string
  /**
   * Create the database's parent directory. Defaults to `Deno.mkdirSync`, which
   * needs `--allow-write`; a caller on a test task that grants nothing may inject a
   * no-op or a recording double.
   */
  createDirectory?: (directory: string) => void
  /** Apply to the connection. Defaults to `PRAGMA foreign_keys = ON`. */
  foreignKeys?: boolean
  /** Apply to the connection. Defaults to `PRAGMA journal_mode = WAL`. */
  writeAheadLog?: boolean
}

/** Environment variable names this module reads. */
export enum SqliteEnvName {
  Path = "DB_SQLITE_PATH",
}

/** The SQLite path that names an in-memory database. WAL is unavailable there. */
export const MEMORY_PATH = ":memory:"

/** Default file name, used when no path option and no environment variable are set. */
export const DEFAULT_SQLITE_FILE = "db.sqlite"

/** Default history table name, matching the Postgres adapter's. */
export const DEFAULT_MIGRATIONS_TABLE = "migrations"

/** How a transaction is opened and closed, per driver dialect. */
export interface TransactionStatements {
  begin: string
  commit: string
  rollback: string
}

/** SQLite's own `BEGIN`/`COMMIT`/`ROLLBACK`, which both drivers accept. */
export const DEFAULT_TRANSACTION_STATEMENTS: TransactionStatements = {
  begin: "BEGIN",
  commit: "COMMIT",
  rollback: "ROLLBACK",
}

/**
 * A SQLite connection with the pragmas applied and statements prepared on demand.
 *
 * No statement is cached: both drivers cache prepared statements internally, and a
 * cache here would keep a statement alive past {@link close}.
 */
export class SqliteDb {
  private readonly driver: SqliteDriver
  private readonly path: string
  private readonly transactions: TransactionStatements
  private inTransaction = false
  private closed = false

  constructor(driver: SqliteDriver, path: string, transactions = DEFAULT_TRANSACTION_STATEMENTS) {
    this.driver = driver
    this.path = path
    this.transactions = transactions
  }

  /** The path this connection was opened with, or `:memory:`. */
  get databasePath(): string {
    return this.path
  }

  /** `true` until {@link close} is called. */
  get isOpen(): boolean {
    return !this.closed
  }

  /** Run one or more statements, discarding any result. */
  async exec(sql: string): Promise<void> {
    await this.driver.exec(sql)
  }

  /** Prepare a statement. The caller runs it; nothing is cached. */
  async prepare(sql: string): Promise<SqliteStatement> {
    return await this.driver.prepare(sql)
  }

  /** Read one row, or `undefined`. */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    ...parameters: unknown[]
  ): Promise<T | undefined> {
    const statement = await this.prepare(sql)
    return (await statement.get(...parameters)) as T | undefined
  }

  /** Read every row. */
  async queryAll<T = Record<string, unknown>>(
    sql: string,
    ...parameters: unknown[]
  ): Promise<T[]> {
    const statement = await this.prepare(sql)
    return (await statement.all(...parameters)) as T[]
  }

  /** Run a write, returning the driver's own change count and last row id. */
  async execute(
    sql: string,
    ...parameters: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }> {
    const statement = await this.prepare(sql)
    return await statement.run(...parameters)
  }

  /**
   * The current value of a `PRAGMA`.
   *
   * Read through `prepare().get()`, not `exec()`: `exec` discards the result, so a
   * pragma applied that way cannot be distinguished from one the engine rejected.
   * {@link openSqliteDb} reads its two pragmas back through this method for that
   * reason.
   */
  async pragma(name: string): Promise<unknown> {
    const row = await this.queryOne<unknown>(`PRAGMA ${assertPragmaName(name)}`)
    // Both drivers answer a pragma with a one-column row (`{ journal_mode: "wal" }`), and a
    // double may answer with the bare value. `Object.values` of a number is `[]`, so the
    // scalar case is kept as it is rather than read as "no result".
    if (row === null || row === undefined) return undefined
    if (typeof row !== "object") return row
    return Object.values(row as Record<string, unknown>)[0]
  }

  /** `PRAGMA foreign_keys` — `true` when enforcement is on. */
  async foreignKeysEnabled(): Promise<boolean> {
    return (await this.pragma("foreign_keys")) === 1
  }

  /**
   * Run `fn` inside a transaction, rolling back when it throws.
   *
   * Not re-entrant: neither `node:sqlite` nor `better-sqlite3` nests a transaction
   * through the same handle — a `BEGIN` inside one is the driver's "cannot start a
   * transaction within a transaction" error — so this reports the misuse directly
   * instead of leaving the caller to read a driver message.
   */
  async transaction<T>(fn: (db: SqliteDb) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new Error("sqlite transaction is already open; SQLite does not nest transactions")
    }
    this.inTransaction = true
    await this.exec(this.transactions.begin)
    try {
      const result = await fn(this)
      await this.exec(this.transactions.commit)
      return result
    } catch (error) {
      await this.exec(this.transactions.rollback)
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  /** Close the connection. Idempotent: a second call does nothing. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.driver.close()
  }
}

/**
 * Resolve the database path.
 *
 * An absolute value or `:memory:` is taken as it is; anything else is joined to
 * `root`. This is the source's `resolveDbPath` (`:22-27`) with the project-root
 * guess removed: the source derived a root from its own module position
 * (`new URL("../../../", import.meta.url)`, `:16`), which computes a different
 * directory for every install layout — under a published package it would be a path
 * inside the package cache. `root` is explicit and defaults to the process working
 * directory, and the environment variable stays as the override.
 */
export function resolveSqlitePath(
  options: {
    path?: string
    environment?: Record<string, string | undefined>
    root?: string
  } = {},
): string {
  const configured = options.path ?? options.environment?.[SqliteEnvName.Path]
  const root = options.root ?? Deno.cwd()
  if (configured === undefined || configured === "") {
    return join(root, DEFAULT_SQLITE_FILE)
  }
  if (configured === MEMORY_PATH || isAbsolute(configured)) {
    return configured
  }
  return join(root, configured)
}

/**
 * Open a connection, create its directory, and apply the two pragmas.
 *
 * Both pragmas are read back, and the open fails when either did not take. That is
 * not ceremony: `journal_mode` stays `memory` for an in-memory database, and a
 * foreign key that is not enforced is a constraint the schema claims and the runtime
 * ignores.
 *
 * A failed open closes the driver before rethrowing, so a driver that published a
 * half-open handle cannot be leaked — the source did the same (`:61-68`).
 */
export async function openSqliteDb(options: OpenSqliteDbOptions): Promise<SqliteDb> {
  const path = resolveSqlitePath(options)
  ensureDirectory(path, options.createDirectory ?? defaultCreateDirectory)
  const driver = await options.createDriver({ path })
  try {
    const db = new SqliteDb(driver, path)
    if (options.foreignKeys ?? true) {
      await db.exec("PRAGMA foreign_keys = ON")
      if (!(await db.foreignKeysEnabled())) {
        throw new Error("SQLite did not enable foreign key enforcement")
      }
    }
    if (options.writeAheadLog ?? true) {
      await db.exec("PRAGMA journal_mode = WAL")
      const journalMode = await db.pragma("journal_mode")
      if (journalMode !== "wal" && journalMode !== "memory") {
        throw new Error(`SQLite did not enable WAL, journal_mode is ${String(journalMode)}`)
      }
    }
    return db
  } catch (error) {
    try {
      await driver.close()
    } catch {
      // Preserve the initialization error; the driver is never returned.
    }
    throw error
  }
}

/** One schema, applied either once or through a caller-supplied upgrade. */
export interface SqliteSchema {
  /** Table the schema owns. Used to detect a legacy table and to name it in errors. */
  table: string
  /**
   * Schema SQL. Must be idempotent on its own terms — `CREATE TABLE IF NOT EXISTS`
   * and the like.
   */
  sql: string
  /**
   * Upgrade a table that exists but is not the one {@link sql} declares. The
   * source's `stats_entries` STRICT migration (`:74-93`) is the shape. Omitted, the
   * schema SQL runs and any incompatibility is the engine's error.
   */
  upgrade?: (db: SqliteDb) => Promise<void>
}

/**
 * Apply `schema` idempotently.
 *
 * Running it twice is safe, and that is the property the source's own comment
 * claimed while checking only a `strict` flag: a second apply throws on the first
 * statement unless the statements are themselves idempotent, so `IF NOT EXISTS` and
 * the engine's consistency check are what make a re-apply a no-op.
 *
 * The legacy check is `pragma_table_list`, as in the source: a table that exists and
 * is not `STRICT` is the pre-STRICT shape, so an upgrade step is needed. A table
 * whose name is absent runs the schema SQL directly.
 */
export async function applySqliteSchema(db: SqliteDb, schema: SqliteSchema): Promise<void> {
  const existing = await db.queryOne<{ strict: number }>(
    "SELECT strict FROM pragma_table_list WHERE name = ?",
    schema.table,
  )
  if (existing === undefined || existing.strict === 1 || schema.upgrade === undefined) {
    await db.exec(schema.sql)
    return
  }
  await db.transaction(async (transaction) => {
    await schema.upgrade?.(transaction)
    await transaction.exec(schema.sql)
    await assertTableExists(transaction, schema.table)
  })
}
/**
 * Delete a database file and its `-wal`/`-shm` sidecars.
 *
 * Ported from `warthunder-stats/libs/server/db/reset.ts:6-13`. A missing file is not
 * an error; every other remove failure propagates, so a permission problem is never
 * reported as "already clean". Sidecars are a consequence of WAL: a leftover `-wal`
 * beside a fresh database is a set of unapplied frames, which is why a reset removes
 * all three rather than the main file alone.
 */
export async function removeSqliteFiles(
  path: string,
  remove: (file: string) => Promise<void> = defaultRemove,
): Promise<string[]> {
  if (path === MEMORY_PATH) return []
  const removed: string[] = []
  for (const suffix of ["", "-shm", "-wal"]) {
    const file = `${path}${suffix}`
    try {
      await remove(file)
      removed.push(file)
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
  }
  return removed
}

/**
 * The SQLite half of the migration runner.
 *
 * Records names without the `.sql` extension and without the `.no_transaction`
 * suffix — the same name `PostgresMigrationDriver` records, so one history table can
 * be read by both. A no-transaction migration is applied as a bare statement plus
 * its history insert: SQLite has no `CREATE INDEX CONCURRENTLY`, and the suffix
 * exists so a caller with a statement that refuses a transaction — an `ATTACH`, a
 * `VACUUM` — has a way to say so.
 */
export class SqliteMigrationDriver implements MigrationDriver {
  private readonly db: SqliteDb
  private readonly table: string

  constructor(options: { db: SqliteDb; table?: string }) {
    this.db = options.db
    this.table = options.table ?? DEFAULT_MIGRATIONS_TABLE
  }

  /** Idempotent: a second call leaves the table and its rows untouched. */
  async createHistoryTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table}
      (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
  }

  /** Every recorded name, oldest first. */
  async appliedNames(): Promise<string[]> {
    const rows = await this.db.queryAll<{ name: string }>(
      `SELECT name FROM ${this.table} ORDER BY id`,
    )
    return rows.map((row) => row.name)
  }

  async applyInTransaction(migration: Migration): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.exec(migration.sqlText)
      await transaction.execute(`INSERT INTO ${this.table} (name) VALUES (?)`, migration.name)
    })
  }

  async applyWithoutTransaction(migration: Migration): Promise<void> {
    await this.db.exec(migration.sqlText)
    await this.db.execute(`INSERT INTO ${this.table} (name) VALUES (?)`, migration.name)
  }
}

/** Reject a pragma name that is not a bare identifier before it is interpolated. */
function assertPragmaName(name: string): string {
  if (!/^[a-z_]+$/i.test(name)) {
    throw new RangeError(`pragma name must be a bare identifier, got ${JSON.stringify(name)}`)
  }
  return name
}

/** Assert a table by name exists, so an upgrade step that dropped it fails loudly. */
async function assertTableExists(db: SqliteDb, table: string): Promise<void> {
  const row = await db.queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    table,
  )
  if (row === undefined) {
    throw new Error(`schema apply left no table named ${table}`)
  }
}

function defaultCreateDirectory(directory: string): void {
  Deno.mkdirSync(directory, { recursive: true })
}

async function defaultRemove(file: string): Promise<void> {
  await Deno.remove(file)
}

/**
 * Create the database's parent directory.
 *
 * `Deno.mkdirSync` with `recursive: true` does not throw on an existing directory, so
 * the `AlreadyExists` branch is the belt to that braces: a caller-injected
 * implementation may be a plain `mkdir`. `:memory:` has no directory.
 */
function ensureDirectory(path: string, createDirectory: (directory: string) => void): void {
  if (path === MEMORY_PATH) return
  const directory = dirname(path)
  if (directory === "" || directory === ".") return
  try {
    createDirectory(directory)
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error
  }
}
