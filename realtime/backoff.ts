/**
 * Reconnect backoff: exponential, jittered, capped.
 *
 * Financy reconnected on a fixed `1500 + Math.random() * 2000` interval forever, so a server
 * restart had every client retry at the same rate, and a client that could not connect never
 * slowed down. This is the replacement: exponential growth with a cap, plus jitter so a fleet that
 * dropped together does not return together.
 *
 * The `random` source is injected, so a test asserts the cap and the jitter band without waiting.
 *
 * The capping and jittering delegates to `@spy4x/platform/universal/async`'s `backoffDelay`
 * (`#71`): this module still owns the growth formula (`baseMs * factor ** attempt`) and the
 * 0-based attempt numbering, and `nextBackoffDelay` still returns exactly what it returned before
 * that extraction.
 */

import { backoffDelay } from "@spy4x/platform/universal/async"

/** Shape of the backoff schedule. */
export interface BackoffConfig {
  /** Delay before the first retry, in milliseconds. */
  baseMs: number
  /** Multiplier applied per attempt. */
  factor: number
  /** Ceiling no delay ever exceeds. */
  maxMs: number
  /**
   * Fraction of the delay that may be removed by jitter, in `[0, 1)`.
   *
   * `0.5` yields a delay in `[0.5 × capped, capped]`: always a real wait, never longer than the
   * cap, and spread across clients.
   */
  jitterRatio: number
}

/** Defaults used when a caller does not override them. */
export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 500,
  factor: 2,
  maxMs: 30_000,
  jitterRatio: 0.5,
}

/** One call's inputs. */
export interface BackoffOptions extends Partial<BackoffConfig> {
  /** Zero-based retry index: `0` is the first retry after the connection dropped. */
  attempt: number
  /** Uniform source in `[0, 1)`. Injected so tests are deterministic. */
  random?: () => number
}

/**
 * Delay before retry `attempt`, in milliseconds.
 *
 * The uncapped value is `baseMs × factor ** attempt`; it is clamped to `maxMs` *before* jitter is
 * applied and clamped again after, so the cap holds for every value the random source can return.
 *
 * @deprecated Thin wrapper over `backoffDelay` from "@spy4x/platform/universal/async" (`#71`),
 * kept for this module's existing 0-based-attempt, `factor`-parameterised call shape. New code
 * should call `backoffDelay` directly.
 */
export function nextBackoffDelay(options: BackoffOptions): number {
  const { baseMs, factor, maxMs, jitterRatio } = {
    ...DEFAULT_BACKOFF,
    ...options,
  }
  const attempt = Math.max(0, Math.floor(options.attempt))
  const random = options.random ?? Math.random

  const rawMs = baseMs * factor ** attempt
  return backoffDelay({ rawMs, maxMs, jitterRatio, mode: "downward", random })
}
