/**
 * Postgres pool tuning.
 *
 * The driver's own defaults are a connection that never times out, an idle connection that is
 * never reaped, and a pool of 10 that silently queues the eleventh concurrent request behind the
 * slowest in-flight query. These defaults set all four, exported as an overridable object rather
 * than inlined into `createSql`.
 *
 * All four are seconds, matching the driver's own units. The names are the
 * driver's option names, so a reader can diff this file against `postgres`'s
 * documentation without a translation step.
 *
 * ## A deferred constraint's failure at implicit commit is not reported on a single statement
 *
 * **Do not declare a `DEFERRABLE INITIALLY DEFERRED` constraint and write to it through anything but
 * `sql.begin`**. The pinned driver, `postgres@3.4.7`, resolves a single statement's promise
 * from the server's `CommandComplete` message, which arrives _before_ the implicit commit that
 * actually checks a deferred constraint. When that commit then fails, the `ErrorResponse` it carries
 * arrives on a query the driver has already resolved and cleared, so it has nothing left to reject —
 * the promise reports success (`count: 1`, any `RETURNING` row returned) and the write is not there.
 * No exception is thrown and no `unhandledrejection` fires: this is not a caught-and-swallowed error,
 * the failure never reaches a handler at all.
 *
 * This is not only the tagged-template path. `sql.unsafe(text, params)` — any call that passes a
 * non-empty parameter list — takes the same extended-protocol route and loses the failure the same
 * way; only a _parameterless_ `sql.unsafe(text)` (no second argument, or `sql.unsafe(text, [])`) is
 * safe, because the driver takes the simple-protocol path (which resolves after the server's own
 * commit) only when it is not asked to bind parameters (`postgres@3.4.7/src/index.js`, `unsafe`:
 * `simple: 'simple' in options ? options.simple : args.length === 0`). `sql.begin` is the one path
 * that is always safe, parameters or not — not because a statement _inside_ it resolves any
 * differently (it still resolves early, the same way a bare tagged-template statement does), but
 * because `sql.begin` sends an explicit `COMMIT` as its own statement and rejects its own returned
 * promise when that commit fails; a caller awaits `sql.begin`'s promise, not the inner statement's,
 * so the inner statement resolving on its own does not matter — use it for a write against a
 * deferred constraint instead of a bare statement, parameterised or not.
 *
 * Nothing shipped in this repository declares a deferred constraint today, so no module here is
 * affected; it is documented and pinned because a caller of `@spy4x/server/db` might add one.
 * Reproduced and pinned to `postgres@3.4.7` by
 * `server/db/postgres.integration.test.ts`, which fails loudly — not silently skips — the day an
 * upstream fix changes this. Reported upstream:
 * [porsager/postgres#1117](https://github.com/porsager/postgres/issues/1117).
 *
 * ## A transaction handle stops working when its transaction ends
 *
 * Both adapters hand a callback a handle scoped to the transaction — a `SqliteDb` on one side, a
 * `DbServiceBase` clone on the other — and both retire it when the transaction returns, on the
 * rollback path as well as the commit path. A service that stores it (`this.db = tx`) and writes
 * through it later gets `SqliteScopeEndedError` or `PostgresScopeEndedError` instead of a write that
 * lands in whatever transaction that connection is running next and disappears with that
 * transaction's rollback. The Postgres refusal is thrown rather than rejected, because the check sits
 * on the executor, which the driver also calls synchronously (`sql(table)`); a method declared `async`
 * turns it into the rejection its caller expects.
 *
 * **What the Postgres guard promises.** A clone kept past `begin()` or past a nested `begin()` refuses,
 * with `PostgresScopeEndedError`, every call form a person would write through it: the tagged template,
 * the `sql(...)` helper forms, `unsafe`, `file`, `json`, `array`, `types` and `typed`, `savepoint`,
 * `notify`, `prepare`, `new`, the service's own nested `begin()`, and anything read off the handle at
 * any depth. A transaction handle has no `begin`, `reserve` or `listen` of its own; those throw a
 * `TypeError`, live and retired alike. The executor is a
 * `Proxy` and everything it hands out on a _read_ is itself a wrapper — functions and objects alike,
 * recursively — which is why the refusal covers helpers nobody listed. `prototype.constructor` was the
 * spelling that showed why a list is not enough, since every ordinary function carries a `prototype`
 * object whose `constructor` is that function. What a _call_ returns is handed back untouched, because
 * the driver recognises a fragment, a `json` or `array` value or a query object by its class, and a
 * wrapper would not be one.
 *
 * **Two moments other than a call through the clone are checked too**, because a call through
 * the clone is not the only way a statement reaches the transaction's connection.
 *
 * A `postgres` query is lazy: nothing is sent when it is built, and `then`, `catch`, `finally`,
 * `execute` and `forEach` all reach the query's `handle()`, which is where the statement goes on the
 * connection. So a query built inside the callback and awaited after `begin()` has returned would run
 * inside whatever transaction that connection held by then and vanish with its rollback — a forgotten
 * `await` is enough to write it. The guard sits on the query's own `handle` as well: the first send
 * after the scope has ended is refused. Awaiting a query that already ran inside the callback sends
 * nothing and is not refused. `handle` is not documented driver API, which is why an integration test
 * awaits such a query and expects the error — a driver that renamed the method turns that test red
 * instead of reopening the route in silence.
 *
 * `sql.savepoint(fn)` calls `fn` with a handle the driver built and passed in, a handle that would
 * bypass the wrapper. The callback receives a scoped handle instead, retired when the
 * savepoint returns.
 *
 * **It is a guard against a mistake, not a security boundary.** The mistake: a
 * service stores the clone (`this.db = tx`) and writes through it after the transaction has returned,
 * or forgets an `await` on a query it built inside the callback. Code that goes looking for the
 * driver's internals is not making that mistake and could in any case import `postgres` and open a
 * connection of its own.
 *
 * One known route remains. The driver's own internals ride on a value a call
 * _returned_ — for example `new q.constructor(…, q.handler, …)`, since every query object holds the
 * transaction's execute function. Return values are deliberately not wrapped, so this one cannot be
 * closed by wrapping reads, and it is not the mistake the guard is for.
 *
 * `SqliteDb.close()` goes through the same gate: it waits for an open transaction rather than closing
 * the connection under it, and a scoped handle cannot close a connection it never owned. Two `close()`
 * calls issued together share one close and both return, so a shutdown handler that fires twice is
 * still harmless.
 *
 * @module
 */

import postgres from "postgres"
import type { Sql } from "./ports.ts"

/** The pool options {@link createSql} applies when a caller overrides nothing. */
export interface PoolOptions {
  /** Seconds to wait for a connection before failing. Fail fast, do not hang a request. */
  connectTimeout?: number
  /** Seconds an idle connection is kept before it is closed. */
  idleTimeout?: number
  /** Seconds a connection lives before it is rotated, so DNS and failover changes land. */
  maxLifetimeSeconds?: number
  /** Maximum connections in the pool. */
  max?: number
  /** Value for the connection's `application_name`, visible in `pg_stat_activity`. */
  applicationName?: string
  /**
   * `postgres.camel`, so `snake_case` columns read as `camelCase` fields.
   *
   * Typed as the driver's own helper rather than as the driver's `Transform` interface:
   * those two disagree in `postgres@3.4.7` (`camel` carries `column.from`,
   * `column.to` and `value.from`, while `Transform` also demands `undefined`, `value.to`
   * and a whole `row` transform), so the interface would reject the only value anyone
   * passes and accept hand-built objects the driver does not support.
   */
  transform?: typeof postgres.camel
  /**
   * TLS for the connection, in the driver's own shape.
   *
   * `false` (the driver's default) sends no TLS at all, `"require"` demands an
   * encrypted connection without checking the certificate, `"verify-full"` also checks
   * the name, and a `node:tls` options object carries a custom certificate authority.
   * Typed from the driver's own option so the values here cannot drift from the values
   * it accepts. There is no default: a managed Postgres almost always needs one of
   * these, and picking it for the caller would be picking how much of the connection
   * is verified.
   */
  ssl?: postgres.Options<Record<string, postgres.PostgresType>>["ssl"]
}

/**
 * Pool defaults. Every one of them is a ceiling on a resource the database
 * server owns, so a busy deployment may raise `max` — and should lower it on a
 * server whose `max_connections` is shared with other clients.
 */
export const DEFAULT_POOL_OPTIONS: Required<
  Pick<PoolOptions, "connectTimeout" | "idleTimeout" | "maxLifetimeSeconds" | "max">
> = {
  connectTimeout: 10,
  idleTimeout: 30,
  maxLifetimeSeconds: 60 * 30,
  max: 15,
}

/** Connection fields, read from the caller's environment rather than from `Deno.env` here. */
export interface PostgresConnectionConfig {
  host: string
  port?: number
  user: string
  password: string
  database: string
}

/** A connection config plus the pool options and `application_name` to use. */
export interface CreateSqlOptions extends PoolOptions {
  connection: PostgresConnectionConfig
}

/** The environment variable names this module's helpers read. */
export enum PostgresEnvName {
  Host = "DB_HOST",
  Port = "DB_PORT",
  User = "DB_USER",
  Pass = "DB_PASS",
  Name = "DB_NAME",
}

/** `DB_PORT` is optional so a deployment that omits it keeps the 5432 default. */
const DEFAULT_PORT = 5432
const DECIMAL_INTEGER = /^[0-9]+$/

/**
 * Parse the Postgres connection settings from an explicit environment record.
 *
 * Takes the record as an argument rather than reading `Deno.env` at module
 * scope, for the same reason `server/storage/env.ts` does: the module then has no
 * import-time environment dependency and a test drives every branch with a
 * literal. Returns `undefined` when `DB_HOST` is unset or empty — an
 * unconfigured deployment gets no client rather than a client pointed at
 * localhost, which is the connection that turns a missing variable into a
 * five-minute DNS timeout in production.
 *
 * A `DB_PORT` that is not a decimal integer throws: `Number("")` is `0` and
 * `Number("abc")` is `NaN`, and both would be handed to the driver as a port.
 *
 * A missing `DB_USER`, `DB_PASS` or `DB_NAME` throws too, once `DB_HOST` is set. They
 * used to default to the empty string, which is a valid value to hand a driver and
 * never the value anybody meant: the client then dialled the right host and failed
 * authentication, so a missing variable in a deployment looked like wrong credentials.
 */
export function parsePostgresEnv(
  environment: Record<string, string | undefined>,
): PostgresConnectionConfig | undefined {
  const host = environment[PostgresEnvName.Host]
  if (host === undefined || host === "") return undefined

  const rawPort = environment[PostgresEnvName.Port]
  if (rawPort !== undefined && rawPort !== "") {
    if (!DECIMAL_INTEGER.test(rawPort)) {
      throw new RangeError(
        `${PostgresEnvName.Port} must be a decimal integer, got ${JSON.stringify(rawPort)}`,
      )
    }
    const port = Number(rawPort)
    if (port < 1 || port > 65535) {
      throw new RangeError(`${PostgresEnvName.Port} must be between 1 and 65535, got ${port}`)
    }
  }

  return {
    host,
    port: rawPort === undefined || rawPort === "" ? DEFAULT_PORT : Number(rawPort),
    user: required(environment, PostgresEnvName.User),
    password: required(environment, PostgresEnvName.Pass),
    database: required(environment, PostgresEnvName.Name),
  }
}

/** Read a variable that has no sensible default, or say which one is missing. */
function required(environment: Record<string, string | undefined>, name: PostgresEnvName): string {
  const value = environment[name]
  if (value === undefined || value === "") {
    throw new Error(`${name} is required when ${PostgresEnvName.Host} is set`)
  }
  return value
}

/**
 * The driver options {@link createSql} passes, as a plain object.
 *
 * Split out so the pool tuning is testable without a connection: the four values are
 * what a deployment inherits, and asserting them on this object is the only way to
 * check them without a live server. The driver's own option names are used verbatim —
 * `connect_timeout`, not `connectTimeout` — so this object can be diffed against
 * `postgres`'s documentation.
 */
export function buildPostgresOptions(
  options: CreateSqlOptions,
): postgres.Options<Record<string, postgres.PostgresType>> {
  const {
    connection,
    connectTimeout = DEFAULT_POOL_OPTIONS.connectTimeout,
    idleTimeout = DEFAULT_POOL_OPTIONS.idleTimeout,
    maxLifetimeSeconds = DEFAULT_POOL_OPTIONS.maxLifetimeSeconds,
    max = DEFAULT_POOL_OPTIONS.max,
    applicationName,
    transform,
    ssl,
  } = options

  return {
    host: connection.host,
    port: connection.port ?? DEFAULT_PORT,
    user: connection.user,
    pass: connection.password,
    db: connection.database,
    connect_timeout: connectTimeout,
    idle_timeout: idleTimeout,
    max_lifetime: maxLifetimeSeconds,
    max,
    ...(applicationName === undefined ? {} : { connection: { application_name: applicationName } }),
    ...(transform === undefined ? {} : { transform }),
    ...(ssl === undefined ? {} : { ssl }),
  }
}

/**
 * Build a Postgres client with {@link DEFAULT_POOL_OPTIONS} applied.
 *
 * `transform` is left to the caller: pass `postgres.camel` for camelCase field access,
 * or nothing to keep raw column names. A default would be a silent choice about every
 * query result in the process, so there is none.
 *
 * Nothing here connects. `postgres` opens its first connection on the first query, so
 * a bad host surfaces at `connect()` rather than at this call, which is why
 * `DbServiceBase.connect` exists.
 *
 * **Do not declare a `DEFERRABLE INITIALLY DEFERRED` constraint and write to it through
 * anything but `sql.begin`**. The pinned driver, `postgres@3.4.7`, resolves a
 * single statement's promise from the server's `CommandComplete`, which arrives before
 * the implicit commit that actually checks a deferred constraint; when that commit then
 * fails, the error has no query left to reject and the promise reports success —
 * `count: 1`, any `RETURNING` row returned — while the write is not there, with no
 * exception thrown and no `unhandledrejection` fired. This is not only the tagged-template
 * path: `sql.unsafe(text, params)` — any call with a non-empty parameters argument — takes
 * the same extended-protocol route and loses the failure the same way. Only a
 * *parameterless* `sql.unsafe(text)` (no second argument, or an explicit empty array) is
 * safe outside `sql.begin`, because the driver only takes the simple-protocol path (which
 * resolves after the server's own commit) when it is not asked to bind parameters
 * (`postgres@3.4.7/src/index.js`, `unsafe`: `simple: 'simple' in options ? options.simple :
 * args.length === 0`). `sql.begin` is the one path that is always safe, parameters or not —
 * not because a statement *inside* it resolves any differently (it still resolves early,
 * the same way a bare tagged-template statement does), but because `sql.begin` sends an
 * explicit `COMMIT` as its own statement and rejects its own returned promise when that
 * commit fails; a caller awaits `sql.begin`'s promise, not the inner statement's, so the
 * inner statement resolving on its own does not matter. Reproduced and pinned to this
 * driver version in `server/db/postgres.integration.test.ts`. Reported upstream:
 * https://github.com/porsager/postgres/issues/1117.
 */
export function createSql(options: CreateSqlOptions): Sql {
  return postgres(buildPostgresOptions(options)) as Sql
}

/** Build a client from an environment record, or `undefined` when `DB_HOST` is unset. */
export function createSqlFromEnv(
  environment: Record<string, string | undefined>,
  options: PoolOptions = {},
): Sql | undefined {
  const connection = parsePostgresEnv(environment)
  return connection === undefined ? undefined : createSql({ ...options, connection })
}
