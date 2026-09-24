import { DEFAULT_DEBOUNCE_DELAY } from "./constants.ts"

/** Wait `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Trailing-edge debounce.
 *
 * Each call resets the timer; only the last call's arguments reach `fn`. The timer is **unref'd**
 * where the runtime supports it, so a pending debounce never keeps a Deno process alive — an
 * improvement over the source, which held the event loop open for the full delay.
 *
 * `cancel()` drops a pending call, and `pending()` reports whether one is queued, which is what
 * makes the behaviour assertable without sleeping.
 */
export interface Debounced<Params extends unknown[]> {
  (...args: Params): void
  /** Drop a queued invocation. */
  cancel(): void
  /** Whether an invocation is queued. */
  pending(): boolean
}

/** Wrap `fn` in a trailing-edge debounce. */
export function debounce<Params extends unknown[]>(
  fn: (...args: Params) => unknown,
  delay = DEFAULT_DEBOUNCE_DELAY,
): Debounced<Params> {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = (...args: Params) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delay)
    // Deno and Node expose `unref`; browsers do not.
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  debounced.pending = () => timer !== null
  return debounced
}

/**
 * A source of numbers in `[0, 1)`, the shape `Math.random` has.
 *
 * Injectable so a test can supply a fixed sequence instead of the platform's real generator: a
 * jitter computation stays testable without becoming predictable in production.
 */
export type RandomSource = () => number

/** How {@linkcode backoffDelay} spreads a capped delay. */
export type BackoffJitterMode =
  /** `capped +/- capped * jitterRatio`, then re-clamped to `[minFloorMs, maxMs]`. */
  | "symmetric"
  /** `[capped * (1 - jitterRatio), capped]` — never longer than the unjittered delay. */
  | "downward"

export interface BackoffDelayOptions {
  /**
   * The delay before jitter, in milliseconds. Callers compute this from whatever grows per
   * attempt — `baseMs * factor ** attempt`, a provider's `Retry-After` hint, or anything else —
   * so this function owns only the part that was duplicated: capping and jittering.
   */
  rawMs: number
  /** Ceiling no returned delay ever exceeds. */
  maxMs: number
  /**
   * Jitter fraction. `0` or less: `"symmetric"` returns the capped delay unrounded and
   * unchanged; `"downward"` still rounds and still calls `random()`. See {@linkcode backoffDelay}.
   */
  jitterRatio: number
  /** Which side of the capped delay jitter is drawn from. */
  mode: BackoffJitterMode
  /**
   * Floor applied after `"symmetric"` jitter, before the final clamp to `maxMs`. Ignored for
   * `"downward"`, which already never goes below `capped * (1 - jitterRatio)`. Defaults to `0`.
   */
  minFloorMs?: number
  /** Uniform source in `[0, 1)`. Defaults to `Math.random`. */
  random?: RandomSource
}

/**
 * Caps a raw delay and jitters it — the exponential-backoff arithmetic that used to be
 * implemented twice: once with symmetric jitter around the capped delay
 * (`integrations/retry.ts`'s `createExponentialBackoff`) and once with jitter that only ever
 * shortens the wait (`realtime/backoff.ts`'s `nextBackoffDelay`). Both call this function now,
 * each supplying its own `rawMs` growth formula and jitter mode, and each still returns exactly
 * what it returned before this function existed — see the two wrappers' own tests.
 *
 * `"symmetric"` jitters in both directions: `capped + (random() * 2 - 1) * capped * jitterRatio`,
 * clamped to `[minFloorMs, maxMs]`. It rounds only when `jitterRatio > 0`; at `0` or below it
 * returns the capped value exactly as given — a caller that passes a non-integer `maxMs`
 * (`raw > maxMs`, `jitterRatio: 0`) gets that exact non-integer back, not a rounded one, matching
 * `createExponentialBackoff`'s original, unrounded early return.
 *
 * `"downward"` only ever removes wait: a value drawn uniformly from
 * `[capped * (1 - jitterRatio), capped]`, and unlike `"symmetric"` it always rounds, and always
 * calls `random()`, even when `jitterRatio` is `0` or less — that always-call, always-round shape
 * matches `nextBackoffDelay`'s original, which never special-cased a zero ratio.
 *
 * The two modes exist because they answer different questions — "de-synchronise callers without
 * ever waiting longer than the plain schedule" versus "still center on the plain schedule, so
 * `jitterRatio` reads as a symmetric error band" — and changing either now would change either
 * caller's already-shipped delays, so neither replaces the other.
 */
export function backoffDelay(options: BackoffDelayOptions): number {
  const { rawMs, maxMs, jitterRatio, mode, minFloorMs = 0, random = Math.random } = options
  if (mode === "downward") {
    const capped = Math.min(maxMs, rawMs)
    const floor = capped * (1 - Math.min(Math.max(jitterRatio, 0), 0.999))
    const value = floor + random() * (capped - floor)
    return Math.min(maxMs, Math.max(0, Math.round(value)))
  }
  const capped = Math.min(Math.max(rawMs, 0), maxMs)
  if (jitterRatio <= 0) {
    return capped
  }
  const span = capped * jitterRatio
  const jitter = (random() * 2 - 1) * span
  return Math.round(Math.min(Math.max(capped + jitter, minFloorMs), maxMs))
}
