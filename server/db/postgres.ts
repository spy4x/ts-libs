/**
 * Postgres pool tuning.
 *
 * The template created its client with no pool options at all
 * (`template/libs/server/db/+index.ts:5-17`), so every deployment inherited the
 * driver defaults: a connection that never times out, an idle connection that is
 * never reaped, and a pool of 10 that silently queues the eleventh concurrent
 * request behind the slowest in-flight query. `gb/libs/server/db/+index.ts:10-13`
 * set all four; those values are the defaults here, exported as an overridable
 * object rather than inlined into `createSql`.
 *
 * All four are seconds, matching the driver's own units. The names are the
 * driver's option names, so a reader can diff this file against `postgres`'s
 * documentation without a translation step.
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
