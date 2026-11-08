/**
 * An escalating lockout for any secret a person can guess: a one-time code, an e-mail code, a PIN,
 * a recovery code. Wrong guesses are counted per subject in a store that survives a restart and is
 * shared by every server instance; past a free budget, each wrong guess locks the subject for
 * longer.
 *
 * The table and its columns are the caller's, behind {@link LockoutStore}.
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
 * {@link LockoutPolicy.maxLockMs} at a time, and the locks chain: when the subject is something a
 * stranger can name (a sign-in name, or one subject for everyone), one wrong guess each time a lock
 * ends keeps the owner out for as long as the stranger keeps guessing. Pass the `devices` option
 * and the device cookie, and a browser that passed the check before is counted on its own counter
 * instead (see "Known devices" below).
 *
 * `createLockout`, `lockDelayMs`, `beginCheck`, `resolveLockoutPolicy`, `DEFAULT_LOCKOUT_POLICY`,
 * `MAX_LOCK_LIMIT_MS` and the `LockoutStore` port; `createPostgresLockoutStore` in
 * `server/lockout/postgres`; `MemoryLockoutStore` and `LockoutStoreFullError` in
 * `server/lockout/memory-store`.
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
 * **Known devices.** A lock keyed by something a stranger can name, such as a sign-in name or one
 * subject for everyone, can be held for as long as the stranger likes: one wrong guess each time a
 * lock ends sets the next one. With the `devices` option, a correct secret earns the browser a
 * device token from `rememberDevice`, which the app keeps in a long-lived `HttpOnly`, `Secure`,
 * `SameSite=Lax` cookie. A later check that passes that cookie is counted only on the device's own
 * counter, under the same policy, and the subject's lock is neither consulted nor counted. A
 * stranger has no token, so their wrong guesses lock strangers only. The token is signed for one
 * subject, so it is worthless for any other; a missing, forged or foreign token falls back to the
 * subject's lock. It never expires: rotating `devices.secret` forgets every device. A person on a
 * new device can still be held out.
 *
 * ```ts
 * const lockout = createLockout({
 *   store: createPostgresLockoutStore({ sql, table: "sign_in_lockouts" }),
 *   devices: {
 *     secret: env.LOCKOUT_DEVICE_SECRET,
 *     store: createPostgresLockoutStore({ sql, table: "sign_in_device_lockouts" }),
 *   },
 * })
 *
 * const check = { device: getCookie(c, "known_device") }
 * const waitMs = await lockout.begin(name, check)
 * if (waitMs > 0) return tooManyAttempts(waitMs)
 * if (await passwordIsValid(name, password)) {
 *   await lockout.refund(name, check)
 *   setCookie(c, "known_device", await lockout.rememberDevice(name), {
 *     httpOnly: true, secure: true, sameSite: "Lax", maxAge: 400 * 24 * 60 * 60,
 *   })
 * } else await lockout.fail(name, check)
 * ```
 *
 * The device store is a counters-only store that counts every subject it has not seen: in Postgres,
 * a table of its own through `createPostgresLockoutStore` with `createMissing` left on, and the
 * scheduled `DELETE` below applies to it too.
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
 * A full store first drops a counter with a zero count and no lock (one whose check was refunded
 * decides nothing), then what a sweep would drop. If nothing can go, a new subject is refused:
 * `begin` rejects with `LockoutStoreFullError`, and no counter is created. Answer it exactly like a
 * lock ("too many attempts", such as a 429) and never go on to check the secret. A counter with a
 * running lock, or with a failure inside the quiet period, is never evicted to make room, so filling
 * the store clears nobody's lock or count. The cost is that checks for new subjects fail while every
 * held counter keeps one, for up to `quietResetMs` after its last write. Each held counter costs a
 * stranger one wrong secret, so a store keyed by something they choose freely (a typed name) can
 * still be filled at one wrong guess per subject: size the cap well above the subjects you expect to
 * fail in one quiet period. The store suits a server that runs as one process, at a price: a restart
 * ends every lock and gives every guesser its free tries back. There is no timer:
 * sweeps run inside `update`, at most once per `quietResetMs` or every 512 calls. Neither option works
 * with `createMissing: false`, where a dropped subject would stop being counted.
 *
 * The doublings of `lockDelayMs` are not capped at a count: `Math.min` already turns an infinite
 * product into the maximum lock. A check that `begin` counted but whose `fail` never ran (the process
 * crashed, the request was dropped) is still forgotten after the quiet reset, because `begin` stamps
 * the time the reset counts from when it is empty. The year test tries every burst length from 1 to
 * 40: stopping after 12 guesses and waiting out the quiet reset gets about 576 guesses a year, more
 * than a guesser who tries again the moment each lock ends.
 *
 * @module
 */

import { type } from "arktype"
import { createSignedPayloadCodec } from "@spy4x/platform/signed-payload"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import { uuidV7 } from "@spy4x/platform/universal/uuid"

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
  begin(subject: LockoutSubject, options?: LockoutCheckOptions): Promise<number>
  /**
   * Gives back the slot {@link begin} took. Call it only after `begin` returned 0 and the secret
   * was right. Always clears the lock: one a concurrent wrong guess set in the meantime is cleared
   * too, which gives a guesser back one guess per correct entry by the owner. That race is
   * accepted; the count itself only goes down by one.
   */
  refund(subject: LockoutSubject, options?: LockoutCheckOptions): Promise<void>
  /** Records a wrong secret: the time the quiet reset counts from. */
  fail(subject: LockoutSubject, options?: LockoutCheckOptions): Promise<void>
  /**
   * Makes a fresh device token for `subject`, for the app to set in a long-lived `HttpOnly`,
   * `Secure`, `SameSite=Lax` cookie after a correct secret. The token is signed for this subject
   * only and never expires. {@link createLockout} always provides it, and it throws when the
   * `devices` option is missing.
   */
  rememberDevice?(subject: LockoutSubject): Promise<string>
}

/** Options for {@link createLockout}. Every policy number defaults to {@link DEFAULT_LOCKOUT_POLICY}. */
export interface LockoutOptions extends Partial<LockoutPolicy> {
  store: LockoutStore
  /** Defaults to the host clock. */
  clock?: Clock
  /**
   * Counts a browser that passed the check before on its own counter, so a stranger's wrong
   * guesses on the subject do not keep its owner out. `secret` signs the device tokens
   * ({@link Lockout.rememberDevice}), at least 32 printable characters; rotating it forgets every
   * device. `store` holds one counter per device under the same policy, and must count subjects
   * it has not seen: a counters-only store, never one with `createMissing: false`.
   */
  devices?: { secret: string; store: LockoutStore }
}

/** Per-check options for {@link Lockout.begin}, {@link Lockout.refund} and {@link Lockout.fail}. */
export interface LockoutCheckOptions {
  /**
   * The device token the browser sent back, as {@link Lockout.rememberDevice} made it. A token
   * that verifies for this subject moves the check onto the device's own counter; a missing,
   * forged or foreign one, or one passed without the `devices` option, leaves the check on the
   * subject.
   */
  device?: string
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

/**
 * Builds the {@link Lockout} flow. Throws a `TypeError` for an invalid policy, and a `TokenError`
 * for a `devices.secret` that is too short.
 */
export function createLockout(options: LockoutOptions): Required<Lockout> {
  const { store, clock = systemClock, devices, ...overrides } = options
  const policy = resolveLockoutPolicy(overrides)
  const tokens = devices && createSignedPayloadCodec({
    secret: devices.secret,
    purpose: "lockout.device",
    version: 1,
    schema: type({ device: "string.uuid", "+": "reject" }),
  })

  /** The counter a check is kept on: the device's when its token verifies, else the subject's. */
  const counter = async (
    subject: LockoutSubject,
    check: LockoutCheckOptions | undefined,
  ): Promise<[LockoutStore, LockoutSubject]> => {
    checkSubject(subject)
    const token = check?.device
    if (devices && tokens && typeof token === "string") {
      const verified = await tokens.verify(token, { context: String(subject) })
      if (verified.ok) return [devices.store, verified.value.device]
    }
    return [store, subject]
  }

  return {
    begin: async (subject, check) => {
      const [on, key] = await counter(subject, check)
      let waitMs = 0
      await on.update(key, (current) => {
        if (current === undefined) return undefined
        const step = beginCheck(current, clock.now(), policy)
        waitMs = step.waitMs
        return step.next
      })
      return waitMs
    },
    refund: async (subject, check) => {
      const [on, key] = await counter(subject, check)
      await on.update(
        key,
        (current) =>
          current === undefined
            ? undefined
            : { ...current, failures: Math.max(current.failures - 1, 0), lockedUntil: null },
      )
    },
    fail: async (subject, check) => {
      const [on, key] = await counter(subject, check)
      await on.update(
        key,
        (current) => current === undefined ? undefined : { ...current, lastFailureAt: clock.now() },
      )
    },
    rememberDevice: async (subject) => {
      checkSubject(subject)
      if (!tokens) throw new Error("rememberDevice needs the lockout's devices option")
      return await tokens.sign({ device: uuidV7() }, { context: String(subject) })
    },
  }
}
