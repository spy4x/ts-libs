/**
 * `@spy4x/server/db` — the Postgres and SQLite layers, plus the migration runner
 * they share.
 *
 * Nothing here reads `Deno.env` at import time and nothing opens a connection at
 * import time. Every entry point takes its client, its connection settings or its
 * driver from the caller, which is what keeps the module importable from an edge
 * worker, testable without a database, and free of a driver dependency: this package
 * publishes no SQLite driver and no Postgres client of its own — `postgres` is
 * already pinned in the root import map, and the SQLite driver is the caller's
 * choice.
 *
 * Design sources: `template/libs/server/db` and the database layers of three
 * earlier internal projects.
 *
 * Two adapters, one migration runner. `@spy4x/server/db` is the barrel; `db/migrate`,
 * `db/postgres` and `db/sqlite` are the subpaths. Nothing here ships a driver: `postgres` is pinned in
 * the root import map and the SQLite driver is the caller's own, passed through `SqliteDriver`.
 *
 * ## Searching text with `LIKE`: `likeContains`
 *
 * `likeContains(value)` escapes `\`, `%` and `_` and wraps the result in `%…%`, so a search box's text
 * matches literally instead of acting as a wildcard. Postgres escapes with `\` by default:
 * `` sql`… WHERE email ILIKE ${likeContains(search)}` ``. SQLite has no default escape, so name it:
 * `WHERE email LIKE ? ESCAPE '\'`.
 *
 * ## Purging
 *
 * `purgeDatabase` refuses unless `ENV` names one of `SAFE_ENV_VALUES` — `dev`, `development`, `local`,
 * `test`, `ci`, compared trimmed and lower-cased — or the caller passes `--prod`. The list is frozen:
 * `readonly` is a compile-time claim, and a consumer that cast the array and pushed onto it would arm
 * the purge for that environment process-wide.
 *
 * Like the migration driver, the table listing it purges from is read through `.values()`, not by the
 * `tablename` alias written in the query, so it survives any column-name transform the caller's client
 * carries — including a custom one that maps two different columns to the same name (`#137`).
 *
 * @module
 */

export {
  applySqliteSchema,
  DEFAULT_MIGRATIONS_TABLE,
  DEFAULT_SQLITE_FILE,
  DEFAULT_TRANSACTION_STATEMENTS,
  DEFAULT_TRANSACTION_WAIT_MS,
  MEMORY_PATH,
  openSqliteDb,
  type OpenSqliteDbOptions,
  removeSqliteFiles,
  resolveSqlitePath,
  SqliteDb,
  type SqliteDbOptions,
  type SqliteDelay,
  type SqliteDriver,
  type SqliteDriverFactory,
  SqliteEnvName,
  SqliteMigrationDriver,
  type SqliteOpenOptions,
  type SqliteRunResult,
  type SqliteSchema,
  SqliteScopeEndedError,
  type SqliteStatement,
  SqliteTransactionWaitError,
  type TransactionStatements,
} from "./sqlite.ts"

export {
  type AppliedMigration,
  checksumOf,
  discoverMigrations,
  type DiscoverMigrationsOptions,
  type Migration,
  type MigrationDriver,
  MigrationEditedError,
  MigrationRenamedError,
  type MigrationReport,
  NO_TRANSACTION_SUFFIX,
  parseMigrationName,
  runMigrations,
} from "./migrate.ts"

export {
  buildPostgresOptions,
  createSql,
  createSqlFromEnv,
  type CreateSqlOptions,
  DEFAULT_POOL_OPTIONS,
  parsePostgresEnv,
  type PoolOptions,
  type PostgresConnectionConfig,
  PostgresEnvName,
} from "./postgres.ts"

export {
  DbServiceBase,
  type DbServiceBaseOptions,
  type FindOneParams,
  PostgresScopeEndedError,
  type RowMethods,
} from "./services.ts"

export {
  DEFAULT_MIGRATION_LOCK_RETRY_MS,
  DEFAULT_MIGRATION_LOCK_WAIT_MS,
  type MigrationDelay,
  PostgresIdentifierTransformError,
  PostgresMigrationDriver,
  type PostgresMigrationDriverOptions,
  PostgresMigrationLockError,
  PostgresMigrationRunInProgressError,
  PostgresUnexpectedRowError,
} from "./postgres-migrate.ts"

export {
  ENV_NAME,
  PROD_FLAG,
  purgeDatabase,
  type PurgeOptions,
  type PurgeResult,
  SAFE_ENV_VALUES,
} from "./postgres-purge.ts"

export { likeContains } from "./like.ts"

export type { RowCache, Sql, Transaction } from "./ports.ts"
