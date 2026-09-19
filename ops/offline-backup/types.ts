/**
 * The offline-backup contract: the shapes every other module in this directory
 * exchanges, and the ports a caller must supply.
 *
 * Ported from `rostok/scripts/offline-backup/src/types.ts` (26 lines) plus the
 * option bags the rest of the extraction needs. The four data shapes are kept
 * byte-for-byte compatible with the source so a caller can move over without
 * rewriting its config; the ports are new, because the source reached for
 * `Deno.Command`, `Deno.writeTextFile` and `Deno.env` directly and the workspace
 * test task grants none of `--allow-run` or `--allow-write`.
 *
 * A "port" here means a parameter, never a global: `runner`, `fs`, `logger`,
 * `env`, `sleep`, `confirm`, `clock`, `scanSize`. Nothing in this directory
 * touches `Deno.env`, the wall clock, a stream or the process table at module
 * scope, so importing a module has no effect and every decision is a test.
 */

import type { Clock, Logger } from "../console.ts"
import type { EnvReader } from "../env.ts"
import type { FileSystem } from "../fs.ts"
import type { CommandRunner } from "../run-command.ts"

/** One local directory mirrored onto the drive. */
export interface BackupPath {
  /** Local source, possibly starting with `~/`. */
  source: string
  /** Single path segment appended to the mount point on the drive. */
  target: string
}

/** One physical disk as reported by `lsblk`. */
export interface DriveInfo {
  /** Kernel name, e.g. `sdb`. Never a path — a caller composes `/dev/<name>` itself. */
  name: string
  /** Human size as `lsblk` printed it, e.g. `931.5G`. Not re-parsed. */
  size: string
  /** Model string, spaces preserved. */
  model: string
  /** `lsblk` TYPE column. `listDrives` only returns `disk`. */
  type: string
}

/** Outcome of one restic repository check. */
export interface VerificationDetail {
  /** `<target>/<repo-directory-name>`. */
  name: string
  /** Verdict for this repository. */
  status: "passed" | "failed" | "skipped"
  /** First stderr line, present only when `status` is `failed`. */
  error?: string
}

/** Tally over every repository found on the drive. */
export interface VerifyResults {
  /** Repositories restic confirmed. */
  passed: number
  /** Repositories `restic check` rejected. */
  failed: number
  /** Directories that were not repositories (no `config` file). */
  skipped: number
  /** One entry per directory examined, in discovery order. */
  details: VerificationDetail[]
}

/** Directory on the drive holding run logs, relative to the mount point. */
export const LOGS_DIR = "logs"

/** Default directory holding block devices. Overridable for a test or a chroot. */
export const DEFAULT_DEV_DIR = "/dev"

/** Suffix appended to a disk device to name its first partition on `sd*`/`vd*`/`hd*`. */
export const DEFAULT_PARTITION_SUFFIX = "1"

/**
 * Answers a yes/no question.
 *
 * This is the whole point of the port: the source called `prompt()` from inside
 * library functions, which throws outside a TTY and cannot be answered by a
 * test or a cron job. A caller attaches its own UI (readline, a Slack prompt, a
 * flag) and passes it here. A driver that has no console **omits** this port and
 * the function that needs it throws {@link ConfirmRequiredError} instead of
 * blocking — an unattended run must fail loudly, never guess "yes".
 */
export type ConfirmFn = (question: string) => boolean | Promise<boolean>

/**
 * Pause for `ms`.
 *
 * Injected because two pieces of the source cannot be tested without it: the
 * two-second post-`parted` wait for udev to settle, and the four-minute SMART
 * poll. A test passes a no-op; the real caller passes
 * `(ms) => new Promise((r) => setTimeout(r, ms))`, which lives in *its* code,
 * not here.
 */
export type SleepFn = (ms: number) => Promise<void>

/**
 * Injected side-channel ports, shared by every options bag in this directory.
 *
 * Kept as one interface so a caller builds it once and spreads it into every
 * call, and so a test helper constructs it in one line.
 */
export interface OfflineBackupPorts {
  /** Runs every external process. Required. */
  runner: CommandRunner
  /** Reads directories and writes files. Required. */
  fs: FileSystem
  /** The package's one logging convention. Required. */
  logger: Logger
  /** Reads environment values. Only needed for `restoreWorkflow`, which resolves a source's home. */
  env?: EnvReader
  /** Pause. Only `formatDrive` and `runSmartCheck` need it. */
  sleep?: SleepFn
  /** Yes/no prompt. Omitted in a non-interactive run; that is a supported state. */
  confirm?: ConfirmFn
  /** Time source. Defaults to the system clock at the call site that needs one. */
  clock?: Clock
}

/** Raised by {@link ConfirmRequiredError} for a decision that had no console to answer it. */
export class ConfirmRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfirmRequiredError"
  }
}

/**
 * Raised for a malformed backup-path list, an unusable drive, or a failed
 * external step.
 *
 * One class rather than the source's bare `Error`: a caller that wants to
 * triage "the config was wrong" from "rsync failed halfway" can, and the
 * `name` survives `JSON.stringify` of a log line.
 */
export class BackupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "BackupError"
  }
}

/** One backup source a caller asked us to mirror, with its resolved local path. */
export interface ResolvedBackupPath extends BackupPath {
  /** `source` with a leading `~/` expanded against the injected home directory. */
  resolvedSource: string
  /** `<mountPoint>/<target>`. */
  targetDir: string
}

/** What {@link validateBackupSources} reports. Never throws, never exits. */
export interface BackupSourceReport {
  /** True when every source resolved to an existing directory. */
  valid: boolean
  /** Sources that resolved to an existing path that is not a directory. */
  notDirectories: string[]
  /** Sources that do not exist at all. */
  missing: string[]
  /** Every expanded path examined, in input order — handy in a log line. */
  checked: string[]
}

/** Size of one directory on the drive. */
export interface BackupSize {
  /** Bytes, or `0` when the measurement failed. */
  bytes: number
  /** {@link formatBytes} of `bytes`, or `"unknown"` when the measurement failed. */
  human: string
}

/** Result of one restic repository check, before it is folded into {@link VerifyResults}. */
export interface RepoCheck {
  /** Repository path on the drive. */
  repo: string
  /** `restic check` exited `0`. */
  success: boolean
  /** First stderr line, for the failure detail. */
  error: string
}

/** The three drive-health checks a caller can ask for, plus "skip". `verify` chooses. */
export type SmartTestType = "short" | "long"

/** Progress line parsed out of rsync's `--info=progress2` output. */
export interface RsyncProgress {
  /** Percent complete, 0-100. */
  percent: number
  /** Byte figure rsync printed, e.g. `1.23G`. Absent when the line carried none. */
  size?: string
  /** Rate rsync printed, e.g. `12.34MB/s`. Absent when the line carried none. */
  speed?: string
}
