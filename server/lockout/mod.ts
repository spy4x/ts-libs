/**
 * An escalating lockout for any secret a person can guess: a one-time code, an e-mail code, a PIN,
 * a recovery code. Wrong guesses are counted per subject in a store that survives a restart and is
 * shared by every server instance; past a free budget, each wrong guess locks the subject for
 * longer.
 *
 * Ported from spy4x/template `apps/api/services/totp-failures.ts` (#315). The policy and the flow
 * are the template's; the table and its columns are now the caller's, behind {@link LockoutStore}.
 *
 * How a check goes: {@link Lockout.begin} runs first and counts the check as a failure in advance;
 * a correct secret then calls {@link Lockout.refund}, which gives that one slot back. A correct
 * secret does not wipe the count: that would hand a guesser a fresh budget every time the owner
 * gets it right. A wrong secret calls {@link Lockout.fail}, which stamps the time. After
 * {@link LockoutPolicy.quietResetMs} without a wrong secret the count starts again from 0. Counting
 * first, in one atomic store update, means parallel guesses cannot all slip through before the
 * first one is counted.
 *
 * While a lock runs, every check is refused without looking at the secret, a correct one included:
 * a lock that let the right secret through would let a lucky guess through too. The price is that
 * someone who can reach the check can keep the owner out of it, up to
 * {@link LockoutPolicy.maxLockMs} at a time.
 *
 * @module
 */

import { type } from "arktype"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"

/** The numbers that decide when a subject is locked and for how long. */
export interface LockoutPolicy {
  /** Wrong guesses that cost no wait. The next check still runs; a wrong one then locks. */
  freeFailures: number
  /** The lock after the first failure past {@link freeFailures}; it doubles with each one after. */
  firstLockMs: number
  /** The longest lock. */
  maxLockMs: number
  /** This long with no wrong guess sets the count back to 0. */
  quietResetMs: number
}

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS

/** The longest {@link LockoutPolicy.maxLockMs} accepted: one year, far inside a `Date`'s range. */
export const MAX_LOCK_LIMIT_MS = 365 * DAY_MS

/** 5 free failures, then 15 minutes doubling up to one day; 7 quiet days reset the count. */
export const DEFAULT_LOCKOUT_POLICY: Readonly<LockoutPolicy> = Object.freeze({
  freeFailures: 5,
  firstLockMs: 15 * MINUTE_MS,
  maxLockMs: DAY_MS,
  quietResetMs: 7 * DAY_MS,
})

const lockoutPolicy = type({
  freeFailures: "number.integer >= 0",
  firstLockMs: "number.integer > 0",
  // 31_536_000_000 is MAX_LOCK_LIMIT_MS; arktype needs the literal to type the string.
  maxLockMs: "0 < number.integer <= 31536000000",
  quietResetMs: "number.integer > 0",
}).narrow((policy, ctx) =>
  policy.maxLockMs >= policy.firstLockMs || ctx.mustBe("a policy whose maxLockMs >= firstLockMs")
)

/**
 * {@link DEFAULT_LOCKOUT_POLICY} with `overrides` applied. Throws a `TypeError` naming the problem
 * when a number is negative, fractional, zero where a wait is expected, or when the maximum lock is
 * shorter than the first one or longer than {@link MAX_LOCK_LIMIT_MS}.
 */
export function resolveLockoutPolicy(overrides: Partial<LockoutPolicy> = {}): LockoutPolicy {
  const merged = { ...DEFAULT_LOCKOUT_POLICY }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(merged, { [key]: value })
  }
  const out = lockoutPolicy(merged)
  if (out instanceof type.errors) throw new TypeError(`invalid lockout policy: ${out.summary}`)
  return out
}

/**
 * How long a subject is locked after its `failures`-th wrong guess in a row: nothing up to
 * {@link LockoutPolicy.freeFailures}, then {@link LockoutPolicy.firstLockMs} doubling per failure,
 * capped at {@link LockoutPolicy.maxLockMs}.
 */
export function lockDelayMs(
  failures: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): number {
  if (!(failures > policy.freeFailures)) return 0
  // A huge count makes `2 ** doublings` Infinity, and the cap still applies to it.
  const doublings = Math.floor(failures) - policy.freeFailures - 1
  return Math.min(policy.firstLockMs * 2 ** doublings, policy.maxLockMs)
}

/** One subject's counter, as a store holds it. Times are epoch milliseconds. */
export interface LockoutState {
  /** Checks counted and not refunded since the last quiet reset. */
  failures: number
  /** When the running lock ends, or `null` when none was set. */
  lockedUntil: number | null
  /** When a wrong guess was last recorded or the count last reset; `null` before either. */
  lastFailureAt: number | null
}

/** The caller's key for whatever is being guessed: a user id, an e-mail address, a device. */
export type LockoutSubject = string | number

/**
 * Where counters live: `@spy4x/server/lockout/memory-store` and `@spy4x/server/lockout/postgres`.
 * Neither deletes a counter; see the Postgres store for a safe cleanup.
 */
export interface LockoutStore {
  /**
   * Reads the subject's state, passes it to `change` and writes what `change` returns, as one
   * atomic step: no other `update` of the same subject may read in between. `change` gets
   * `undefined` for a subject the store does not track; returning `undefined` writes nothing.
   */
  update(
    subject: LockoutSubject,
    change: (current: LockoutState | undefined) => LockoutState | undefined,
  ): Promise<void>
}

/** The begin, fail and refund flow over one store and one policy. */
export interface Lockout {
  /**
   * Starts a check for `subject`. Returns 0 when the check may run, and counts it as a failure
   * until {@link refund} runs. Returns the milliseconds left, without counting, while a lock runs.
   * A subject the store does not track has nothing to guess, so it gets 0.
   */
  begin(subject: LockoutSubject): Promise<number>
  /**
   * Gives back the slot {@link begin} took. Call it only after `begin` returned 0 and the secret
   * was right. Always clears the lock: one a concurrent wrong guess set in the meantime is cleared
   * too, which gives a guesser back one guess per correct entry by the owner. That race is
   * accepted; the count itself only goes down by one.
   */
  refund(subject: LockoutSubject): Promise<void>
  /** Records a wrong secret: the time the quiet reset counts from. */
  fail(subject: LockoutSubject): Promise<void>
}

/** Options for {@link createLockout}. Every policy number defaults to {@link DEFAULT_LOCKOUT_POLICY}. */
export interface LockoutOptions extends Partial<LockoutPolicy> {
  store: LockoutStore
  /** Defaults to the host clock. */
  clock?: Clock
}

const lockoutSubject = type(
  "0 < string <= 255 | -9007199254740991 <= number.integer <= 9007199254740991",
)

function checkSubject(subject: LockoutSubject): void {
  const out = lockoutSubject(subject)
  if (out instanceof type.errors) throw new TypeError(`invalid lockout subject: ${out.summary}`)
}

/**
 * The state after {@link Lockout.begin} counted a check at `now`, and the wait it returns. Pure:
 * the stores call it inside their atomic update.
 */
export function beginCheck(
  state: LockoutState,
  now: number,
  policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY,
): { next: LockoutState | undefined; waitMs: number } {
  if (state.lockedUntil !== null && state.lockedUntil > now) {
    return { next: undefined, waitMs: state.lockedUntil - now }
  }
  // The reset stamps the time too, so parallel checks after a quiet spell reset the count once.
  const quiet = state.lastFailureAt !== null && now - state.lastFailureAt >= policy.quietResetMs
  const failures = (quiet ? 0 : state.failures) + 1
  const delay = lockDelayMs(failures, policy)
  return {
    next: {
      failures,
      lockedUntil: delay === 0 ? null : now + delay,
      // Stamped when still empty, so a check whose `fail` never ran is forgotten in time too.
      lastFailureAt: quiet || state.lastFailureAt === null ? now : state.lastFailureAt,
    },
    waitMs: 0,
  }
}

/** Builds the {@link Lockout} flow. Throws a `TypeError` for an invalid policy. */
export function createLockout(options: LockoutOptions): Lockout {
  const { store, clock = systemClock, ...overrides } = options
  const policy = resolveLockoutPolicy(overrides)
  return {
    begin: async (subject) => {
      checkSubject(subject)
      let waitMs = 0
      await store.update(subject, (current) => {
        if (current === undefined) return undefined
        const step = beginCheck(current, clock.now(), policy)
        waitMs = step.waitMs
        return step.next
      })
      return waitMs
    },
    refund: async (subject) => {
      checkSubject(subject)
      await store.update(
        subject,
        (current) =>
          current === undefined
            ? undefined
            : { ...current, failures: Math.max(current.failures - 1, 0), lockedUntil: null },
      )
    },
    fail: async (subject) => {
      checkSubject(subject)
      await store.update(
        subject,
        (current) => current === undefined ? undefined : { ...current, lastFailureAt: clock.now() },
      )
    },
  }
}
