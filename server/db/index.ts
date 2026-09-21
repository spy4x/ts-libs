/**
 * `@ts-libs/server/db` — the Postgres and SQLite layers, plus the migration runner
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
 * Source repos, all read-only design sources:
 * `template/libs/server/db`, `gb/libs/server/db`, `offer-lens/libs/db`,
 * `warthunder-stats/libs/server/db`.
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
  PostgresMigrationDriver,
  type PostgresMigrationDriverOptions,
  PostgresMigrationLockError,
  PostgresMigrationRunInProgressError,
} from "./postgres-migrate.ts"

export {
  ENV_NAME,
  PROD_FLAG,
  purgeDatabase,
  type PurgeOptions,
  type PurgeResult,
  SAFE_ENV_VALUES,
} from "./postgres-purge.ts"

export type { RowCache, Sql, Transaction } from "./ports.ts"
