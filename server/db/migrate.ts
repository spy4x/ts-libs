/**
 * The migration runner both adapters share.
 *
 * Mechanics only: discover `.sql` files, sort them, skip what the history table
 * already records, and apply the rest in one transaction each. It touches no
 * driver — `MigrationDriver` below is the port, and `postgres.ts` /
 * `sqlite.ts` each ship one implementation.
 *
 * Two behaviours come from source repos that only one of them had:
 *
 *  - the `.no_transaction` filename suffix (`gb/libs/server/db/migrate.ts:9,69,78-91`). A
 *    `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so a migration whose name
 *    ends in that suffix is handed to `applyWithoutTransaction` and recorded in the same
 *    call: the record insert is what proves the migration ran, and it has to happen outside
 *    the transaction the statement cannot be wrapped in.
 *  - the name-based history table (`offer-lens/libs/db/migrate.ts:17-23,36-37`). The template
 *    runner keyed on file names and re-read the whole table per run; here the applied set is
 *    read once per run into a `Set`.
 *
 * History rows store the migration **name**, not the file name: the `.sql` extension is
 * stripped and so is the `.no_transaction` suffix, so renaming a migration's transaction
 * mode does not orphan its history row.
 */

import { extname, join } from "@std/path"

/** Suffix that marks a migration which must run outside a transaction. */
export const NO_TRANSACTION_SUFFIX = ".no_transaction"

/** One pending migration, resolved from disk. */
export interface Migration {
  /** File name, extension included — `2026_01_18_0002_add_index.no_transaction.sql`. */
  fileName: string
  /** History-table name — `2026_01_18_0002_add_index`, suffixes stripped. */
  name: string
  /** SQL body, read once by the runner so a driver never touches the filesystem. */
  sqlText: string
  /** `true` when the file name carried {@link NO_TRANSACTION_SUFFIX}. */
  withoutTransaction: boolean
}

/** What one run did. Returned instead of logged, so a caller owns its output. */
export interface MigrationReport {
  /** Names applied by this run, in application order. */
  applied: string[]
  /** Names already present in the history table. */
  skipped: string[]
}

/**
 * The per-driver half of the runner.
 *
 * Every method is async even where the driver is synchronous — `node:sqlite` and
 * `better-sqlite3` both are — so one runner serves both adapters and a caller can
 * wrap a synchronous driver in `Promise.resolve` rather than forking the runner.
 */
export interface MigrationDriver {
  /** Create the history table when it is absent. Must be idempotent. */
  createHistoryTable(): Promise<void>
  /** Names already recorded, read once per run. */
  appliedNames(): Promise<string[]>
  /** Apply `migration` and record it, atomically. */
  applyInTransaction(migration: Migration): Promise<void>
  /**
   * Apply `migration` with no surrounding transaction, then record it. For
   * statements a transaction forbids, such as `CREATE INDEX CONCURRENTLY`.
   */
  applyWithoutTransaction(migration: Migration): Promise<void>
}

/** Options for {@link discoverMigrations} and {@link runMigrations}. */
export interface DiscoverMigrationsOptions {
  /** Directory holding the `.sql` files. */
  folder: string
  /** Extension to accept. Defaults to `.sql`. */
  extension?: string
  /**
   * Directory listing and file reading. Defaults to `Deno.readDir` /
   * `Deno.readTextFile`, so a caller that does nothing gets real files.
   */
  reader?: MigrationReader
}

/**
 * Disk access, as a port.
 *
 * The runner reads files, and reading files is the only thing that would otherwise
 * force a test of the runner to write them — which the repo's `test` task cannot do,
 * since it grants `--allow-read --allow-env` and no write access. With the two calls
 * behind this interface, every ordering, transaction and history rule is testable
 * with a map of file name to SQL text and no filesystem at all. It is also the port
 * a consumer that keeps migrations in a bundled asset or a database would implement.
 */
export interface MigrationReader {
  /** File names in `folder`. Directories and unreadable entries are the caller's concern. */
  list(folder: string): Promise<string[]>
  /** Contents of `folder/fileName`. */
  readText(folder: string, fileName: string): Promise<string>
}

/** {@link MigrationReader} over the real filesystem. */
export const denoMigrationReader: MigrationReader = {
  async list(folder: string): Promise<string[]> {
    const fileNames: string[] = []
    for await (const entry of Deno.readDir(folder)) {
      if (entry.isFile) fileNames.push(entry.name)
    }
    return fileNames
  },
  readText(folder: string, fileName: string): Promise<string> {
    return Deno.readTextFile(join(folder, fileName))
  },
}

/**
 * A file that is not a migration is skipped, not reported: `.gitkeep` is common.
 *
 * Sorted by file name, which is why the convention is a zero-padded date and
 * sequence prefix — the order migrations apply in is the order they sort in, not the
 * order `readDir` happens to return.
 */
export async function discoverMigrations(
  options: DiscoverMigrationsOptions,
): Promise<string[]> {
  const extension = options.extension ?? ".sql"
  const reader = options.reader ?? denoMigrationReader
  const fileNames = await reader.list(options.folder)
  return fileNames.filter((fileName) => extname(fileName) === extension).sort()
}

/**
 * Turn a file name into a {@link Migration}: strip the extension, then the
 * `.no_transaction` suffix.
 *
 * Order matters. Stripping the suffix first would leave `..._index.no_transaction`,
 * whose `extname` is `.no_transaction`, and the name in history would keep the
 * suffix a later rename was supposed to be free of.
 */
export function parseMigrationName(fileName: string, extension = ".sql"): Migration["name"] {
  const withoutExtension = fileName.endsWith(extension)
    ? fileName.slice(0, -extension.length)
    : fileName
  return withoutExtension.endsWith(NO_TRANSACTION_SUFFIX)
    ? withoutExtension.slice(0, -NO_TRANSACTION_SUFFIX.length)
    : withoutExtension
}

/**
 * Apply every pending migration under `options.folder`, in sorted file-name order.
 *
 * Reads the whole applied set once, then applies sequentially: order is significant
 * for migrations and a driver that serialises writes itself would otherwise reorder
 * them. A driver failure propagates unchanged — the runner catches nothing, so a
 * caller sees the driver's error rather than a summary of it, and the migrations
 * already applied stay applied while the failing one and everything after it do not.
 */
export async function runMigrations(
  driver: MigrationDriver,
  options: DiscoverMigrationsOptions,
): Promise<MigrationReport> {
  const extension = options.extension ?? ".sql"
  const reader = options.reader ?? denoMigrationReader
  await driver.createHistoryTable()
  const known = new Set(await driver.appliedNames())

  const appliedNow: string[] = []
  const skipped: string[] = []

  for (const fileName of await discoverMigrations(options)) {
    const name = parseMigrationName(fileName, extension)
    // The second form only matches a history written by a runner that recorded the file
    // name; the template runner (`template/libs/server/db/migrate.ts:55`) was the one that did.
    if (known.has(name) || known.has(fileName)) {
      skipped.push(name)
      continue
    }
    const migration: Migration = {
      fileName,
      name,
      sqlText: await reader.readText(options.folder, fileName),
      withoutTransaction: fileName.endsWith(`${NO_TRANSACTION_SUFFIX}${extension}`),
    }
    if (migration.withoutTransaction) {
      await driver.applyWithoutTransaction(migration)
    } else {
      await driver.applyInTransaction(migration)
    }
    appliedNow.push(name)
  }

  return { applied: appliedNow, skipped }
}
