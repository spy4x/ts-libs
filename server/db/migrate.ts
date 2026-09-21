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
 *
 * Three neighbouring kinds of drift were added after #110 found them passing without a
 * word:
 *
 *  - **nothing is applied by a run that is going to be refused.** Every file is read,
 *    hashed and checked before the first apply, so a new file that sorts before an edited
 *    one no longer lands in the database on the way to the error.
 *  - **a history row with no file is reported**, as {@link MigrationReport.missing}. Not
 *    refused: squashing old migrations away is legitimate and there is no opt-out yet.
 *  - **a renamed migration is refused.** A pending file whose body is exactly what a
 *    missing row recorded is {@link MigrationRenamedError}; it used to be treated as new
 *    and its body ran a second time.
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

/**
 * Thrown when a pending file carries the body of an applied migration whose file is gone.
 *
 * That is what a rename looks like from the runner's side: the history holds a name with
 * no file behind it any more, and a file the history has never seen hashes to exactly what
 * that row recorded. Treating it as new would run the body a second time against a
 * database that already has it, which is the one kind of drift in issue #110 that can
 * damage data.
 *
 * The way out is to rename the file back. A migration that really is new and really does
 * have the same body as a deleted one needs a body that differs — a comment naming what it
 * is for is enough — because the runner has nothing else to tell the two apart by.
 */
export class MigrationRenamedError extends Error {
  /** The history name whose file is gone. */
  readonly recordedName: string
  /** The pending migration carrying that body. */
  readonly pendingName: string
  /** The checksum both of them have. */
  readonly checksum: string

  constructor(recordedName: string, pendingName: string, checksum: string) {
    super(
      `migration ${pendingName} has the body of ${recordedName}, which was applied and ` +
        `whose file is no longer on disk (checksum ${checksum}); applying it would run that ` +
        `body a second time against a database that already has it, so rename the file back ` +
        `or give the new migration a body of its own`,
    )
    this.name = "MigrationRenamedError"
    this.recordedName = recordedName
    this.pendingName = pendingName
    this.checksum = checksum
  }
}

/** What one run did. Returned instead of logged, so a caller owns its output. */
export interface MigrationReport {
  /** Names applied by this run, in application order. */
  applied: string[]
  /** Names already present in the history table. */
  skipped: string[]
  /**
   * Names in the history table that no file on disk accounts for, oldest row first.
   *
   * A migration that was applied and then deleted used to be ignored in silence, so the
   * history and the folder disagreed with nobody told (#110). It is reported rather than
   * refused, because squashing old migrations away is a legitimate thing to do and this
   * library has no opt-out for it yet; a caller that wants a run to stop on one checks
   * this list. It is also what the rename check is derived from.
   */
  missing: string[]
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
 * Every file is read and hashed, applied or not, and **the whole plan is checked before
 * anything is applied**. A file whose hash differs from the one its history row carries
 * stops the run with {@link MigrationEditedError}, and a pending file carrying the body of
 * an applied migration whose own file is gone stops it with {@link MigrationRenamedError};
 * either way nothing has been applied by the time the error is thrown. That is the cost of
 * the check: a run reads every migration from disk rather than only the pending ones.
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

/** One file, read and hashed, with whatever history row it matched. */
interface PlannedMigration {
  /** The file, ready for a driver. */
  migration: Migration
  /** The history name this file matched, or `undefined` when the history has never seen it. */
  recordedUnder: string | undefined
  /** The checksum that row carries; `null` when it predates checksums or there is no row. */
  recordedChecksum: string | null
}

/**
 * The body of one {@link runMigrations} run, with the lock already held.
 *
 * Three passes, and the split is the point (#110). Every file is read and hashed first,
 * then the whole plan is checked, and only then is anything applied. Applying as it went
 * meant a new file that sorted *before* an edited one was applied and only then did the
 * run stop, so "the run was refused" did not mean "nothing was applied". The extra pass
 * costs nothing: every file is read either way.
 */
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

  const planned: PlannedMigration[] = []
  const accountedFor = new Set<string>()
  for (const fileName of await discoverMigrations(options)) {
    const name = parseMigrationName(fileName, extension)
    const sqlText = await reader.readText(options.folder, fileName)
    const checksum = await checksumOf(sqlText)
    // The file-name form only matches a history written by a runner that recorded the
    // file name; the template runner (`template/libs/server/db/migrate.ts:55`) did.
    const recordedUnder = known.has(name) ? name : known.has(fileName) ? fileName : undefined
    if (recordedUnder !== undefined) accountedFor.add(recordedUnder)
    planned.push({
      migration: {
        fileName,
        name,
        sqlText,
        checksum,
        withoutTransaction: fileName.endsWith(`${NO_TRANSACTION_SUFFIX}${extension}`),
      },
      recordedUnder,
      recordedChecksum: recordedUnder === undefined ? null : known.get(recordedUnder) ?? null,
    })
  }

  const missing = [...known.keys()].filter((name) => !accountedFor.has(name))
  refuseDrift(planned, known, missing)

  const appliedNow: string[] = []
  const skipped: string[] = []
  for (const entry of planned) {
    if (entry.recordedUnder !== undefined) {
      skipped.push(entry.migration.name)
      continue
    }
    if (entry.migration.withoutTransaction) {
      await driver.applyWithoutTransaction(entry.migration)
    } else {
      await driver.applyInTransaction(entry.migration)
    }
    appliedNow.push(entry.migration.name)
  }

  return { applied: appliedNow, skipped, missing }
}

/**
 * Stop the run when the folder and the history disagree in a way that would damage data.
 *
 * Two refusals, both checked over the whole plan before anything is applied, and reported
 * in file-name order so the message names the first problem a reader would find.
 *
 * An **edited** file is one whose history row records a different body. A **renamed** one
 * is a file the history has never seen whose body is exactly what a row with no file of
 * its own recorded: applying it would run that body a second time against a database that
 * already has it. The rename check is deliberately limited to rows in `missing` — a
 * pending file that shares its body with an applied migration whose file is still there is
 * a copy, not a rename, and refusing that would stop two honestly identical bodies.
 */
function refuseDrift(
  planned: PlannedMigration[],
  known: Map<string, string | null>,
  missing: string[],
): void {
  for (const entry of planned) {
    if (entry.recordedUnder !== undefined) {
      if (
        entry.recordedChecksum !== null && entry.recordedChecksum !== entry.migration.checksum
      ) {
        throw new MigrationEditedError(
          entry.migration.name,
          entry.recordedChecksum,
          entry.migration.checksum,
        )
      }
      continue
    }
    const renamedFrom = missing.find((name) => known.get(name) === entry.migration.checksum)
    if (renamedFrom !== undefined) {
      throw new MigrationRenamedError(renamedFrom, entry.migration.name, entry.migration.checksum)
    }
  }
}
