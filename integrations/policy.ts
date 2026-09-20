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
 * 1-hour grace window, plus +/-20% jitter. healthchecks.io is pinged from cron
 * on many hosts; without jitter, every host that shares an outage retries at
 * the same four wall-clock offsets and then hammers the endpoint again in
 * lockstep — the jitter exists to break that up.
 *
 * Measured schedule, asserted by the suite rather than described: without
 * jitter the waits are `1 + 2 + 4 + 5 + 5 + 5 + 5 + 5 + 5 = 37.0 minutes`
 * (2,220,000 ms) across 9 retries, so 10 attempts. With +/-20% jitter the same
 * 9 waits range `29.6-38.4 minutes` (1,776,000-2,304,000 ms): the first three
 * delays jitter around their own span, the remaining six each land in
 * `4-5 minutes` because their un-jittered value already exceeds `maxDelayMs`
 * and jitter can only pull them down from that ceiling, never past it. A
 * 10-minute per-wait cap gives `1 + 2 + 4 + 8 + 10 + 10 + 10 + 10 + 10 =
 * 65.0 minutes` and overruns the very window the cap exists to respect.
 *
 * `totalBudgetMs` is a second, independent ceiling on the whole operation, and
 * it must exceed the sum of the waits or it silently shortens the sequence: at
 * 10 minutes it aborted after the 4th attempt and delivered 4 retries instead
 * of the 10 the policy promises. 40 minutes (2,400,000 ms) covers even the
 * worst-case jittered total of 38.4 minutes with headroom for per-attempt
 * latency, so all 10 attempts always complete, and still bounds a wedged
 * endpoint.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 10,
  baseDelayMs: 60_000,
  maxDelayMs: 300_000,
  totalBudgetMs: 2_400_000,
  jitterRatio: 0.2,
}
