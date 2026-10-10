/**
 * `@spy4x/server/db/testing` — the integration tier's Postgres settings, read so that a missing
 * one fails the test instead of skipping it.
 *
 * Nothing here opens a connection or reads the environment at import time.
 *
 * @module
 */

import { systemEnv } from "../config/env.ts"
import type { EnvReader } from "../config/env.ts"
import { type CreateSqlOptions, parsePostgresEnv, PostgresEnvName } from "./postgres.ts"

/** The variables a test needs; `DB_PORT` is optional and defaults to 5432. */
const REQUIRED = [
  PostgresEnvName.Host,
  PostgresEnvName.User,
  PostgresEnvName.Pass,
  PostgresEnvName.Name,
] as const

/** What {@link requireDbConnection} reads from and says. */
export interface RequireDbConnectionOptions {
  /** Where the variables come from. Defaults to the process environment. */
  env?: EnvReader
  /** Where the caller's setup recipe lives, for example `docs/handoff.md`. Added to the error. */
  hint?: string
}

/** Seconds a test waits for the database; the driver's own default made a dead host look hung. */
export const TEST_CONNECT_TIMEOUT_SECONDS = 5

/**
 * Postgres connection settings for an integration test, read from `DB_HOST`, `DB_PORT`,
 * `DB_USER`, `DB_PASS` and `DB_NAME`. Returns options `createSql` takes as they are.
 *
 * Throws one error naming every missing variable (and the caller's `hint`), instead of letting a
 * test mark itself `ignore` or connect to whatever Postgres the shell happens to point at. A
 * blank variable counts as missing. The error never carries a value.
 *
 * `connectTimeout` is {@link TEST_CONNECT_TIMEOUT_SECONDS}: the driver's default took 60 seconds
 * to report an unreachable host, which reads as a hang in a test run.
 *
 * @throws {Error} When a required variable is missing or blank.
 * @throws {RangeError} When `DB_PORT` is not a port number.
 */
export function requireDbConnection(
  options: RequireDbConnectionOptions = {},
): Required<Pick<CreateSqlOptions, "connection" | "connectTimeout">> {
  const env = options.env ?? systemEnv
  const missing = REQUIRED.filter((name) => !env.get(name))
  if (missing.length > 0) {
    const hint = options.hint ? ` (${options.hint})` : ""
    throw new Error(`integration test needs ${missing.join(", ")}${hint}`)
  }
  const record: Record<string, string | undefined> = {}
  for (const name of [...REQUIRED, PostgresEnvName.Port]) record[name] = env.get(name)
  return {
    connection: parsePostgresEnv(record)!,
    connectTimeout: TEST_CONNECT_TIMEOUT_SECONDS,
  }
}
