/**
 * Retry with exponential backoff, and the non-ASCII header transliteration that
 * `Headers` demands.
 *
 * Kept inside `ops/` rather than shared with `integrations/`: the two packages
 * are owned by different issues (#16 and #18) and must stay file-disjoint, so a
 * 90-line retry loop is duplicated on purpose instead of creating a cross-package
 * dependency that would make both PRs conflict.
 *
 * Everything a test needs is injectable: the delay computation (`backoff`), the
 * waiter (`sleep`), and the elapsed-time source (`clock`). No test sleeps and no
 * test asserts on wall-clock time.
 */

/** Computes a delay. `attempt` is 1-based; `retryAfterMs` wins when present. */
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
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
}

/** Waits a duration. Injected so a test can record instead of sleeping. */
export type Sleeper = (ms: number) => Promise<void>

/** Millisecond time source. */
export type Clock = () => number

/**
 * Default dead-man's-switch policy, from the `rostok` source: **10 tries with
 * 60s doubling**, capped so the whole schedule fits inside healthchecks.io's
 * 1-hour grace window. Waits run 1, 2, 4, then 5 minutes each, totalling 38
 * minutes — a 10-minute cap per wait would need 46 minutes and would overrun
 * the window the cap exists to respect.
 *
 * `totalBudgetMs` is a second, independent ceiling on the whole operation, and
 * it must exceed the sum of the waits or it silently shortens the sequence: at
 * 10 minutes it aborted after the 4th attempt instead of delivering the 10 the
 * policy promises. 40 minutes covers the 38-minute wait schedule below with
 * headroom for per-attempt latency, and still bounds a wedged endpoint.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 300_000,
  totalBudgetMs: 2_400_000,
  jitterRatio: 0,
}

/** Consumes whatever a `Sleeper` returned. A recording timer returns `undefined`. */
export const settle = async (result: void | Promise<void>): Promise<void> => {
  await result
}

/**
 * Parses a `Retry-After` header.
 *
 * Only the delay-seconds form is honoured. The HTTP-date form needs a wall
 * clock, and a skewed client clock would turn a provider hint into a multi-hour
 * stall. Negative and non-numeric values are ignored rather than treated as 0.
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
 * Exponential backoff with optional clamps.
 *
 * `Retry-After` short-circuits the exponent, then the same ceiling applies, so
 * a provider asking for a day cannot pin the caller for a day. With
 * `jitterRatio` at 0 the function is the plain `base * 2 ** (attempt - 1)`
 * always clipped to `[0, maxDelayMs]`. Proof that `Retry-After` is honoured is
 * a test asserting the injected timer was asked for exactly that many
 * milliseconds.
 */
export const createExponentialBackoff =
  (policy: Pick<RetryPolicy, "baseDelayMs" | "maxDelayMs">): BackoffFn =>
  (
    attempt,
    retryAfterMs,
  ) => {
    const raw = retryAfterMs ?? policy.baseDelayMs * 2 ** (attempt - 1)
    return Math.min(Math.max(raw, 0), policy.maxDelayMs)
  }

/** Statuses worth another attempt: rate limiting and upstream faults. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

export interface RetryRunResult<R> {
  /** Attempts performed, including the first. */
  attempts: number
  /** Sum of the delays actually waited. */
  waitedMs: number
  /** Whatever the final `attempt` call returned. */
  result: R
}

export interface RetryRunOptions<R> {
  policy: RetryPolicy
  /** Performs one attempt. `failed: true` requests a retry. */
  attempt: (attempt: number) => Promise<{ failed: boolean; retryAfterMs?: number; value: R }>
  sleep: Sleeper
  clock: Clock
  backoff: BackoffFn
}

/**
 * Runs `attempt` under `policy`.
 *
 * Stops on the first non-failed attempt, when attempts are exhausted, or when
 * the next delay would not fit in `totalBudgetMs` measured from the injected
 * clock. `onDelay` observes every requested delay.
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
    if (!outcome.failed || index === Math.max(policy.maxAttempts, 1)) {
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

// ─── Header safety ────────────────────────────────────────────────────

/**
 * `Headers.set` throws a `TypeError` — "is not a valid ByteString" — for any
 * code point above 0xFF, and it throws inside `fetch`, so the failure surfaces
 * as an opaque request-construction error. Two different needs follow from
 * that, and the `mig` source conflated them:
 *
 *  - A **header value** must be transliterated to printable ASCII. Latin-1
 *    accents, Cyrillic and CJK are not representable, so the characters that
 *    matter for readability are mapped (`—` to `-`, `“` to `"`, `…` to `...`)
 *    and everything else becomes `?`. Whitespace allowed in a header value —
 *    HT, LF, CR, space — is preserved.
 *  - A **message body** must be left alone. `mig` passed the body through the
 *    same sanitiser (`notify.ts:119`), so `Café ☕` reached ntfy as
 *    `Caf? ?` and every accented, Cyrillic, CJK and emoji payload was
 *    destroyed. `toAsciiHeaderValue` is applied to headers only.
 */
export const toAsciiHeaderValue = (value: string): string =>
  // HT, LF, CR, space and printable ASCII are the permitted header characters.
  // deno-lint-ignore no-control-regex
  value.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, (character) => {
    switch (character) {
      case "\u2014":
      case "\u2013":
      case "\u2010":
      case "\u2011":
      case "\u2212":
        return "-"
      case "\u2018":
      case "\u2019":
      case "\u201A":
      case "\u201B":
        return "'"
      case "\u201C":
      case "\u201D":
      case "\u201E":
      case "\u201F":
        return '"'
      case "\u2026":
        return "..."
      case "\u00A0":
      case "\u2007":
      case "\u202F":
        return " "
      default:
        return "?"
    }
  })

/**
 * Builds a `Headers` instance from values that may be non-ASCII.
 *
 * Every value goes through `toAsciiHeaderValue`, so a non-Latin title cannot
 * throw from inside `fetch`. Kept as a function rather than inline `.set`
 * calls so the trap is testable directly, and so the transliteration cannot be
 * dropped from one call site without a test noticing.
 */
export const createAsciiHeaders = (values: Record<string, string>): Headers => {
  const headers = new Headers()
  for (const [name, value] of Object.entries(values)) {
    headers.set(name, toAsciiHeaderValue(value))
  }
  return headers
}
