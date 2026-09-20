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
 * The production guard is kept exactly as it was: `ENV=prod` refuses unless the
 * caller passes `--prod`. Losing that guard inside a destructive helper is the one
 * behaviour on this file that must not drift, so it is checked before any query
 * runs and it is checked against the caller's environment record, not `Deno.env`.
 */

import type { Sql } from "./ports.ts"

/** The environment variable that marks a production deployment. */
export const ENV_NAME = "ENV"

/** The value of {@link ENV_NAME} that arms the guard. */
export const PRODUCTION_ENV_VALUE = "prod"

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
 * Refuses without querying anything when the environment is production and
 * {@link PROD_FLAG} is absent. Returns the dropped names rather than logging them,
 * so a CLI and a test can present the same result differently.
 */
export async function purgeDatabase(options: PurgeOptions): Promise<PurgeResult> {
  const environment = options.environment ?? {}
  const args = options.args ?? []
  const schema = options.schema ?? "public"
  if (environment[ENV_NAME] === PRODUCTION_ENV_VALUE && !args.includes(PROD_FLAG)) {
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
    await options.sql`DROP TABLE ${options.sql(row.table_name)} CASCADE`
    dropped.push(row.table_name)
  }
  return { dropped, refused: false }
}
