/**
 * Pure and filesystem-facing helpers: byte formatting, the run log on the
 * drive, the drive's README, and validation of the source list.
 *
 * Ported from `rostok/scripts/offline-backup/src/helpers.ts` (193 lines). Four
 * things were removed rather than translated, each for a stated reason:
 *
 * 1. `ConsoleLogger` patched the global `console` object for the duration of a
 *    run. That is not reentrant, cannot be restored after an unhandled
 *    rejection, and makes the captured lines depend on every other module in the
 *    process. The package's one logging convention is `../console.ts`, whose
 *    `Logger.records()` returns the same lines the sink received, so a caller
 *    passes a logger and hands us its records.
 * 2. The README hardcoded `~/dev/rostok`, `deno task offline-backup restore` and
 *    a `BACKUPS_PASSWORD` env var name. The drive is read on a machine that may
 *    not have this repository at all, so the restore instructions are a
 *    parameter with a neutral default.
 * 3. The README's "Singapore Climate" prose is the source cluster's storage
 *    plan, not a property of an offline backup drive. Dropped.
 * 4. `saveBackupLog` swallowed every write failure with an empty catch and
 *    logged a warning, so a run that never persisted its log still reported
 *    success. It returns the written path and lets the error out.
 */

import { absPath } from "../env.ts"
import type { Clock, Logger } from "../console.ts"
import type { FileSystem } from "../fs.ts"
import {
  BackupError,
  type BackupPath,
  type BackupSize,
  type BackupSourceReport,
  LOGS_DIR,
} from "./types.ts"

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const

/**
 * Format a byte count with binary units.
 *
 * Kept identical to the source so log lines and the README do not change
 * meaning: `1024` is `1.00 KB`, and the unit list stops at `TB`, so a `PB`-sized
 * drive reads as a large number of terabytes rather than a wrong unit.
 */
export function formatBytes(bytes: number): string {
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < UNITS.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${UNITS[unitIndex]}`
}

/**
 * Log-file name for one run: `<ISO timestamp>_<success|failed>.log`.
 *
 * The colon and dot replacement comes from the source: both are legal in an ISO
 * string and both are awkward in a filename on a drive that will be read from a
 * Windows machine. The clock is injected, so the name is asserted, not guessed.
 */
export function backupLogFileName(success: boolean, timestamp: Date): string {
  const stamp = timestamp.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `${stamp}_${success ? "success" : "failed"}.log`
}

/** What {@link saveBackupLog} needs. */
export interface SaveBackupLogOptions {
  /** Filesystem port. Required. */
  fs: FileSystem
  /** Time source for the filename. Required — a fixed clock makes the name assertable. */
  clock: Clock
  /** Mount point of the drive. */
  mountPoint: string
  /** Lines to persist, already formatted. Oldest first. */
  lines: readonly string[]
  /** Whether the run this log describes succeeded. */
  success: boolean
}

/**
 * Append the run log onto the drive and return its path.
 *
 * @throws Whatever the filesystem rejects with — the source swallowed the
 * failure with an empty catch and continued, which is how a backup run reports
 * success while the drive carries no evidence of it.
 */
export async function saveBackupLog(
  options: SaveBackupLogOptions,
): Promise<string> {
  const logDir = `${options.mountPoint}/${LOGS_DIR}`
  const logFile = `${logDir}/${backupLogFileName(options.success, options.clock.now())}`
  await options.fs.mkdir(logDir, { recursive: true })
  await options.fs.writeTextFile(logFile, `${options.lines.join("\n")}\n`)
  return logFile
}

/**
 * Instructions printed into the drive's README under "Quick Restore".
 *
 * Deliberately generic: the drive outlives any one repository checkout, so the
 * README must not tell a reader to run a task that may not exist on the machine
 * they are reading it from.
 */
export const DEFAULT_RESTORE_INSTRUCTIONS =
  "Mount the drive, then restore each directory listed below with:\n" +
  "`rsync -avhP <drive>/<target>/ <local-source>/`"

/** One backup path's measured size, as the README lists it. */
export interface BackupPathSize {
  /** The configured path pair. */
  path: BackupPath
  /** `formatBytes` of the measured size, or `"unknown"`. */
  size: string
}

/**
 * Render the README written onto the drive.
 *
 * Pure by construction — clock, sizes and restore instructions all arrive as
 * arguments, so the exact document is asserted in a test rather than
 * eyeballed. No homelab paths, no package-manager instructions, no
 * source-repo-specific password location: those belong to the caller that knows
 * where it keeps its secrets.
 */
export function formatReadme(
  options: {
    backupPaths: readonly BackupPathSize[]
    totalBytes: number
    now: Date
    nextUpdate: Date
    /** Block printed under "Quick Restore". */
    restoreInstructions?: string
  },
): string {
  const pathsInfo = options.backupPaths
    .map((entry) => `  - ${entry.path.source} → ${entry.path.target} (${entry.size})`)
    .join("\n")
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const instructions = options.restoreInstructions ?? DEFAULT_RESTORE_INSTRUCTIONS

  return `# Offline Backup Drive

This drive contains encrypted backups of critical services.

## Quick Start

**Restore Command:**
\`\`\`bash
${instructions}
\`\`\`

## Handling

Store in a dry, sealed container with desiccant. Keep at 20-25°C, below 60%
humidity, elevated from the floor, away from magnets and water.

---

## Backup Information

**Created:** ${options.now.toISOString().split("T")[0]} ${
    options.now.toTimeString().split(" ")[0]
  } ${timezone}
**Backup Paths:**
${pathsInfo}
**Type:** Restic repositories
**Encryption:** Yes (Restic native encryption)
**Next Update Due:** ${options.nextUpdate.toISOString().split("T")[0]}
**Total Backup Size:** ${
    formatBytes(options.totalBytes)
  } (${options.totalBytes.toLocaleString()} bytes)

### Notes

- Keep the drive in a protective case
- Update on schedule — a stale drive is a single point of failure
- Verify integrity after every sync
`
}

/** What {@link writeReadme} needs. */
export interface WriteReadmeOptions {
  /** Filesystem port. Required. */
  fs: FileSystem
  /** Time source for the "Created" line and the next-update date. Required. */
  clock: Clock
  /** Mount point of the drive. */
  mountPoint: string
  /** Path pairs to list. */
  backupPaths: readonly BackupPath[]
  /**
   * Measures one absolute directory on the drive. Wire
   * `(path) => getBackupSize({ fs, runner, path })` here, or a fake in a test.
   */
  scanSize: (absolutePath: string) => Promise<BackupSize>
  /** Override the "Quick Restore" block. Defaults to {@link DEFAULT_RESTORE_INSTRUCTIONS}. */
  restoreInstructions?: string
  /** Optional logger; the README step is the one place the source announced progress. */
  logger?: Logger
}

/**
 * Measure each target, render the README and write it to the drive root.
 *
 * @returns The path written.
 * @throws When the filesystem rejects.
 */
export async function writeReadme(options: WriteReadmeOptions): Promise<string> {
  const now = options.clock.now()
  const nextUpdate = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
  )

  let totalBytes = 0
  const sizes: BackupPathSize[] = []
  for (const backupPath of options.backupPaths) {
    const measured = await options.scanSize(
      `${options.mountPoint}/${backupPath.target}`,
    )
    totalBytes += measured.bytes
    sizes.push({ path: backupPath, size: measured.human })
  }

  const content = formatReadme({
    backupPaths: sizes,
    totalBytes,
    now,
    nextUpdate,
    restoreInstructions: options.restoreInstructions,
  })

  const readmePath = `${options.mountPoint}/README.md`
  await options.fs.writeTextFile(readmePath, content)
  options.logger?.info(`README written: ${readmePath}`)
  return readmePath
}

/** A target segment may not escape the mount point. */
function assertSafeTarget(target: string, index: number): void {
  if (target.trim() === "") {
    throw new BackupError(`backup path ${index}: target must not be blank`)
  }
  if (target.startsWith("/") || target.includes("/") || target.includes("\\")) {
    throw new BackupError(
      `backup path ${index}: target "${target}" must be a single path segment`,
    )
  }
  if (target === "." || target === "..") {
    throw new BackupError(
      `backup path ${index}: target "${target}" would escape the drive`,
    )
  }
}

/**
 * Parse a `BACKUP_PATHS` JSON array.
 *
 * Stricter than the source, which accepted `{"source": 1, "target": true}` — any
 * truthy non-string passed its `!bp.source` check and reached `path.replace`,
 * failing much later with a `TypeError` that names neither the config nor the
 * entry. `target` is additionally required to be a single segment: it is
 * interpolated into `<mountPoint>/<target>` and then handed to rsync with
 * `--delete`, so `../..` would point a delete at the wrong tree.
 *
 * @throws {BackupError} When the JSON is malformed, the array is empty, or an
 * entry is not `{ source: string, target: string }`.
 */
export function parseBackupPaths(backupPathsJson: string): BackupPath[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(backupPathsJson)
  } catch (error) {
    throw new BackupError(
      `BACKUP_PATHS is not valid JSON: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    )
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new BackupError("BACKUP_PATHS must be a non-empty array")
  }

  const paths: BackupPath[] = []
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new BackupError(`backup path ${index} must be an object`)
    }
    const { source, target } = entry as { source?: unknown; target?: unknown }
    if (typeof source !== "string" || source.trim() === "") {
      throw new BackupError(`backup path ${index}: source must be a non-empty string`)
    }
    if (typeof target !== "string") {
      throw new BackupError(`backup path ${index}: target must be a string`)
    }
    assertSafeTarget(target, index)
    paths.push({ source, target })
  })

  return paths
}

/** What {@link validateBackupSources} needs. */
export interface ValidateBackupSourcesOptions {
  /** Filesystem port. Required — the source called `Deno.stat` directly. */
  fs: FileSystem
  /** Path pairs to check. */
  backupPaths: readonly BackupPath[]
  /**
   * Home directory used to expand a leading `~/`. Required whenever a source
   * starts with `~/`: the source read `Deno.env.get("HOME")` at call time, which
   * is unset in a service, wrong under `sudo`, and untestable. Absent or blank
   * with a `~/` source throws rather than resolving to `/x`.
   */
  home?: string
}

/**
 * Check that every source exists and is a directory.
 *
 * @returns A report; it never throws for a missing source and never exits the
 * process. The source called `Deno.exit(1)` from inside this helper, which makes
 * the caller's own cleanup unreachable and is untestable.
 * @throws {import("../env.ts").MissingEnvError} When a `~/` source has no home.
 */
export async function validateBackupSources(
  options: ValidateBackupSourcesOptions,
): Promise<BackupSourceReport> {
  const missing: string[] = []
  const notDirectories: string[] = []
  const checked: string[] = []

  for (const backupPath of options.backupPaths) {
    const expanded = absPath(backupPath.source, options.home ?? "")
    checked.push(expanded)
    let isDirectory = false
    try {
      isDirectory = (await options.fs.stat(expanded)).isDirectory
    } catch {
      missing.push(expanded)
      continue
    }
    if (!isDirectory) notDirectories.push(expanded)
  }

  return {
    valid: missing.length === 0 && notDirectories.length === 0,
    missing,
    notDirectories,
    checked,
  }
}
