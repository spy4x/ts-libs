/**
 * Drive verification: measure a target, check every restic repository, run a
 * SMART self-test.
 *
 * Ported from `rostok/scripts/offline-backup/src/verify.ts` (285 lines). Every
 * external effect goes through a port, and every piece of output parsing is a
 * separate pure function so it is unit-tested without a command.
 */

import type { Clock } from "../console.ts"
import type { FileSystem } from "../fs.ts"
import { runCommand } from "../run-command.ts"
import type { CommandOptions, CommandRunner } from "../run-command.ts"
import { formatBytes } from "./helpers.ts"
import {
  BackupError,
  type BackupPath,
  type BackupSize,
  ConfirmRequiredError,
  type OfflineBackupPorts,
  type RepoCheck,
  type SleepFn,
  type SmartTestType,
  type VerificationDetail,
  type VerifyResults,
} from "./types.ts"

/** Environment variable restic reads its repository password from. */
export const RESTIC_PASSWORD_VAR = "RESTIC_PASSWORD"

/** First line of a command's stderr, for a one-line failure detail. */
function firstErrorLine(error: string): string {
  return error.split("\n")[0]?.trim() ?? ""
}

/**
 * Parse the byte count out of `du -sb` output.
 *
 * A tab separates the size from the path, but that tab is gone if the path is
 * rewritten by a wrapper, and a locale can put the path first. The first
 * unsigned integer in the output is the size in every layout observed; a line
 * with no digits is `null`, not `0`, because "could not measure" and "empty
 * directory" are different answers and the caller reports them differently.
 */
export function parseDuBytes(output: string): number | null {
  const match = output.match(/\d+/)
  if (match === null) return null
  const bytes = Number.parseInt(match[0], 10)
  return Number.isSafeInteger(bytes) ? bytes : null
}

/**
 * Measure one directory on the drive.
 *
 * @returns `{ bytes: 0, human: "unknown" }` when `du` fails or prints nothing —
 * the source did the same, and a drive that cannot be measured must not abort a
 * verification that is otherwise fine.
 * @throws {BackupError} Never; a failure is reported in the result.
 */
export async function getBackupSize(
  options: { runner: CommandRunner; path: string },
): Promise<BackupSize> {
  const result = await runCommand(options.runner, ["du", "-sb", options.path])
  if (!result.success) {
    return { bytes: 0, human: "unknown" }
  }
  const bytes = parseDuBytes(result.output)
  if (bytes === null) {
    return { bytes: 0, human: "unknown" }
  }
  return { bytes, human: formatBytes(bytes) }
}

/** One directory on the drive and whether it looks like a restic repository. */
export interface RepoScan {
  /** `<target>/<directory name>` entries that hold a restic `config` (or a `keys` dir). */
  repos: string[]
  /** Details for directories that were skipped, ready to merge into the results. */
  skipped: VerificationDetail[]
  /** The target directory itself could not be listed. */
  unreadable: string | null
}

/**
 * Classify the direct children of one target directory as restic repositories.
 *
 * A repository is identified by a `config` file, exactly as the source did. The
 * source ran `Deno.stat` in a bare `try/catch` per entry; here a missing
 * `config` is an expected answer and is reported as `skipped` rather than
 * silently swallowed, so a drive full of non-repositories shows up in the tally
 * instead of reading as "nothing to verify".
 */
export async function scanTargetForRepos(
  fs: FileSystem,
  targetDir: string,
  targetName: string,
): Promise<RepoScan> {
  let entries
  try {
    entries = await fs.readDir(targetDir)
  } catch (error) {
    return { repos: [], skipped: [], unreadable: `${targetDir}: ${error}` }
  }

  const repos: string[] = []
  const skipped: VerificationDetail[] = []
  for (const entry of entries) {
    if (!entry.isDirectory) continue
    const repo = `${targetDir}/${entry.name}`
    try {
      await fs.stat(`${repo}/config`)
      repos.push(repo)
    } catch {
      skipped.push({ name: `${targetName}/${entry.name}`, status: "skipped" })
    }
  }

  return { repos, skipped, unreadable: null }
}

/** What {@link verifyBackups} needs. */
export interface VerifyBackupsOptions extends OfflineBackupPorts {
  /** Mount point of the drive. */
  mountPoint: string
  /** Path pairs to verify. Only those present on the drive are examined. */
  backupPaths: readonly BackupPath[]
  /**
   * Restic repository password.
   *
   * Passed to the child through `CommandOptions.env`, never through
   * `Deno.env.set`. The source cached the previous `RESTIC_PASSWORD`, overwrote
   * the process environment, and restored it in a `finally` — a global write that
   * another concurrent `restic` in the same process sees, and that leaks the
   * password to every child of the process for the duration.
   */
  resticPassword: string
  /** Read every byte (`restic check --read-data`) instead of structure only. Defaults to `false`. */
  fullVerification?: boolean
}

/**
 * Run `restic check` against every repository found under each target.
 *
 * @throws {ConfirmRequiredError} When `restic` is not on `PATH` and no `confirm`
 * port is supplied. The source called `prompt()` here, which throws
 * `TypeError: prompt is not defined` outside a TTY; a caller that accepts the
 * risk passes a `confirm` that answers `true`.
 * @throws {BackupError} Never for a failed repository — failures are counted in
 * the result, which is the point of verification.
 */
export async function verifyBackups(
  options: VerifyBackupsOptions,
): Promise<VerifyResults> {
  const results: VerifyResults = { passed: 0, failed: 0, skipped: 0, details: [] }

  const restic = await runCommand(options.runner, ["which", "restic"])
  if (!restic.success) {
    options.logger.warn("restic not found — backup integrity cannot be verified")
    const accepted = await acceptMissingRestic(options)
    if (!accepted) {
      throw new BackupError("restic is required to verify backups and was not found")
    }
    return results
  }

  for (const backupPath of options.backupPaths) {
    const targetDir = `${options.mountPoint}/${backupPath.target}`
    const scan = await scanTargetForRepos(options.fs, targetDir, backupPath.target)
    if (scan.unreadable !== null) {
      options.logger.warn(`Could not list repositories in ${backupPath.target}: ${scan.unreadable}`)
      continue
    }
    if (scan.skipped.length > 0) {
      results.skipped += scan.skipped.length
      results.details.push(...scan.skipped)
    }
    if (scan.repos.length === 0) {
      options.logger.info(`No restic repositories in ${backupPath.target}`)
      continue
    }

    for (const repo of scan.repos) {
      const name = `${backupPath.target}/${repo.split("/").pop() ?? "unknown"}`
      const check = await checkRepository(options, repo)
      if (check.success) {
        options.logger.info(`${name}: OK`)
        results.passed++
        results.details.push({ name, status: "passed" })
      } else {
        const error = firstErrorLine(check.error)
        options.logger.error(`${name}: FAILED — ${error}`)
        results.failed++
        results.details.push({ name, status: "failed", error })
      }
    }
  }

  if (results.failed > 0) {
    options.logger.warn(`${results.failed} repository verification(s) failed`)
  }
  return results
}

/** Ask the caller whether to continue without restic; a missing port is a hard stop. */
async function acceptMissingRestic(options: VerifyBackupsOptions): Promise<boolean> {
  if (options.confirm === undefined) {
    throw new ConfirmRequiredError(
      "restic is not installed and no confirm port was supplied to accept verification without it",
    )
  }
  return await options.confirm("restic is not installed. Skip verification anyway?")
}

/** Run `restic check` for one repository, with the password on the child's env only. */
async function checkRepository(
  options: VerifyBackupsOptions,
  repo: string,
): Promise<RepoCheck> {
  const commandOptions: CommandOptions = {
    env: { [RESTIC_PASSWORD_VAR]: options.resticPassword },
  }
  const argv = [
    "restic",
    "-r",
    repo,
    "check",
    ...(options.fullVerification === true ? ["--read-data"] : []),
  ]
  const result = await runCommand(options.runner, argv, commandOptions)
  return { repo, success: result.success, error: result.error }
}

/** Default poll interval for a SMART self-test. */
export const SMART_POLL_INTERVAL_MS = 4 * 60 * 1000
/** Default estimated duration, in minutes, of a `short` self-test. */
export const SMART_SHORT_MINUTES = 2
/** Default estimated duration, in minutes, of a `long` self-test. */
export const SMART_LONG_MINUTES = 390

/** Estimated duration of a self-test, in minutes. */
export function estimatedSmartMinutes(type: SmartTestType): number {
  return type === "short" ? SMART_SHORT_MINUTES : SMART_LONG_MINUTES
}

/** True while `smartctl -a` says the routine is still going. */
export function smartTestRunning(statusOutput: string): boolean {
  return statusOutput.includes("Self-test routine in progress") ||
    statusOutput.includes("% of test remaining")
}

/**
 * True when `smartctl -t` output says the test was started.
 *
 * The source checked three literals because three smartmontools releases phrase
 * it three ways; all three are kept.
 */
export function smartTestStarted(startOutput: string): boolean {
  return startOutput.includes("Self-test execution status") ||
    startOutput.includes("has begun") ||
    startOutput.includes("Testing has begun")
}

/**
 * Number of completed self-test rows.
 *
 * A row is `# 1  Short offline …`. Completion itself is decided by
 * {@link selfTestAdvanced}, because smartctl keeps a bounded log and overwrites
 * the oldest row, so the count can stay identical while a new test has
 * demonstrably finished.
 */
export function countSelfTestRows(selftestOutput: string): number {
  let count = 0
  for (const line of selftestOutput.split("\n")) {
    if (/^\s*#\s*\d+/.test(line)) count++
  }
  return count
}

/** The `# N` of the most recent self-test row, or `null` when the log is empty. */
export function latestSelfTestNumber(selftestOutput: string): number | null {
  for (const line of selftestOutput.split("\n")) {
    const match = line.match(/^\s*#\s*(\d+)/)
    if (match === null) continue
    const number = Number.parseInt(match[1], 10)
    if (Number.isSafeInteger(number)) return number
  }
  return null
}

/**
 * True when the self-test log shows a test that was not there before.
 *
 * This is the completion signal, and it is why the number is compared instead of
 * the row count: smartctl keeps a bounded log, so once that log is full the count
 * never changes and a count-only check cannot see that the test finished. The
 * source compared counts, so a finished `long` test kept it polling to the 585
 * minute ceiling.
 */
export function selfTestAdvanced(
  selftestOutput: string,
  previousNumber: number | null,
): boolean {
  const number = latestSelfTestNumber(selftestOutput)
  if (number === null) return false
  if (previousNumber === null) return true
  return number !== previousNumber
}

/** `percentage` from a `NN% of test remaining` line, or `null`. */
export function parseRemainingPercent(statusOutput: string): number | null {
  const match = statusOutput.match(/(\d+)% of test remaining/)
  if (match === null) return null
  const percent = Number.parseInt(match[1], 10)
  return Number.isSafeInteger(percent) ? percent : null
}

/** Health verdict from a `smartctl -a` report, or `null` when the line is absent. */
export function parseSmartHealth(attributeOutput: string): string | null {
  const match = attributeOutput.match(/SMART overall-health.*:\s*(.+)/)
  const health = match?.[1]?.trim()
  return health === undefined || health === "" ? null : health
}

/**
 * The `SMART Self-test log` block, at most eight lines, joined with newlines.
 *
 * Eight because that is what the source printed, and a full self-test log is
 * hundreds of lines that bury the result the operator is looking for.
 */
export function extractSelfTestLog(attributeOutput: string, maxLines = 8): string {
  const start = attributeOutput.indexOf("SMART Self-test log")
  if (start === -1) return ""
  return attributeOutput
    .slice(start)
    .split("\n")
    .slice(0, maxLines)
    .filter((line) => line.trim() !== "")
    .join("\n")
}

/**
 * Fold a `smartctl -a` report into the text a caller stores in its run log.
 *
 * @returns A newline-separated summary. `"Could not retrieve SMART results"` for
 * an empty report, matching the source's message.
 */
export function summariseSmartReport(attributeOutput: string): string {
  if (attributeOutput.trim() === "") return "Could not retrieve SMART results"
  const lines: string[] = []
  const health = parseSmartHealth(attributeOutput)
  if (health !== null) lines.push(`Overall Health: ${health}`)
  const log = extractSelfTestLog(attributeOutput)
  if (log !== "") lines.push(log)
  return lines.length === 0 ? "Could not retrieve SMART results" : `${lines.join("\n")}\n`
}

/** What {@link runSmartCheck} needs. */
export interface RunSmartCheckOptions extends OfflineBackupPorts {
  /** Block device to test, e.g. `/dev/sdb`. */
  device: string
  /** Self-test kind. */
  type: SmartTestType
  /** Poll interval. Defaults to {@link SMART_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number
  /** Milliseconds after which monitoring gives up. Defaults to 1.5x the estimate. */
  maxWaitMs?: number
  /** Maximum number of status polls. Defaults to 150 — the bound that stops a run that never finishes. */
  maxPolls?: number
}

/**
 * Start a SMART self-test and poll until it finishes, then return the report.
 *
 * @returns The summary text, or `""` when the test could not be started — the
 * source's convention, kept so a caller can treat `""` as "inconclusive".
 * @throws {BackupError} When no `sleep`, `clock` or bound is available to poll
 * with. The source slept with `setTimeout` and measured with `Date.now()`, so the
 * function was untestable and, with `maxPolls` unbounded here, a wrong status
 * string would spin forever.
 */
export async function runSmartCheck(options: RunSmartCheckOptions): Promise<string> {
  const sleep = requireSleep(options)
  const clock = requireClock(options)

  const available = await runCommand(options.runner, ["which", "smartctl"])
  if (!available.success) {
    options.logger.warn("smartctl not found — drive health cannot be checked")
    return ""
  }

  const estimatedMinutes = estimatedSmartMinutes(options.type)
  options.logger.info(
    `Running SMART ${options.type} test on ${options.device} (~${estimatedMinutes} min)`,
  )

  if (!(await refreshSudo(options.runner))) {
    options.logger.warn("sudo authentication failed — SMART test not started")
    return ""
  }

  const started = await runCommand(
    options.runner,
    ["smartctl", "-t", options.type, options.device],
    { sudo: true },
  )
  if (!smartTestStarted(started.output)) {
    options.logger.warn(
      `SMART test did not start: ${started.error.trim() || started.output.trim()}`,
    )
    return ""
  }

  const before = await runCommand(
    options.runner,
    ["smartctl", "-l", "selftest", options.device],
    { sudo: true },
  )
  const initialNumber = latestSelfTestNumber(before.output)

  const intervalMs = options.pollIntervalMs ?? SMART_POLL_INTERVAL_MS
  const maxWaitMs = options.maxWaitMs ?? Math.round(estimatedMinutes * 60 * 1000 * 1.5)
  const maxPolls = options.maxPolls ?? 150
  const start = clock.now().getTime()

  for (let poll = 0; poll < maxPolls; poll++) {
    if (!(await refreshSudo(options.runner))) {
      options.logger.warn("sudo authentication failed — SMART monitoring stopped")
      break
    }

    const status = await runCommand(
      options.runner,
      ["smartctl", "-a", options.device],
      { sudo: true },
    )
    const statusOutput = `${status.output}${status.error}`
    const elapsed = clock.now().getTime() - start

    if (!smartTestRunning(statusOutput)) {
      const selftest = await runCommand(
        options.runner,
        ["smartctl", "-l", "selftest", options.device],
        { sudo: true },
      )
      if (selfTestAdvanced(selftest.output, initialNumber)) {
        options.logger.info(`SMART test finished after ${Math.floor(elapsed / 60000)} min`)
        break
      }
    }

    if (elapsed > maxWaitMs) {
      options.logger.warn("SMART test is taking longer than expected — check manually")
      break
    }

    await sleep(intervalMs)
  }

  const report = await runCommand(
    options.runner,
    ["smartctl", "-a", options.device],
    { sudo: true },
  )
  const summary = summariseSmartReport(report.output)
  if (summary === "Could not retrieve SMART results") {
    options.logger.warn("Could not retrieve SMART results")
  }
  return summary
}

/** True when `sudo -v` succeeded, i.e. the credential cache is warm. */
async function refreshSudo(runner: CommandRunner): Promise<boolean> {
  const result = await runCommand(runner, ["-v"], { sudo: true })
  return result.success
}

/**
 * The sleep port, or a refusal.
 *
 * A no-op default would be worse than an error: a caller that forgot the port
 * would hammer `smartctl` in a tight loop and call it success.
 */
function requireSleep(options: RunSmartCheckOptions): SleepFn {
  if (options.sleep === undefined) {
    throw new BackupError("runSmartCheck needs a sleep port to poll with")
  }
  return options.sleep
}

/** The clock port, or a refusal. `Date.now()` is not called anywhere in this package. */
function requireClock(options: RunSmartCheckOptions): Clock {
  if (options.clock === undefined) {
    throw new BackupError("runSmartCheck needs a clock port to measure elapsed time")
  }
  return options.clock
}
