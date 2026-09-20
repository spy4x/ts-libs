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
  MEMORY_PATH,
  openSqliteDb,
  type OpenSqliteDbOptions,
  removeSqliteFiles,
  resolveSqlitePath,
  SqliteDb,
  type SqliteDriver,
  type SqliteDriverFactory,
  SqliteEnvName,
  SqliteMigrationDriver,
  type SqliteOpenOptions,
  type SqliteSchema,
  type SqliteStatement,
  type TransactionStatements,
} from "./sqlite.ts"

export {
  discoverMigrations,
  type DiscoverMigrationsOptions,
  type Migration,
  type MigrationDriver,
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

export { DbServiceBase, type DbServiceBaseOptions } from "./services.ts"

export { PostgresMigrationDriver, type PostgresMigrationDriverOptions } from "./postgres-migrate.ts"

export {
  ENV_NAME,
  PROD_FLAG,
  PRODUCTION_ENV_VALUE,
  purgeDatabase,
  type PurgeOptions,
  type PurgeResult,
} from "./postgres-purge.ts"

export type { RowCache, Sql, Transaction } from "./ports.ts"
