/**
 * An escalating lockout for any secret a person can guess: a one-time code, an e-mail code, a PIN,
 * a recovery code. Wrong guesses are counted per subject in a store that survives a restart and is
 * shared by every server instance; past a free budget, each wrong guess locks the subject for
 * longer.
 *
 * Ported from spy4x/seed `apps/api/services/totp-failures.ts` (#315). The policy and the flow
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
 * `createLockout`, `lockDelayMs`, `beginCheck`, `resolveLockoutPolicy`, `DEFAULT_LOCKOUT_POLICY`,
 * `MAX_LOCK_LIMIT_MS` and the `LockoutStore` port; `createPostgresLockoutStore` in
 * `server/lockout/postgres`; `MemoryLockoutStore` in `server/lockout/memory-store`. Ported from spy4x/seed `apps/api/services/totp-failures.ts` (#315).
 *
 * An escalating lockout for any secret a person can guess: a one-time code, an e-mail code, a PIN, a
 * recovery code. Counters are kept per subject, a key the caller chooses (a user id, an address), in a
 * store that survives a restart and that every server instance shares. `@spy4x/platform/rate-limit`
 * stops bursts; this stops a patient guesser.
 *
 * The default policy: 5 wrong guesses cost nothing, the next wrong one locks for 15 minutes, each one
 * after doubles the lock up to one day, and 7 days with no wrong guess reset the count. Every number
 * is an option; the maximum lock is capped at one year. The defaults allow about 580 guesses a year
 * to a guesser who makes 12 wrong guesses, then waits out the 7 quiet days and starts again: under a
 * 0.2% chance of hitting one of 3 valid six-digit codes. Guessing again the moment each lock ends gets
 * fewer, about 380.
 *
 * ```ts
 * import { createLockout } from "@spy4x/server/lockout"
 * import { createPostgresLockoutStore } from "@spy4x/server/lockout/postgres"
 *
 * const lockout = createLockout({
 *   store: createPostgresLockoutStore({ sql, table: "user_totp", columns: { subject: "user_id" } }),
 * })
 *
 * const waitMs = await lockout.begin(userId)
 * if (waitMs > 0) return tooManyAttempts(waitMs)
 * if (await codeIsValid(userId, code)) await lockout.refund(userId)
 * else await lockout.fail(userId)
 * ```
 *
 * **Count first, refund on success.** `begin` counts the check as a failure before the secret is
 * compared, in one atomic store update (`SELECT … FOR UPDATE` in Postgres), so parallel guesses cannot
 * all slip through the free budget: of any number of simultaneous checks, at most the free budget plus
 * one run. A correct secret gives back that one slot; it does not wipe the count, which would hand a
 * guesser a fresh budget every time the owner signs in. While a lock runs, every check is refused, a
 * correct one included, so someone who can reach the check can keep the owner out of it for up to the
 * maximum lock.
 *
 * **Pass the pool.** On a pool each update runs in its own transaction and is committed at once.
 * `createPostgresLockoutStore` also takes the `tx` of the app's own `sql.begin`; each update then runs
 * in a savepoint, and the count commits or rolls back with the app's transaction. A rollback after a
 * wrong guess erases that guess's count: an app that refuses a wrong code by throwing inside its
 * transaction is never locked out, however many guesses it gets. A refused guess must commit, so pass
 * a transaction handle only when that transaction commits whatever the guess was.
 *
 * **The Postgres store takes the caller's table.** Table, schema and column names must be lower-case
 * identifiers; they are validated and sent through the driver's identifier quoting, never spliced
 * into the SQL. The subject column must be unique. With `createMissing` (the default) an unknown
 * subject's row is inserted, so every subject is counted; with `createMissing: false` a subject
 * without a row has nothing to guess and is let through, which fits a table holding one row per
 * enrolled secret.
 *
 * **Counters are never deleted.** With `createMissing`, every new subject adds a row, so an endpoint
 * keyed by something a stranger chooses, such as an e-mail address, grows the table one row per
 * address. On a table that holds only counters, delete the rows that decide nothing any more on a
 * schedule; with the default policy and columns:
 *
 * ```sql
 * DELETE FROM lockouts
 * WHERE (last_failure_at IS NULL OR last_failure_at < now() - interval '7 days')
 *   AND (locked_until IS NULL OR locked_until < now())
 * ```
 *
 * A row past its quiet reset with no running lock would be reset by the next check anyway, and a row
 * whose `last_failure_at` is `NULL` was never counted. On a table that holds enrolled secrets, never
 * delete rows for this. `MemoryLockoutStore` compares subjects as strings, as a `TEXT` column does:
 * `1` and `"1"` are one subject.
 *
 * **The memory store sweeps when told the quiet period.** Left alone, `MemoryLockoutStore` keeps
 * every subject for as long as it lives. Give it the lockout's `quietResetMs` and its clock, and it
 * drops a counter once no lock is running and neither a failure nor a write happened for that long:
 * the same rows the `DELETE` above removes. Add `maxEntries` for a hard bound:
 *
 * ```ts
 * const store = new MemoryLockoutStore({ quietResetMs: 7 * 24 * 60 * 60_000, maxEntries: 100_000 })
 * ```
 *
 * A full store first drops what a sweep would drop. If nothing can go, a new subject is refused:
 * `begin` rejects, and no counter is created. A counter with a running lock, or with a failure inside
 * the quiet period, is never evicted to make room, so filling the store clears nobody's lock or
 * count. The cost is that checks for new subjects fail for as long as the held counters keep being
 * written, and for up to `quietResetMs` after the last write. One request per held subject per quiet
 * period keeps the store full, and an ordinary successful check holds its slot for `quietResetMs`
 * too, so size the cap well above the subjects you expect in one quiet period. There is no timer:
 * sweeps run inside `update`, at most once per `quietResetMs` or every 512 calls. Neither option works
 * with `createMissing: false`, where a dropped subject would stop being counted.
 *
 * **Fixes applied at extraction time.**
 *
 * - `lockDelayMs` capped the doublings at 30 to keep the number finite. With the numbers now options,
 *   a maximum lock more than 2^30 times the first one could never be reached. The cap is gone:
 *   `Math.min` already turns an infinite product into the maximum lock.
 * - A check that `begin` counted but whose `fail` never ran (the process crashed, the request was
 *   dropped) was never forgotten for a subject with no wrong guess on record, because the quiet reset
 *   counted from a time that was never stamped. `begin` now stamps that time when it is empty.
 * - The source's year test called a guesser who tries again the moment each lock ends "the worst
 *   case". It is not: stopping after 12 guesses and waiting out the quiet reset gets about 576
 *   guesses a year, not 376. The test here tries every burst length from 1 to 40.
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
 * The Postgres one never deletes a counter (it documents a safe cleanup); the memory one drops the
 * ones that decide nothing any more when given its `quietResetMs` option.
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
