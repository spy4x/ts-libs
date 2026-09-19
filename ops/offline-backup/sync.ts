/**
 * Mirroring the local directories onto the drive, and the guard that stops a
 * deleted local repository from being deleted on the drive in the same run.
 *
 * Ported from `rostok/scripts/offline-backup/src/sync.ts` (118 lines). Two
 * source bugs are fixed here and both are pinned by tests:
 *
 * 1. `sync.ts` built rsync with `Deno.Command` and drained `child.stdout` with
 *    `getReader()` by hand. The argv was already an array, but the module could
 *    not run under the workspace test task (`--allow-run` is not granted) and the
 *    progress loop parsed *chunks* rather than lines, so a percentage split
 *    across two chunks was missed and the byte/speed figures were matched by two
 *    overlapping patterns that could pick the wrong numbers. The argv is now
 *    passed to the runner and progress comes from `CommandOptions.onOutput`.
 * 2. `~/` was expanded with `Deno.env.get("HOME") || "~"` at call time. With
 *    `HOME` unset the source produced the literal path `~/dev/rostok`, which
 *    `rsync` then created *inside the current working directory*, and with
 *    `HOME` wrong it wrote to the wrong home. The home directory is an explicit
 *    parameter.
 */

import { absPath } from "../env.ts"
import { runCommand } from "../run-command.ts"
import {
  BackupError,
  type BackupPath,
  ConfirmRequiredError,
  type OfflineBackupPorts,
  type RsyncProgress,
} from "./types.ts"

/** rsync arguments for one mirror step. Kept as data so a test asserts it exactly. */
export function syncArgv(source: string, target: string): string[] {
  return [
    "rsync",
    "-avh",
    "--info=progress2",
    "--delete",
    "--exclude=.sync*",
    "--exclude=*.tmp",
    "--exclude=.stfolder",
    source,
    target,
  ]
}

/**
 * Parse the progress figures out of one rsync `--info=progress2` line.
 *
 * Tokenised rather than matched with the source's two loose patterns, where the
 * size pattern matched the byte *rate* as readily as the byte count and the rate
 * pattern could match the percentage, so the numbers a caller logged without
 * checking were not the numbers rsync printed. What identifies rsync's size
 * column is that a percentage token follows it, and no other numeric column is
 * followed by one.
 *
 * @returns `null` for a line that carries no percentage (rsync also prints file
 * names and summaries on stdout).
 */
export function parseRsyncProgress(line: string): RsyncProgress | null {
  const tokens = line.trim().split(/\s+/)
  const percentIndex = tokens.findIndex((token) => /^\d+%$/.test(token))
  if (percentIndex === -1) return null

  const percent = Number.parseInt(tokens[percentIndex], 10)
  if (!Number.isSafeInteger(percent)) return null

  const previous = tokens[percentIndex - 1]
  return {
    percent,
    size: percentIndex > 0 && isSizeToken(previous) ? previous : undefined,
    speed: tokens.find(isSpeedToken),
  }
}

/**
 * True for a byte count column: `1.23`, `1.23M`, `512KiB`.
 *
 * A percentage is excluded by the `%`, a rate by the `/`, and anything else that
 * starts with a digit and carries a suffix is rsync's byte column — which is
 * printed with and without the trailing `B` depending on the rsync version.
 */
function isSizeToken(token: string): boolean {
  if (token === "" || token.endsWith("%") || token.includes("/")) return false
  return /^\d+(?:\.\d+)?[A-Za-z]*$/.test(token)
}

/** True for a rate column: `12.34MB/s`, `0.00kB/s`, `1.5GB/s`. */
function isSpeedToken(token: string): boolean {
  return /^\d+(?:\.\d+)?[KMGT]?i?B\/s$/.test(token)
}

/** What {@link checkDeletedRepos} needs. */
export interface CheckDeletedReposOptions extends OfflineBackupPorts {
  /** Path pairs to compare. */
  backupPaths: readonly BackupPath[]
  /** Mount point of the drive. */
  mountPoint: string
  /** Home directory used to expand a leading `~/` in a source. Required for a `~/` source. */
  home?: string
}

/** Repositories present on the drive and absent locally, per target. */
export interface DeletedRepoReport {
  /** `target` to the repository directory names that only exist on the drive. */
  orphans: Record<string, string[]>
  /** Targets that could not be listed on either side, with the reason. */
  unreadable: string[]
}

/** Local directory names in one source directory. */
async function listDirectoryNames(
  fs: OfflineBackupPorts["fs"],
  path: string,
): Promise<Set<string>> {
  const names = new Set<string>()
  for (const entry of await fs.readDir(path)) {
    if (entry.isDirectory) names.add(entry.name)
  }
  return names
}

/**
 * Compare each source directory against its counterpart on the drive.
 *
 * @returns The orphaned repositories and any target that could not be read. The
 * source did this comparison *inline* inside the confirmation prompt, so a
 * caller had no way to inspect the answer before deciding — and an unreadable
 * target was a warning it then ignored.
 * @throws {import("../env.ts").MissingEnvError} When a `~/` source has no home.
 */
export async function findDeletedRepos(
  options: CheckDeletedReposOptions,
): Promise<DeletedRepoReport> {
  const orphans: Record<string, string[]> = {}
  const unreadable: string[] = []

  for (const backupPath of options.backupPaths) {
    const source = absPath(backupPath.source, options.home ?? "")
    const target = `${options.mountPoint}/${backupPath.target}`
    let localNames: Set<string>
    let driveNames: Set<string>
    try {
      localNames = await listDirectoryNames(options.fs, source)
    } catch (error) {
      unreadable.push(`${source}: ${error}`)
      continue
    }
    try {
      driveNames = await listDirectoryNames(options.fs, target)
    } catch (error) {
      unreadable.push(`${target}: ${error}`)
      continue
    }

    const extra = [...driveNames].filter((name) => !localNames.has(name)).sort()
    if (extra.length > 0) orphans[backupPath.target] = extra
  }

  return { orphans, unreadable }
}

/**
 * Ask before a sync that would delete repositories from the drive.
 *
 * @returns `true` when the sync may proceed.
 * @throws {ConfirmRequiredError} When orphans exist and no `confirm` port was
 * supplied. The source defaulted a missing answer to `"yes"` — a piped or
 * non-interactive run silently deleted the only copy of a repository whose local
 * clone was gone, which is the one data-loss path in this package. An
 * unattended run must now fail instead of guessing.
 */
export async function checkDeletedRepos(
  options: CheckDeletedReposOptions,
): Promise<boolean> {
  const report = await findDeletedRepos(options)
  for (const problem of report.unreadable) {
    options.logger.warn(`Could not check for deleted repositories: ${problem}`)
  }

  const targets = Object.keys(report.orphans)
  if (targets.length === 0) return true

  for (const target of targets) {
    options.logger.warn(
      `${target}: these repositories exist on the drive but not locally and will be DELETED:`,
    )
    for (const name of report.orphans[target]) {
      options.logger.warn(`  - ${name}`)
    }
  }

  if (options.confirm === undefined) {
    throw new ConfirmRequiredError(
      "the sync would delete drive-only repositories and no confirm port was supplied",
    )
  }
  return await options.confirm("Delete these repositories from the drive and continue?")
}

/** What {@link syncBackups} needs. */
export interface SyncBackupsOptions extends OfflineBackupPorts {
  /** Path pairs to mirror, each `source/` to `<mountPoint>/<target>/`. */
  backupPaths: readonly BackupPath[]
  /** Mount point of the drive. */
  mountPoint: string
  /** Home directory used to expand a leading `~/` in a source. Required for a `~/` source. */
  home?: string
  /** Minimum percentage step between reported progress lines. Defaults to 5. */
  progressStep?: number
}

/**
 * Mirror every source directory onto the drive with rsync.
 *
 * Progress is reported through `CommandOptions.onOutput`, so no library code
 * touches a stream, a child process or a timer.
 *
 * @throws {BackupError} When a sync fails, carrying rsync's stderr.
 * @throws {import("../env.ts").MissingEnvError} When a `~/` source has no home.
 */
export async function syncBackups(options: SyncBackupsOptions): Promise<void> {
  const progressStep = options.progressStep ?? 5
  options.logger.info(`Syncing ${options.backupPaths.length} backup path(s)`)

  for (const backupPath of options.backupPaths) {
    const source = `${absPath(backupPath.source, options.home ?? "")}/`
    const target = `${options.mountPoint}/${backupPath.target}/`
    options.logger.info(`${backupPath.source} -> ${backupPath.target}`)

    let lastPercent = 0
    const result = await runCommand(options.runner, syncArgv(source, target), {
      onOutput: (chunk) => {
        for (const line of chunk.split("\n")) {
          const progress = parseRsyncProgress(line)
          if (progress === null) continue
          if (progress.percent < lastPercent + progressStep) continue
          lastPercent = progress.percent
          const size = progress.size === undefined ? "" : ` (${progress.size})`
          const speed = progress.speed === undefined ? "" : ` @ ${progress.speed}`
          options.logger.info(`${backupPath.target}: ${progress.percent}%${size}${speed}`)
        }
      },
    })

    if (!result.success) {
      throw new BackupError(
        `rsync failed for ${backupPath.target}: ${result.error.trim()}`,
      )
    }
    options.logger.info(`${backupPath.target} synced`)
  }

  options.logger.info("All syncs completed")
}
