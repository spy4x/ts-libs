/**
 * Retry policies for the notifiers.
 *
 * The retry *mechanism* lives in `./retry.ts`, which is byte-identical to
 * `integrations/retry.ts`. Only the policy numbers are package-specific, so
 * they live here rather than in the shared copy.
 */

import type { RetryPolicy } from "./retry.ts"

/**
 * Default dead-man's-switch policy, from the `rostok` source: **10 tries with
 * 60s doubling**, capped so the whole schedule fits inside healthchecks.io's
 * 1-hour grace window.
 *
 * Measured schedule, asserted by the suite rather than described:
 * `1 + 2 + 4 + 5 + 5 + 5 + 5 + 5 + 5 = 37.0 minutes` (2,220,000 ms) of
 * waiting across 9 retries, so 10 attempts. A 10-minute per-wait cap gives
 * `1 + 2 + 4 + 8 + 10 + 10 + 10 + 10 + 10 = 65.0 minutes` and overruns the very
 * window the cap exists to respect.
 *
 * `totalBudgetMs` is a second, independent ceiling on the whole operation, and
 * it must exceed the sum of the waits or it silently shortens the sequence: at
 * 10 minutes it aborted after the 4th attempt and delivered 4 retries instead
 * of the 10 the policy promises. 40 minutes covers the 37.0-minute schedule with
 * headroom for per-attempt latency and still bounds a wedged endpoint.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 300_000,
  totalBudgetMs: 2_400_000,
  jitterRatio: 0,
}
