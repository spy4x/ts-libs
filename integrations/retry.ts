/**
 * Transport retry policy, shared by every client in this package.
 *
 * Until `#67`, this file was byte-identical to `ops/notify/retry.ts`: the two
 * packages were owned by different issues (#16 and #18) and deliberately did
 * not import from a packages directory neither owned, so the module was
 * copied rather than shared, guarded by a test that compared the two files'
 * bytes. `ops/` was removed and its copy of `ntfy.ts`/`healthchecks.ts` moved
 * here, so this is now the only copy, and the drift test is gone with it.
 *
 * Everything a test needs is injectable: the delay function (`backoff`), the
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
  /** Total attempts, including the first. 1 or fewer disables retrying. */
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

/** Waits a duration. Injected so a test can record instead of sleeping. */
export type Sleeper = (ms: number) => Promise<void>

/** Millisecond time source. */
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
 * Bounds a single outgoing request, used by every client in this package
 * unless a caller overrides it.
 *
 * Before this constant existed, no client attached a timeout to `fetch` at
 * all: `totalBudgetMs` only stopped new *retries* from being scheduled, so a
 * server that accepted a connection and never answered blocked the caller
 * forever. 10s comfortably covers a slow but healthy endpoint without leaving
 * a caller blocked for anywhere near as long as a typical `totalBudgetMs`.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/**
 * True when `cause` is the `TimeoutError` an `AbortSignal.timeout()` firing
 * produces.
 *
 * Safe to use as "this attempt timed out": no client in this package accepts
 * a caller-supplied `AbortSignal`, so the only abort a client's own `fetch`
 * can ever reject with is its own timeout firing, never an unrelated
 * cancellation.
 */
export const isRequestTimeout = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "TimeoutError"

/**
 * Releases a response's body without reading it.
 *
 * Every client here reports only the status line — `httpStatus`,
 * `statusText` — and never the body, so nothing ever calls `.text()` or
 * `.json()` on a response. Left alone, an unconsumed body keeps its
 * connection open until the runtime's garbage collector gets around to it,
 * which a loop that can make ten attempts should not depend on. `cancel()`
 * releases it immediately; a `null` body (already empty) needs nothing.
 */
export const releaseResponseBody = async (response: Response): Promise<void> => {
  if (response.body !== null) {
    await response.body.cancel()
  }
}

/**
 * Parses a `Retry-After` header.
 *
 * Only the delay-seconds form is honoured; the HTTP-date form is ignored
 * because it needs a wall clock, and a skewed client clock would turn a
 * provider hint into a multi-hour stall.
 *
 * A missing header, a blank header (`""`, `" "`) and a negative or non-numeric
 * value all return `undefined`, meaning "no hint" — the caller's backoff
 * applies. Returning `0` for a blank header would delete all backoff, because
 * `0` is a valid delay; the trim is what separates "absent" from "zero".
 */
export const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (value === null) {
    return undefined
  }
  const trimmed = value.trim()
  if (trimmed === "") {
    return undefined
  }
  const seconds = Number(trimmed)
  if (!Number.isFinite(seconds) || seconds < 0) {
    return undefined
  }
  return Math.round(seconds * 1000)
}

/**
 * Exponential backoff, clamped and optionally jittered.
 *
 * `Retry-After` short-circuits the computation, then the same clamps apply so a
 * hostile or buggy provider cannot pin a process for a week.
 *
 * Jitter is **deterministic**, derived from `(attempt, retryAfterMs)` rather
 * than from a random source: the function stays pure, a test can assert its
 * exact output, and a retry test does not become a flake. That is a deliberate
 * departure from the usual randomised jitter — the goal here is only to
 * de-synchronise callers that start together, and a per-attempt constant
 * achieves that.
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
    const floor = policy.baseDelayMs > 0 ? 1 : 0
    return Math.round(Math.min(Math.max(clamped + jitter, floor), policy.maxDelayMs))
  }

/** Statuses worth another attempt: rate limiting and upstream faults. */
export const isTransientStatus = (status: number): boolean => status === 429 || status >= 500

/** Statuses that will never succeed on a retry: the request itself is wrong. */
export const isPermanentStatus = (status: number): boolean => status >= 400 && status < 500

/**
 * Describes a transport failure **without** the request URL.
 *
 * A webhook URL and a healthchecks ping URL both carry their credential in the
 * path, and `fetch` puts the whole thing in its error text
 * (`Invalid URL: 'https://hooks.slack.example.invalid/services/T/B/token'`).
 * Returning `cause.message` therefore returned the secret. The error's own
 * `name` and a fixed description are enough to diagnose a transport failure;
 * the URL belongs in the caller's debugger, not in a value that gets logged,
 * rendered into a UI or pasted into an issue.
 *
 * Only a `name` that is a string at runtime is interpolated. `Error.name` is a
 * writable property, so a caller controls the value as well as the text: a
 * non-string falls back to the plain description instead of becoming
 * `"null: …"` or `"42: …"`, and a `Symbol` cannot throw out of the template
 * literal. See `readErrorName`.
 */
export const describeTransportError = (cause: unknown): string => {
  const name = readErrorName(cause)
  if (name !== undefined && name !== "Error") {
    return `${name}: transport failure (url withheld)`
  }
  return "transport failure (url withheld)"
}

/**
 * The error-class names `describeErrorKind` may report.
 *
 * A closed set, so the value cannot carry caller text; see the docstring below.
 */
const ERROR_CLASS_NAMES: ReadonlySet<string> = new Set([
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
])

/**
 * Names an error's class without its message.
 *
 * For failures where the message is caller-controlled text — a `JSON.stringify`
 * that hit a hostile `toJSON` or getter — the class is the safe half. What
 * makes it safe is the **allowlist** below, not the fact that it is a name:
 * `name` is a writable property, so an `Error` the caller crafted can carry an
 * arbitrary string in it. An earlier version of this function admitted any
 * `/^[A-Za-z]{1,32}$/` instead, which let 32 caller-chosen letters
 * (`name: "REALTOKENISH"`) reach a returned, loggable result; only the classes
 * the platform itself throws may be reported now. Anything not an `Error` is
 * reported as `Error`, never stringified, because `String(value)` on an
 * arbitrary thrown value can run a `toString` the caller supplied.
 */
export const describeErrorKind = (cause: unknown): string => {
  const name = readErrorName(cause)
  if (name !== undefined && ERROR_CLASS_NAMES.has(name)) {
    return name
  }
  return "Error"
}

/**
 * Reads `cause.name`, or `undefined` unless that read yields a string.
 *
 * Both halves are load-bearing. The **read** is guarded because `name` is not a
 * data property: a hostile `Error` subclass can define it as a throwing getter,
 * and an ordinary property read would then propagate that throw out of a
 * function whose whole contract is to *return* a description. `send` promises a
 * `SlackResult` and never a rejection, so an unguarded read here is the
 * difference between a failure result and an exception on the caller's stack.
 *
 * The **value** is type-checked because `Error.name`'s `string` is a
 * declaration, not a runtime invariant — the property is writable, so whatever
 * the caller stored arrives here. A `Symbol` is the sharpest case: `${name}`
 * throws `TypeError: Cannot convert a Symbol value to a string`, which
 * re-opened the rejection the guard above exists to close. A
 * non-string-but-stringifiable value (`null`, `42`, an object) is refused too
 * rather than coerced, and the ruling is the same one `describeErrorKind`
 * follows: `name` is caller text and the field it feeds is a returned, loggable
 * string, so "not a string" means the plain `transport failure (url withheld)`
 * wording rather than `"null: transport failure (url withheld)"` or `"42: …"`.
 * The only name either caller interpolates is one that was a string to begin
 * with.
 */
const readErrorName = (cause: unknown): string | undefined => {
  try {
    if (!(cause instanceof Error)) {
      return undefined
    }
    // Annotated `unknown`: the declared type would make the check below a
    // compile-time no-op instead of a runtime one.
    const name: unknown = cause.name
    return typeof name === "string" ? name : undefined
  } catch {
    return undefined
  }
}

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
  /**
   * Performs one attempt. Return `{ failed: true }` to request a retry.
   *
   * `remainingBudgetMs` is `totalBudgetMs` minus the elapsed time so far,
   * floored at 0. A caller that issues a real request should bound it with
   * `Math.min(itsOwnTimeout, remainingBudgetMs)`: without that, `totalBudgetMs`
   * only ever stopped a *future* retry from being scheduled, so a single
   * attempt with its own generous timeout could still run well past the
   * budget it was supposed to respect.
   */
  attempt: (
    attempt: number,
    remainingBudgetMs: number,
  ) => Promise<{ failed: boolean; retryAfterMs?: number; value: R }>
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
 *
 * `maxAttempts <= 0` is treated as **one** attempt, not zero: a policy that
 * performs no attempt at all would have no result to report, and the two
 * copies of this module previously disagreed about that.
 */
export const runWithRetry = async <R>(options: RetryRunOptions<R>): Promise<RetryRunResult<R>> => {
  const { policy, attempt, sleep, clock, backoff } = options
  const totalAttempts = Math.max(policy.maxAttempts, 1)
  const startedAt = clock()
  let attempts = 0
  let waitedMs = 0
  let lastValue: R | undefined

  for (let index = 1; index <= totalAttempts; index++) {
    attempts = index
    const remainingBudgetMs = Math.max(policy.totalBudgetMs - (clock() - startedAt), 0)
    const outcome = await attempt(index, remainingBudgetMs)
    lastValue = outcome.value
    if (!outcome.failed || index === totalAttempts) {
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
