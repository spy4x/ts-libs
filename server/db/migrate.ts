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
 *
 * Two rules were added after #59 found the runner had neither:
 *
 *  - **one runner at a time.** Two application instances starting together both read an
 *    empty history and both applied every migration. The whole run — the history table,
 *    the applied set and every apply — happens inside {@link MigrationDriver.withLock},
 *    so the second runner reads the history the first one wrote and skips.
 *  - **an applied migration's file may not change.** Every run hashes each file and
 *    compares it with the hash the history row carries; a mismatch is
 *    {@link MigrationEditedError} and stops the run. A row written before checksums
 *    existed carries `null` and is not checked, because there is nothing to compare it
 *    with and assuming the current file is the one that ran would be the silent answer
 *    this check exists to replace.
 */

import { extname, join } from "@std/path"
import { encodeHex } from "@std/encoding/hex"

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
  /** SHA-256 of {@link sqlText}, lower-case hex. A driver records it with the name. */
  checksum: string
  /** `true` when the file name carried {@link NO_TRANSACTION_SUFFIX}. */
  withoutTransaction: boolean
}

/** One row of the history table, as a driver reads it back. */
export interface AppliedMigration {
  /** The recorded name, suffixes stripped, as {@link Migration.name} spells it. */
  name: string
  /**
   * The recorded SHA-256 of the body, or `null` when the row predates checksums.
   *
   * `null` is "unknown", not "matches": such a row is skipped by the drift check
   * entirely. Back-filling it from the current file would record the file as the one
   * that ran, which is precisely the assumption the check exists to stop making.
   */
  checksum: string | null
}

/**
 * Thrown when a migration file changed after it was applied.
 *
 * The file on disk no longer hashes to what the history table recorded when the
 * migration ran, so the database does not hold what the file says it holds. The runner
 * stops rather than choosing between the two wrong answers it used to pick from
 * silently: skipping the file, which leaves the edit unapplied for ever, or re-running
 * it, which applies it twice everywhere it had already run.
 *
 * The way out is a new migration carrying the change. Restoring the file to its applied
 * body also clears it, and is the right move when the edit was an accident.
 */
export class MigrationEditedError extends Error {
  /** The migration's history name. */
  readonly migration: string
  /** The checksum the history table holds. */
  readonly recordedChecksum: string
  /** The checksum of the file as it is now. */
  readonly fileChecksum: string

  constructor(migration: string, recordedChecksum: string, fileChecksum: string) {
    super(
      `migration ${migration} was applied from a different body than the file now holds ` +
        `(recorded ${recordedChecksum}, file ${fileChecksum}); the database does not hold ` +
        `what this file says it does, so write a new migration for the change instead of ` +
        `editing an applied one`,
    )
    this.name = "MigrationEditedError"
    this.migration = migration
    this.recordedChecksum = recordedChecksum
    this.fileChecksum = fileChecksum
  }
}

/**
 * SHA-256 of a migration body, as lower-case hex.
 *
 * The body is hashed exactly as it was read: no trimming, no newline normalisation. A
 * migration whose only change is whitespace is still a changed file, and a runner that
 * forgave whitespace would have to decide which whitespace is significant inside a
 * string literal.
 */
export async function checksumOf(sqlText: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sqlText))
  return encodeHex(new Uint8Array(digest))
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
  /**
   * Run `run` with no other migration runner working on the same history table.
   *
   * The lock covers the whole run, not one migration: the race that costs a database is
   * two runners each reading an empty history before either has applied anything, and a
   * lock taken per migration would not see it. A driver releases the lock whatever `run`
   * does, and a runner that cannot take the lock waits for the one holding it.
   */
  withLock<T>(run: () => Promise<T>): Promise<T>
  /** Create the history table when it is absent. Must be idempotent. */
  createHistoryTable(): Promise<void>
  /** Rows already recorded, read once per run, with the checksum each one carries. */
  appliedMigrations(): Promise<AppliedMigration[]>
  /** Apply `migration` and record it with its checksum, atomically. */
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
 * The whole run happens inside {@link MigrationDriver.withLock}: the history table, the
 * applied set and every apply. That is what makes two runners started together apply
 * each migration once — the second one takes the lock after the first has finished and
 * reads the history it wrote. Locking a single migration would not do it, because the
 * race is between the two reads of the history, not between the two writes.
 *
 * Every file is read and hashed, applied or not, and a file whose hash differs from the
 * one its history row carries stops the run with {@link MigrationEditedError}. That is
 * the cost of the check: a run reads every migration from disk rather than only the
 * pending ones.
 *
 * Reads the whole applied set once, then applies sequentially: order is significant
 * for migrations and a driver that serialises writes itself would otherwise reorder
 * them. A driver failure propagates unchanged — the runner catches nothing, so a
 * caller sees the driver's error rather than a summary of it, and the migrations
 * already applied stay applied while the failing one and everything after it do not.
 */
export function runMigrations(
  driver: MigrationDriver,
  options: DiscoverMigrationsOptions,
): Promise<MigrationReport> {
  return driver.withLock(() => applyPending(driver, options))
}

/** The body of one {@link runMigrations} run, with the lock already held. */
async function applyPending(
  driver: MigrationDriver,
  options: DiscoverMigrationsOptions,
): Promise<MigrationReport> {
  const extension = options.extension ?? ".sql"
  const reader = options.reader ?? denoMigrationReader
  await driver.createHistoryTable()
  const known = new Map<string, string | null>()
  for (const row of await driver.appliedMigrations()) {
    known.set(row.name, row.checksum)
  }

  const appliedNow: string[] = []
  const skipped: string[] = []

  for (const fileName of await discoverMigrations(options)) {
    const name = parseMigrationName(fileName, extension)
    const sqlText = await reader.readText(options.folder, fileName)
    const checksum = await checksumOf(sqlText)
    // The file-name form only matches a history written by a runner that recorded the
    // file name; the template runner (`template/libs/server/db/migrate.ts:55`) did.
    const recordedUnder = known.has(name) ? name : known.has(fileName) ? fileName : undefined
    if (recordedUnder !== undefined) {
      const recorded = known.get(recordedUnder) ?? null
      if (recorded !== null && recorded !== checksum) {
        throw new MigrationEditedError(name, recorded, checksum)
      }
      skipped.push(name)
      continue
    }
    const migration: Migration = {
      fileName,
      name,
      sqlText,
      checksum,
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
