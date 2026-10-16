/**
 * Log lines and a multi-step job for a worker that runs the outbox processor.
 *
 * Ported from `template/libs/server/jobs/job-failures.ts` (`logAttemptFailure`, `cleanupJob`).
 *
 * @module
 */

import type { JobHandler } from "./job-publisher.ts"
import { errorCodeOf, type OutboxAttemptFailure } from "./processor.ts"

/**
 * The log line for one failed attempt of an outbox row, for `OutboxProcessorOptions.onAttemptFailed`:
 *
 * ```ts
 * new OutboxProcessor(repository, publisher, { onAttemptFailed: (f) => log(attemptFailureLine(f)) })
 * ```
 *
 * A `warn:` line for an attempt that will be retried, an `error:` line for the attempt after which
 * the row is given up. It names the row's kind, its aggregate type and id, the attempt, the stage
 * where it failed (`publish`, `markProcessed`, or `lease` for a worker that died mid-run) and the
 * error's name: the one an earlier attempt stored on the row when there is one, else the name of
 * what was thrown, as `errorCodeOf` gives it.
 *
 * Never the error's message: a mail or billing error can quote an address or a provider's answer,
 * and a log is no place for either. A job that wants more in the log writes it itself.
 */
export function attemptFailureLine(failure: OutboxAttemptFailure): string {
  const { event, error, attempt, maxAttempts, lastAttempt, stage, storedErrorCode } = failure
  const what = `outbox row ${event.eventKind} (${event.aggregateType} ${event.aggregateId})`
  const name = storedErrorCode ?? errorCodeOf(error)
  return lastAttempt
    ? `error: ${what} abandoned at ${stage} after ${attempt} attempts: ${name}`
    : `warn: ${what} failed at ${stage}, attempt ${attempt} of ${maxAttempts}: ${name}`
}

/** One step of a {@link stepsJob}: a name for the log, and the work. What it resolves to is ignored. */
export type JobStep = readonly [name: string, run: () => Promise<unknown>]

/**
 * A job made of independent steps, such as a nightly cleanup that purges several tables. It runs
 * every step in order, each on its own, so a step that throws stops no other. Each failure is
 * logged as `error: <label> step "<name>" failed: <message>`, and the job then throws an error
 * naming the failed steps, so the processor retries the whole list. Write every step so that a
 * rerun after a success does nothing harmful, such as "remove what is due".
 *
 * Unlike {@link attemptFailureLine}, the line carries the step's error message, because a
 * maintenance step's error (a missing table, a lock timeout) is what the operator needs. Keep a
 * step whose error can quote personal data out of it, or catch and reword that error inside the
 * step.
 *
 * ```ts
 * const handlers = {
 *   "outbox.cleanup": stepsJob("nightly cleanup", [
 *     ["outbox", () => repository.removeProcessed(7)],
 *     ["sessions", () => removeExpiredSessions(sql)],
 *   ], log),
 * }
 * ```
 */
export function stepsJob(
  label: string,
  steps: readonly JobStep[],
  log: (line: string) => void,
): JobHandler {
  return async () => {
    const failed: string[] = []
    for (const [name, run] of steps) {
      try {
        await run()
      } catch (error) {
        failed.push(name)
        const message = error instanceof Error ? error.message : String(error)
        log(`error: ${label} step "${name}" failed: ${message}`)
      }
    }
    if (failed.length === 0) return
    const names = failed.map((name) => `"${name}"`).join(", ")
    throw new Error(`${label}: ${failed.length} step(s) failed: ${names}`)
  }
}
