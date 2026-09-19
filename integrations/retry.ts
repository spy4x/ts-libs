/**
 * Transport retry policy shared by the `integrations/` clients.
 *
 * Every knob a test needs is injectable: the delay function (`backoff`), the
 * waiter (`sleep`) and the elapsed-time source (`clock`). Production defaults
 * are real; a test supplies a recording timer and a manual clock, so no test
 * ever sleeps and no test asserts against wall-clock time.
 */

/**
 * Computes a delay. `attempt` is 1-based; `retryAfterMs` is set when the
 * provider sent a parseable `Retry-After` header, which wins over backoff.
 */
export type BackoffFn = (attempt: number, retryAfterMs?: number) => number

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  maxAttempts: number
  /** Delay before the second attempt. */
  baseDelayMs: number
  /** Ceiling for a single delay. */
  maxDelayMs: number
  /** Wall-clock ceiling for the whole operation, measured with `clock`. */
  totalBudgetMs: number
  /** Symmetric jitter fraction applied to a computed backoff, 0 to 1. */
  jitterRatio: number
  /** Receives every requested delay, in order. Defaults to nothing. */
  onDelay?: (delayMs: number, attempt: number) => void
}

/** Real-time scale, in front of a `Clock`. */
export type Sleeper = (ms: number) => Promise<void>

/** Monotonic-enough millisecond source. */
export type Clock = () => number

/**
 * Consumes whatever a `Sleeper` returned.
 *
 * A test's recording timer is synchronous and returns `undefined`, which would
 * otherwise leave `await` on a non-promise and trip type-checking in callers.
 */
export const settle = async (result: void | Promise<void>): Promise<void> => {
  await result
}

/**
 * Parses a `Retry-After` header.
 *
 * Only the delay-seconds form is honoured; the HTTP-date form is ignored
 * because it needs a wall clock, and a skewed client clock would turn a
 * provider hint into a multi-hour stall. A negative or non-numeric value is
 * ignored rather than treated as zero.
 */
export const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }
  const seconds = Number(value.trim())
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined
  }
  return Math.round(seconds * 1000)
}

/**
 * Exponential backoff, clamped and optionally jittered.
 *
 * `Retry-After` short-circuits the computation, then the same clamps apply so a
 * hostile or buggy provider cannot pin a process for a week. Jitter is
 * deterministic per `(attempt, retryAfterMs)` so the function stays pure and a
 * test can assert its exact output.
 */
export const createExponentialBackoff =
  (policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs" | "jitterRatio">): BackoffFn =>
  (attempt, retryAfterMs) => {
    const raw = retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1)
    const clamped = Math.min(Math.max(raw, 0), policy.maxDelayMs)
    if (policy.jitterRatio <= 0) {
      return clamped
    }
    const span = clamped * policy.jitterRatio
    const seed = (attempt * 2654435761 + (retryAfterMs ?? 0)) % 1000
    const jitter = (seed / 1000) * 2 * span - span
    return Math.round(
      Math.min(Math.max(clamped + jitter, policy.baseDelayMs > 0 ? 1 : 0), policy.maxDelayMs),
    )
  }

/** Statuses worth another attempt: rate limiting and upstream faults. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

/** Statuses that will never succeed on a retry: the request itself is wrong. */
export const isPermanentStatus = (status: number): boolean => status >= 400 && status < 500

export interface RetryRunResult<R> {
  /** Attempts performed, including the first. */
  attempts: number
  /** Sum of the delays actually waited before retrying. */
  waitedMs: number
  /** Whatever the final `attempt` call returned. */
  result: R
}

export interface RetryRunOptions<R> {
  policy: RetryPolicy
  /** Performs one attempt. Return `{ failed: true }` to request a retry. */
  attempt: (attempt: number) => Promise<{ failed: boolean; retryAfterMs?: number; value: R }>
  sleep: Sleeper
  clock: Clock
  backoff: BackoffFn
}

/**
 * Runs `attempt` under `policy`.
 *
 * Stops on the first non-failed attempt, when attempts are exhausted, or when
 * the next delay cannot fit in `totalBudgetMs` measured from the injected
 * clock. `onDelay` sees every requested delay, which is how the retry tests
 * assert "asked for exactly 2 seconds" without waiting.
 */
export const runWithRetry = async <R>(options: RetryRunOptions<R>): Promise<RetryRunResult<R>> => {
  const { policy, attempt, sleep, clock, backoff } = options
  const startedAt = clock()
  let attempts = 0
  let waitedMs = 0
  let lastValue: R | undefined

  for (let index = 1; index <= Math.max(policy.maxAttempts, 1); index++) {
    attempts = index
    const outcome = await attempt(index)
    lastValue = outcome.value
    if (!outcome.failed) {
      break
    }
    if (index === policy.maxAttempts) {
      break
    }
    const delayMs = backoff(index, outcome.retryAfterMs)
    if (clock() - startedAt + delayMs > policy.totalBudgetMs) {
      break
    }
    policy.onDelay?.(delayMs, index)
    waitedMs += delayMs
    await settle(sleep(delayMs))
  }

  return { attempts, waitedMs, result: lastValue as R }
}
