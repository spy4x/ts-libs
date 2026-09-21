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
import type { AppliedMigration, Migration, MigrationDriver } from "./migrate.ts"

/** What a write reports back: the driver's own counts, unconverted. */
export interface SqliteRunResult {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

/**
 * One prepared statement. `get` is a single row or `undefined`, never a throw.
 *
 * Every method may answer with a value or with a promise of one, because the drivers
 * people actually pass are synchronous: `node:sqlite`'s `StatementSync.get` returns
 * the row itself. The adapter awaits each result, and awaiting a plain value is a
 * no-op, so one port serves a synchronous and an asynchronous driver.
 */
export interface SqliteStatement {
  get(...parameters: unknown[]): unknown
  all(...parameters: unknown[]): unknown[] | Promise<unknown[]>
  run(...parameters: unknown[]): SqliteRunResult | Promise<SqliteRunResult>
}

/**
 * The database handle this adapter drives.
 *
 * Three methods, which is the whole surface used. `node:sqlite`'s `DatabaseSync`
 * satisfies the shape as it is, so a consumer writes
 * `createDriver: ({ path }) => new DatabaseSync(path)` and nothing else. Values come
 * back as the driver's own — a `bigint` column stays a `bigint` — so no conversion
 * happens that a caller cannot see.
 *
 * **Only `node:sqlite` is tested.** `server/db/testing/node-sqlite-driver.ts` is the
 * one driver this repository exercises against a real engine. `better-sqlite3` fits
 * the same port and is the driver one source application uses, but no test here
 * loads it: adding it would put a native npm binary in `deno.lock`. What is checked
 * is the shape — `sqlite.test.ts` declares a class with `better-sqlite3`'s
 * signatures, including an `exec` that returns `this`, and assigns it to
 * {@link SqliteDriverFactory}. That is a compile-time claim about the types, not a
 * claim that the driver works.
 *
 * `exec` and `close` are typed `unknown` rather than `void | Promise<void>` for that
 * shape check: `better-sqlite3`'s `exec` returns the database for chaining, and
 * `void` rejects it.
 */
export interface SqliteDriver {
  exec(sql: string): unknown
  prepare(sql: string): SqliteStatement | Promise<SqliteStatement>
  close(): unknown
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
  /**
   * Milliseconds a statement on the returned handle waits for an open transaction.
   * Defaults to {@link DEFAULT_TRANSACTION_WAIT_MS}. See {@link SqliteDbOptions}.
   */
  transactionWaitMs?: number
  /** Delay used while waiting. Defaults to `setTimeout`. See {@link SqliteDelay}. */
  delay?: SqliteDelay
}

/**
 * Extra options for {@link SqliteDb}, all of them about the transaction gate.
 *
 * One SQLite connection runs one transaction at a time, so while a transaction is
 * open every statement issued on the root handle waits for it. The wait is bounded
 * because one waiter can never be served: a callback that reaches for the root handle
 * instead of the handle it was given is waiting for its own transaction to finish. The
 * adapter cannot tell that caller apart from a second, genuine caller — there is no
 * `AsyncLocalStorage` here, because a literal `node:` import breaks this repository's
 * type check — so it lets both wait and gives up after {@link transactionWaitMs} with
 * {@link SqliteTransactionWaitError}.
 */
export interface SqliteDbOptions {
  /** Milliseconds to wait. Defaults to {@link DEFAULT_TRANSACTION_WAIT_MS}. */
  transactionWaitMs?: number
  /** Delay used while waiting. Defaults to `setTimeout`, injected so a test never sleeps. */
  delay?: SqliteDelay
}

/**
 * A cancellable delay.
 *
 * Injected rather than called directly so a test can expire the wait in the same tick
 * instead of sleeping for seconds. `cancel` must stop the underlying timer, so a
 * caller that got through immediately leaves nothing pending behind it.
 */
export type SqliteDelay = (milliseconds: number) => {
  expired: Promise<void>
  cancel: () => void
}

/**
 * How long a statement waits for an open transaction before it gives up.
 *
 * Five seconds: long enough that an honest transaction doing real work is not cut off,
 * short enough that a caller waiting for itself is reported rather than hung. A
 * deployment whose transactions legitimately run longer raises
 * {@link SqliteDbOptions.transactionWaitMs}; failing loudly is the trade this number
 * makes, against the silent corruption that having no bound at all replaced.
 */
export const DEFAULT_TRANSACTION_WAIT_MS = 5_000

/**
 * Thrown when a handle is used after the transaction it belongs to has ended.
 *
 * The handle a transaction callback is given is scoped to that transaction: it is the
 * one way past the gate, and it stops working the moment the transaction commits or
 * rolls back. A service that stores it — `this.db = db` inside the callback — would
 * otherwise keep a permanent door around the gate, and a write through that door lands
 * in whatever transaction is open when it runs and disappears with that transaction's
 * rollback. It reports one change on the way out, which is what makes the loss silent.
 */
export class SqliteScopeEndedError extends Error {
  constructor() {
    super(
      `this sqlite handle belonged to a transaction that has already committed or ` +
        `rolled back; a statement after the transaction goes through the connection ` +
        `the transaction was opened on, not through the handle the callback was given`,
    )
    this.name = "SqliteScopeEndedError"
  }
}

/**
 * Thrown when a statement waited out {@link SqliteDbOptions.transactionWaitMs}.
 *
 * Two causes, and the message names both. Either an open transaction is genuinely
 * slower than the bound, in which case the bound is the thing to raise; or code inside a
 * transaction callback issued a statement on the root handle rather than on the handle
 * the callback was given, in which case it was waiting for a transaction that cannot
 * finish until it returns. The adapter cannot tell the two apart, which is why the error
 * describes both rather than naming one.
 */
export class SqliteTransactionWaitError extends Error {
  constructor(milliseconds: number) {
    super(
      `sqlite connection is held by an open transaction and did not become free within ` +
        `${milliseconds}ms; either that transaction is slower than the bound, or this ` +
        `statement was issued inside a transaction callback on the connection the ` +
        `transaction was opened on rather than on the handle the callback was given, ` +
        `in which case it was waiting for itself`,
    )
    this.name = "SqliteTransactionWaitError"
  }
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

/**
 * The identifiers this module admits, as one shape.
 *
 * A leading letter or underscore, then letters, digits or underscores. Dashes and
 * spaces are excluded deliberately, so `my-migrations` and `my migrations` fail where
 * the caller wrote them instead of at the first statement that mentions them. Digits
 * are admitted because the migration table is parameterised precisely so a consumer
 * can use `migrations_v2`.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Reject a caller-supplied identifier before it is interpolated into SQL text.
 *
 * Every identifier this module splices — a migration table, a schema's table — and a
 * pragma name go through this one function, so the allowlist is one shape rather than
 * one per call site. It is not the whole barrier: {@link quoteIdentifier} runs after
 * it. It is however the barrier that runs at construction, so an unquotable value
 * fails where it is passed rather than at whatever statement first uses it.
 */
function assertIdentifier(name: string, option: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new RangeError(`${option} must be a bare identifier, got ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * Render an identifier as a quoted SQL identifier, internal `"` doubled.
 *
 * The SQLite counterpart of what `postgres-migrate.ts` gets from `sql(this.table)`
 * (`:72,84,92,98`) — postgres.js's own `escapeIdentifier` is
 * `'"' + str.replace(/"/g, '""') + '"'`. No escape survives {@link assertIdentifier},
 * so the doubling is unreachable through this module; it is here so that the quoting
 * is correct on its own terms rather than only because validation ran first.
 */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

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
 * The one-writer gate a root {@link SqliteDb} holds.
 *
 * A SQLite connection runs one transaction at a time. While a transaction is open the
 * gate is held, and every statement that goes through the connection it was opened on
 * waits for it to be given back. The scoped handle the callback receives has no gate,
 * which is how its own statements get through.
 */
class TransactionGate {
  private holder: Promise<void> | null = null

  /** `undefined` when the connection is free, otherwise a promise that settles when it is. */
  held(): Promise<void> | undefined {
    return this.holder ?? undefined
  }

  /** Take the connection. The returned function gives it back and never throws. */
  claim(): () => void {
    let release = (): void => {}
    const holder = new Promise<void>((resolve) => {
      release = () => {
        if (this.holder === holder) this.holder = null
        resolve()
      }
    })
    this.holder = holder
    return release
  }
}

/** Outcomes of the race in {@link awaitGate}, kept distinguishable from any row value. */
const GATE_FREE = Symbol("sqlite gate free")
const GATE_EXPIRED = Symbol("sqlite gate expired")

/** The default delay: `setTimeout`, cancellable so a finished wait keeps nothing pending. */
const defaultDelay: SqliteDelay = (milliseconds) => {
  let handle: number | undefined
  const expired = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, milliseconds)
  })
  return {
    expired,
    cancel: () => {
      if (handle !== undefined) clearTimeout(handle)
    },
  }
}

/**
 * Wait until `gate` is free, or throw {@link SqliteTransactionWaitError}.
 *
 * The loop matters: several statements may be waiting on the same transaction, and the
 * one that wakes first may not be the one that claims the connection, so a waiter
 * re-checks rather than assuming the gate it was woken for is still open. The delay is
 * started once and cancelled in a `finally`, so the bound covers the whole wait and
 * nothing is left pending when the wait ends early.
 */
async function awaitGate(
  gate: TransactionGate,
  milliseconds: number,
  delay: SqliteDelay,
): Promise<void> {
  const timer = delay(milliseconds)
  const expired = timer.expired.then(() => GATE_EXPIRED)
  try {
    while (true) {
      const held = gate.held()
      if (held === undefined) return
      const outcome = await Promise.race([held.then(() => GATE_FREE), expired])
      if (outcome === GATE_EXPIRED) throw new SqliteTransactionWaitError(milliseconds)
    }
  } finally {
    timer.cancel()
  }
}

/**
 * A SQLite connection with the pragmas applied and statements prepared on demand.
 *
 * No statement is cached: both drivers cache prepared statements internally, and a
 * cache here would keep a statement alive past {@link close}.
 *
 * **One caller at a time while a transaction is open.** {@link transaction} hands its
 * callback a scoped handle over the same driver and holds the connection until the
 * callback has committed or rolled back. Everything issued on the handle the
 * connection was opened on — including a statement prepared before the transaction
 * started — waits for that, so a second caller's write can no longer land inside
 * somebody else's transaction and disappear with its rollback. The wait is bounded;
 * see {@link SqliteDbOptions}.
 */
export class SqliteDb {
  private readonly driver: SqliteDriver
  private readonly path: string
  private readonly transactions: TransactionStatements
  private readonly waitMilliseconds: number
  private readonly delay: SqliteDelay
  /** The gate, or `null` on the scoped handle a transaction callback is given. */
  private gate: TransactionGate | null = new TransactionGate()
  /**
   * `true` once the transaction this handle was scoped to has ended.
   *
   * Only ever set on a scoped handle. It is what stops a callback that kept its handle
   * from writing through it afterwards, which would go around the gate and land inside
   * whatever transaction happened to be open at the time.
   */
  private ended = false
  private closed = false
  /** The close in flight, so two callers racing share one, or `null` when none is. */
  private closing: Promise<void> | null = null

  constructor(
    driver: SqliteDriver,
    path: string,
    transactions = DEFAULT_TRANSACTION_STATEMENTS,
    options: SqliteDbOptions = {},
  ) {
    this.driver = driver
    this.path = path
    this.transactions = transactions
    this.waitMilliseconds = options.transactionWaitMs ?? DEFAULT_TRANSACTION_WAIT_MS
    this.delay = options.delay ?? defaultDelay
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
    await this.guard(() => this.driver.exec(sql))
  }

  /**
   * Prepare a statement. The caller runs it; nothing is cached.
   *
   * The returned statement carries this handle's gate, not the gate the connection had
   * when it was prepared. That is the point: a statement prepared before a transaction
   * opened would otherwise be a way to reach the connection around the gate and write
   * inside somebody else's transaction.
   */
  async prepare(sql: string): Promise<SqliteStatement> {
    const statement = await this.guard(() => this.driver.prepare(sql))
    return this.guardStatement(statement)
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
  async execute(sql: string, ...parameters: unknown[]): Promise<SqliteRunResult> {
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
    const row = await this.queryOne<unknown>(`PRAGMA ${assertIdentifier(name, "pragma name")}`)
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
   * `fn` is given a **scoped handle** over the same driver, and that handle is the only
   * way into the connection until the transaction ends. Two callers may therefore call
   * this method at the same time: the second waits for the first and then runs its own
   * transaction, rather than writing into the first one and losing the write to its
   * rollback.
   *
   * Three rules fall out of that, and each one is a case a caller can hit:
   *
   *  - calling this method again **on the scoped handle** throws at once. SQLite does
   *    not nest transactions on one connection, and a savepoint is a different feature
   *    with different rollback semantics, so the misuse is reported rather than guessed
   *    at;
   *  - a statement issued **on the root handle** from inside the callback waits, and
   *    then fails with {@link SqliteTransactionWaitError}. It is waiting for its own
   *    transaction, which cannot finish until the callback returns. The adapter cannot
   *    tell that caller from a second, genuine one, so it bounds the wait instead of
   *    hanging for ever;
   *  - a failed `BEGIN` gives the connection straight back, so one bad statement does
   *    not leave the handle refusing every later transaction;
   *  - the scoped handle **stops working** when the transaction ends, with
   *    {@link SqliteScopeEndedError}. A callback that stored it would otherwise keep a
   *    permanent way past the gate, and a write through it later lands in whatever
   *    transaction is open at the time and disappears with that one's rollback.
   */
  async transaction<T>(fn: (db: SqliteDb) => Promise<T>): Promise<T> {
    this.assertUsable()
    const gate = this.gate
    if (gate === null) {
      throw new Error("sqlite transaction is already open; SQLite does not nest transactions")
    }
    while (gate.held() !== undefined) {
      await awaitGate(gate, this.waitMilliseconds, this.delay)
    }
    const release = gate.claim()
    const scoped = this.createScopedHandle()
    try {
      // The gate is claimed before `BEGIN` rather than after it, so two callers cannot
      // both send a `BEGIN`. It is given straight back when `BEGIN` fails, which is the
      // behaviour a flag set before the statement used to get wrong: one syntax error
      // left the connection refusing every later transaction.
      await scoped.exec(this.transactions.begin)
    } catch (error) {
      scoped.ended = true
      release()
      throw error
    }
    try {
      const result = await fn(scoped)
      await scoped.exec(this.transactions.commit)
      return result
    } catch (error) {
      try {
        await scoped.exec(this.transactions.rollback)
      } catch {
        // The callback's error is what the caller can act on, so a rollback that failed
        // on top of it is dropped rather than thrown in its place.
      }
      throw error
    } finally {
      // The handle stops working here, and not only when the callback returns normally:
      // a callback that stored it has no way to tell the difference, and the write it
      // would make through a kept handle is lost either way.
      scoped.ended = true
      release()
    }
  }

  /**
   * Close the connection. Idempotent: a second call does nothing, and a second call made
   * *while the first is still in flight* waits for it and returns with it.
   *
   * It goes through the gate like every other operation, so a `close` issued while
   * another caller's transaction is open waits for that transaction instead of pulling
   * the connection out from under it — the transaction used to reject with "database is
   * not open" at its next statement. A `close` called from *inside* a transaction
   * callback is waiting for itself, so it fails after the bounded wait with
   * {@link SqliteTransactionWaitError}, as any other statement on the root handle does.
   *
   * That wait is why the in-flight close is remembered rather than only the finished one:
   * a shutdown handler that fires twice, or two callers racing, would otherwise both pass
   * the `closed` check while the first was still waiting on the gate, and the second
   * would reach a driver the first had already closed.
   *
   * A scoped handle cannot close anything. It never owned the connection: it is a second
   * front door onto the connection the root handle opened, handed out for the length of
   * one transaction.
   *
   * @throws {Error} on a scoped handle.
   * @throws {SqliteTransactionWaitError} when an open transaction outlasts the bound.
   */
  async close(): Promise<void> {
    if (this.gate === null) {
      throw new Error(
        `this sqlite handle is scoped to a transaction and does not own the connection, ` +
          `so it cannot close it; close the handle the connection was opened on`,
      )
    }
    if (this.closed) return
    this.closing ??= this.closeOnce()
    await this.closing
  }

  /**
   * The one close every concurrent caller of {@link close} shares.
   *
   * The `finally` drops the attempt either way, which is what keeps a refused close
   * retryable: `closed` is set only when the driver agreed, so a close the gate turned
   * down leaves the handle reporting the connection it still has, and the next call
   * starts a fresh attempt rather than replaying the refusal for ever.
   */
  private async closeOnce(): Promise<void> {
    try {
      await this.guard(() => this.driver.close())
      this.closed = true
    } finally {
      this.closing = null
    }
  }

  /**
   * A handle over the same driver with no gate, for one transaction callback.
   *
   * Not a clone of the connection: there is one driver and one SQLite connection. It is
   * a second front door that the gate does not cover.
   */
  private createScopedHandle(): SqliteDb {
    const scoped = new SqliteDb(this.driver, this.path, this.transactions, {
      transactionWaitMs: this.waitMilliseconds,
      delay: this.delay,
    })
    scoped.gate = null
    return scoped
  }

  /**
   * Refuse a handle whose transaction has ended.
   *
   * @throws {SqliteScopeEndedError} on a scoped handle used after its transaction
   * committed or rolled back.
   */
  private assertUsable(): void {
    if (this.ended) throw new SqliteScopeEndedError()
  }

  /** Refuse an ended handle, wait for an open transaction, and then run `operation`. */
  private async guard<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertUsable()
    const gate = this.gate
    if (gate !== null) {
      while (gate.held() !== undefined) {
        await awaitGate(gate, this.waitMilliseconds, this.delay)
      }
    }
    return await operation()
  }

  /**
   * Put this handle's own checks in front of a prepared statement's three run methods.
   *
   * Both kinds of handle wrap. On the root handle the wrapper is the gate; on a scoped
   * handle it is the end-of-transaction check, because a statement prepared inside the
   * callback is as good a way around the gate afterwards as the handle itself.
   */
  private guardStatement(statement: SqliteStatement): SqliteStatement {
    return {
      get: (...parameters: unknown[]) => this.guard(() => statement.get(...parameters)),
      all: (...parameters: unknown[]) => this.guard(() => statement.all(...parameters)),
      run: (...parameters: unknown[]) => this.guard(() => statement.run(...parameters)),
    }
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
    const db = new SqliteDb(driver, path, DEFAULT_TRANSACTION_STATEMENTS, {
      transactionWaitMs: options.transactionWaitMs,
      delay: options.delay,
    })
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
  /**
   * Table the schema owns. Used to detect a legacy table and to name it in errors.
   *
   * A bare identifier, validated when the schema is applied — the same shape
   * {@link SqliteMigrationDriver}'s `table` takes. The schema's own SQL is not this:
   * `sql` and `upgrade` are caller-supplied SQL *text* by design, and neither is
   * escaped or inspected.
   */
  table: string
  /**
   * Schema SQL. Must be idempotent on its own terms — `CREATE TABLE IF NOT EXISTS`
   * and the like.
   *
   * Raw SQL text, run as written: this is the option's whole contract. Nothing here
   * validates or quotes it, so the caller owns every identifier inside it.
   */
  sql: string
  /**
   * Upgrade a table that exists but is not the one {@link sql} declares. The
   * source's `stats_entries` STRICT migration (`:74-93`) is the shape. Omitted, the
   * schema SQL runs and any incompatibility is the engine's error.
   *
   * Raw SQL text like {@link sql}, and for the same reason.
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
  // The schema's table is interpolated nowhere here — the existence check is a bound
  // parameter and `sqlite_master` is a fixed name — but it is validated because
  // `SqliteSchema.table` is a caller-supplied identifier and this module admits one
  // shape of those, not two.
  assertIdentifier(schema.table, "schema table")
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
 *
 * `table` is a caller-supplied identifier and is the one value here that is spliced
 * into SQL text rather than bound as a parameter. It is validated against an
 * identifier allowlist **and** quoted; see {@link assertIdentifier}. Migration names
 * are bound, and the schema's `sql`/`upgrade` are the caller's own SQL text.
 *
 * **{@link withLock} covers the runners that share one {@link SqliteDb}, and nothing
 * wider.** The queue is held per handle, so two runners given the same handle — the case
 * that was measured, where both read an empty history before either wrote to it and every
 * migration was applied twice — are serialised. Two handles opened on the same file are
 * not: measured, that pair still ran a `.no_transaction` body twice, whether the two
 * handles are in one process or in two.
 *
 * That is the honest limit of what SQLite offers here. It has no advisory locks, and its
 * own locks last no longer than the transaction that took them, while a migration run is
 * a transaction per migration plus the bare statements a `.no_transaction` migration
 * needs. What SQLite's single-writer lock does still give, between any two handles, is
 * that a *transactional* migration cannot be applied twice: the loser's write fails and
 * its whole transaction — the migration and its history row together — rolls back. A
 * `.no_transaction` migration has no such protection, because its body and its history
 * row are separate statements.
 *
 * Closing that needs a lock SQLite does not have. A lock table would trade it for a stale
 * lock after a crash; an operating-system file lock on a sibling file
 * (`<database>.migrate.lock`, `Deno.FsFile.lock()`) would not, because the kernel releases
 * it when the process dies.
 *
 * **That file lock is deliberately not built** (#110). It needs write permission next to
 * the database, it does not apply to `:memory:`, and no project this library serves runs
 * two processes against one SQLite file — a SQLite deployment here is one process with
 * Litestream behind it. Building it now would add a permission requirement and a second
 * lock mechanism for a case nobody has. Until a project does have it, the rule is: one
 * handle per database in a process, and one process running migrations at a time.
 */
export class SqliteMigrationDriver implements MigrationDriver {
  private readonly db: SqliteDb
  /** The validated name, quoted, as every statement splices it. */
  private readonly table: string
  /** The same name unquoted, for the one place it is *bound* rather than spliced. */
  private readonly unquotedTable: string

  /**
   * @throws {RangeError} when `table` is not a bare identifier. Validated here, in
   * the constructor, and not at first use: `options.table` reaches `exec`, whose
   * multi-statement behaviour turns a table name into arbitrary SQL, so a bad value
   * must fail while the caller still has the call on the stack. Measured on
   * `83f3be3`, `table: "migrations (name TEXT); DROP TABLE victims; --"` executed the
   * `DROP` *and* then threw, leaving the caller an exception and no signal that
   * tables had been dropped.
   */
  constructor(options: { db: SqliteDb; table?: string }) {
    this.db = options.db
    // Validated and then quoted. Validation is the barrier that runs before any SQL
    // exists; quoting is what makes the splice safe on its own terms, the way
    // `postgres-migrate.ts` gets it from `sql(this.table)`.
    this.unquotedTable = assertIdentifier(
      options.table ?? DEFAULT_MIGRATIONS_TABLE,
      "table name",
    )
    this.table = quoteIdentifier(this.unquotedTable)
  }

  /**
   * Run `run` with no other runner **on this same handle** working on the same history
   * table.
   *
   * A queue keyed by handle and table name, not a database lock: see the class
   * documentation for what SQLite does and does not offer, and for what two handles on
   * one file are still exposed to. A runner that dies mid-run releases its place through
   * the `finally`, so nothing has to be cleared by hand.
   */
  async withLock<T>(run: () => Promise<T>): Promise<T> {
    const byTable = migrationQueues.get(this.db) ?? new Map<string, Promise<void>>()
    migrationQueues.set(this.db, byTable)
    const ahead = byTable.get(this.table) ?? Promise.resolve()
    let release = (): void => {}
    // Only ever resolved, never rejected, so a run that threw does not reject the runner
    // queued behind it.
    byTable.set(
      this.table,
      new Promise<void>((resolve) => {
        release = resolve
      }),
    )
    await ahead
    try {
      return await run()
    } finally {
      release()
    }
  }

  /**
   * Idempotent: a second call leaves the table and its rows untouched.
   *
   * A table created before checksums existed gains the column here, so a database that
   * already ran migrations gets the drift check on its next run. SQLite has no
   * `ADD COLUMN IF NOT EXISTS`, so the column list is read first.
   */
  async createHistoryTable(): Promise<void> {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.table}
      (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        checksum   TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    const columns = await this.db.queryAll<{ name: string }>(
      `SELECT name FROM pragma_table_info(?)`,
      this.unquotedTable,
    )
    if (!columns.some((column) => column.name === "checksum")) {
      await this.db.exec(`ALTER TABLE ${this.table} ADD COLUMN checksum TEXT`)
    }
  }

  /** Every recorded row, oldest first. */
  async appliedMigrations(): Promise<AppliedMigration[]> {
    const rows = await this.db.queryAll<{ name: string; checksum: string | null }>(
      `SELECT name, checksum FROM ${this.table} ORDER BY id`,
    )
    return rows.map((row) => ({ name: row.name, checksum: row.checksum ?? null }))
  }

  async applyInTransaction(migration: Migration): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.exec(migration.sqlText)
      await transaction.execute(
        `INSERT INTO ${this.table} (name, checksum) VALUES (?, ?)`,
        migration.name,
        migration.checksum,
      )
    })
  }

  async applyWithoutTransaction(migration: Migration): Promise<void> {
    await this.db.exec(migration.sqlText)
    await this.db.execute(
      `INSERT INTO ${this.table} (name, checksum) VALUES (?, ?)`,
      migration.name,
      migration.checksum,
    )
  }
}

/**
 * The queues {@link SqliteMigrationDriver.withLock} hands out, by connection and table.
 *
 * Keyed by the {@link SqliteDb} rather than by the driver instance, because two runners
 * are two driver instances over one handle — which is what two `runMigrations` calls
 * against one connection look like. A `WeakMap`, so a closed connection's queue goes with
 * it. Two handles on one file have two queues, which is the limit the class documents.
 */
const migrationQueues = new WeakMap<SqliteDb, Map<string, Promise<void>>>()

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
