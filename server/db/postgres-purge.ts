/**
 * Drop every table in the `public` schema.
 *
 * Ported from `template/libs/server/db/purge.ts`, with the CLI extracted from the
 * operation. The source read `getEnvVar("ENV")`, printed progress and called
 * `Deno.exit` inside its own `try` blocks (`:14,28,36,45`), and it read the table
 * list into `row.tableName` — a camelCase field that only exists because the
 * template client sets `transform: postgres.camel` (`template/libs/server/db/+index.ts:13`).
 * This reads `table_name` instead, so the helper works against a client built
 * without a transform, and the transform it no longer depends on is stated rather
 * than assumed.
 *
 * **The guard is inverted from the source's.** The source refused only when `ENV` was
 * exactly `prod`, which meant it purged for `production`, for `PROD`, for `"prod "`
 * with a trailing space, and for an unset `ENV` — every way of spelling a production
 * deployment except the one spelling it knew. This refuses unless `ENV` names an
 * environment on {@link SAFE_ENV_VALUES}, so an environment nobody listed is a refusal
 * rather than a purge. `--prod` still overrides it, and the check still runs before
 * any query and against the caller's environment record, not `Deno.env`.
 */

import type { Sql } from "./ports.ts"

/** The environment variable that names the deployment. */
export const ENV_NAME = "ENV"

/**
 * The values of {@link ENV_NAME} a purge runs for without {@link PROD_FLAG}.
 *
 * An allowlist, and short on purpose: the cost of leaving a throw-away environment off
 * it is one `--prod` flag, and the cost of a production name being absent from a
 * denylist is the database. Compared after trimming and lower-casing, so `" Dev "` is
 * `dev`; anything else, including an unset variable, is refused.
 */
export const SAFE_ENV_VALUES: readonly string[] = ["dev", "development", "local", "test", "ci"]

/** The argument that overrides the guard. */
export const PROD_FLAG = "--prod"

/** What a purge did, or why it refused. */
export interface PurgeResult {
  /** Tables dropped, in the order they were dropped. */
  dropped: string[]
  /** `true` when the production guard refused the purge and no query ran. */
  refused: boolean
}

/** Options for {@link purgeDatabase}. */
export interface PurgeOptions {
  /** Client to drop through. */
  sql: Sql
  /** Environment record, read for {@link ENV_NAME}. Defaults to an empty record. */
  environment?: Record<string, string | undefined>
  /** Command-line arguments, checked for {@link PROD_FLAG}. Defaults to none. */
  args?: readonly string[]
  /** Schema to purge. Defaults to `public`. */
  schema?: string
}

/** A row of the table listing. */
interface TableRow {
  table_name: string
}

/**
 * Drop every base table in `options.schema`, `CASCADE`.
 *
 * Refuses without querying anything unless {@link ENV_NAME} names one of
 * {@link SAFE_ENV_VALUES} or {@link PROD_FLAG} is present. Returns the dropped names
 * rather than logging them, so a CLI and a test can present the same result
 * differently.
 *
 * Each table is dropped by its schema and its name, as two separately quoted
 * identifiers. Dropping the bare name would resolve through `search_path` instead:
 * asked to purge `tenant_a`, the helper listed `tenant_a`'s tables and then dropped
 * whatever `public` happened to have under each of those names.
 */
export async function purgeDatabase(options: PurgeOptions): Promise<PurgeResult> {
  const environment = options.environment ?? {}
  const args = options.args ?? []
  const schema = options.schema ?? "public"
  if (!isSafeEnvironment(environment) && !args.includes(PROD_FLAG)) {
    return { dropped: [], refused: true }
  }

  const rows = await options.sql<TableRow[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = ${schema}
    AND table_type = 'BASE TABLE'
  `

  const dropped: string[] = []
  for (const row of rows) {
    await options.sql`DROP TABLE ${options.sql(schema)}.${options.sql(row.table_name)} CASCADE`
    dropped.push(row.table_name)
  }
  return { dropped, refused: false }
}

/** `true` when {@link ENV_NAME} names an environment a purge may run against unasked. */
function isSafeEnvironment(environment: Record<string, string | undefined>): boolean {
  const value = environment[ENV_NAME]
  if (value === undefined) return false
  return SAFE_ENV_VALUES.includes(value.trim().toLowerCase())
}
