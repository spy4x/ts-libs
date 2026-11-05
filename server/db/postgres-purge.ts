/**
 * Drop every table in the `public` schema.
 *
 * The table listing is read through `.values()` rather than by column name, so it survives `postgres.camel`, `postgres.pascal`, `postgres.kebab` or a custom
 * `transform.column.from` alike, including one that maps two different columns to the same
 * name; see `expectRowShape` in `postgres-migrate.ts`.
 *
 * **A table or schema name the same transform would rewrite is refused before any `DROP`
 * runs**, with {@link PostgresIdentifierTransformError}, whether `sql` is the pool client, a
 * `sql.begin` transaction handle or a `sql.reserve()` connection — see that error, exported
 * from `postgres-migrate.ts`, for why reconciling the two spellings is not attempted.
 *
 * **The guard is an allow-list.** Refusing only `ENV=prod` would purge for `production`, `PROD`,
 * `"prod "` or an unset `ENV`, so this refuses unless `ENV` names an
 * environment on {@link SAFE_ENV_VALUES}, so an environment nobody listed is a refusal
 * rather than a purge. `--prod` overrides it, and the check runs before
 * any query and against the caller's environment record, not `Deno.env`.
 */

import { assertStableIdentifier, expectRowShape } from "./postgres-migrate.ts"
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
 *
 * Frozen. `readonly` is a compile-time claim only, and a consumer that casts the array
 * and pushes a name onto it would arm the purge for that environment in every module
 * that imports this one, for the rest of the process. `Object.freeze` makes that push
 * throw instead.
 */
export const SAFE_ENV_VALUES: readonly string[] = Object.freeze([
  "dev",
  "development",
  "local",
  "test",
  "ci",
])

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
  /**
   * The caller's own decision, which replaces the guard: `true` purges and `false` refuses,
   * and neither reads `environment` or `args`. Omitted, the guard decides from
   * {@link ENV_NAME} and {@link PROD_FLAG}.
   */
  allowed?: boolean
  /** Schema to purge. Defaults to `public`. */
  schema?: string
}

/**
 * Drop every base table in `options.schema`, `CASCADE`.
 *
 * Refuses without querying anything unless `allowed` is `true`, or, with `allowed`
 * omitted, {@link ENV_NAME} names one of {@link SAFE_ENV_VALUES} or {@link PROD_FLAG}
 * is present. Returns the dropped names rather than logging them, so a CLI and a test
 * can present the same result differently.
 *
 * Each table is dropped by its schema and its name, as two separately quoted
 * identifiers. Dropping the bare name would resolve through `search_path` instead:
 * asked to purge `tenant_a`, the helper listed `tenant_a`'s tables and then dropped
 * whatever `public` happened to have under each of those names.
 *
 * **A schema or table name the client's own transform would rewrite is refused, and
 * nothing is dropped.** `DROP TABLE ${sql(schema)}.${sql(table)}` sends `table` and
 * `schema` through the client's `transform.column.to`, and the listing above reads them
 * as bound values, which that transform never touches — a camelCase client given
 * `"UserProfile"` would list it and then try to drop `_user_profile`, which does not
 * exist. Every name is checked before the first `DROP` runs, not one at a time as each
 * is dropped, so a refusal never leaves some tables gone and others not. The check reads
 * what `sql(name)` would send, so it holds on the pool client, a `sql.begin` transaction
 * handle and a `sql.reserve()` connection alike; see `PostgresIdentifierTransformError` and
 * `identifierRewrittenBy` in `postgres-migrate.ts`.
 *
 * **The listing is read through `.values()`, not by the `tablename` alias written above**
 * — see `expectRowShape` in `postgres-migrate.ts`. `postgres.camel` leaves a bare
 * lower-case word like `tablename` unchanged, but `postgres.pascal` upper-cases its first
 * letter regardless; a name-keyed read left `row.tablename` `undefined` on a
 * `postgres.pascal` client and the identifier splice below threw rather than dropping
 * anything. A row that is not an array of exactly one value throws
 * {@link PostgresUnexpectedRowError} instead of being misread.
 */
export async function purgeDatabase(options: PurgeOptions): Promise<PurgeResult> {
  const environment = options.environment ?? {}
  const args = options.args ?? []
  const schema = options.schema ?? "public"
  const allowed = options.allowed ?? (isSafeEnvironment(environment) || args.includes(PROD_FLAG))
  if (!allowed) {
    return { dropped: [], refused: true }
  }

  const rows = await options.sql<Record<string, unknown>[]>`
    SELECT table_name AS tablename
    FROM information_schema.tables
    WHERE table_schema = ${schema}
    AND table_type = 'BASE TABLE'
  `.values()
  const tableNames = rows.map((row) => {
    const [name] = expectRowShape("purgeDatabase's table listing", row, 1)
    return name as string
  })

  // Before any DROP: every name is checked first, so a refusal never leaves some
  // tables dropped and others not.
  assertStableIdentifier(options.sql, "schema", schema)
  for (const name of tableNames) {
    assertStableIdentifier(options.sql, "table", name)
  }

  const dropped: string[] = []
  for (const name of tableNames) {
    await options.sql`DROP TABLE ${options.sql(schema)}.${options.sql(name)} CASCADE`
    dropped.push(name)
  }
  return { dropped, refused: false }
}

/** `true` when {@link ENV_NAME} names an environment a purge may run against unasked. */
function isSafeEnvironment(environment: Record<string, string | undefined>): boolean {
  const value = environment[ENV_NAME]
  if (value === undefined) return false
  return SAFE_ENV_VALUES.includes(value.trim().toLowerCase())
}
