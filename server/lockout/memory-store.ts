/**
 * The in-memory {@link LockoutStore}, held to the same contract as the Postgres one. For tests,
 * single-process tools and a server that runs as one process and accepts what that costs: a restart
 * forgets every counter, so it ends every running lock and gives every guesser its free tries back.
 * A server that must keep its locks through a restart uses the Postgres store.
 *
 * Left alone it keeps every subject for as long as it lives. Give it
 * {@link MemoryLockoutStoreOptions.quietResetMs} and it drops the counters that decide nothing any
 * more; add {@link MemoryLockoutStoreOptions.maxEntries} for a hard bound on how many it holds.
 *
 * @module
 */

import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import type { LockoutState, LockoutStore, LockoutSubject } from "./mod.ts"

/** How many updates may arrive between two sweeps before one is forced. */
const SWEEP_EVERY_UPDATES = 512

/** Options for {@link MemoryLockoutStore}. */
export interface MemoryLockoutStoreOptions {
  /**
   * `true` (the default) starts an unknown subject at a zero count. `false` treats it as one with
   * nothing to guess, until {@link MemoryLockoutStore.track} adds it.
   */
  createMissing?: boolean
  /**
   * Turns the sweep on: pass the `quietResetMs` of the lockout that uses this store (7 days with
   * the default policy), never less. Left out, no counter is ever dropped.
   *
   * A sweep drops a counter only when the next check would start it again from zero anyway: no
   * lock is running, nothing was written to it for this long, and its last failure is this old (or
   * it has no failure time and a zero count). A counter with a running lock, or with a failure
   * inside the quiet period, is never dropped, so nobody can shorten a lock or a count by waiting
   * for a sweep. One case differs: a `fail` or `refund` that arrives this long after the `begin`
   * it belongs to finds a fresh counter.
   *
   * Sweeps run inside `update` and `track`, at most once per `quietResetMs` or every 512 calls;
   * there is no timer. Not allowed with `createMissing: false`, where a dropped subject would stop
   * being counted at all.
   */
  quietResetMs?: number
  /**
   * The most counters the store may hold. Needs {@link quietResetMs}. Left out, the sweep is the
   * only bound.
   *
   * When a new subject arrives and the store is full, it first drops a counter with a zero count
   * and no lock (the next check would treat it as new anyway, such as one whose check was
   * refunded), then what a sweep would drop. If it is still full, the new subject is **refused**:
   * `update` rejects and `track` throws a {@link LockoutStoreFullError}, and no counter is
   * created. Answer that error exactly like a lock ("too many attempts", such as a 429) and never
   * go on to check the secret.
   *
   * A counter with a running lock, or with a failure inside the quiet period, is never evicted to
   * make room, so a flood of new subjects cannot clear a lock or a count. The cost is that checks
   * for new subjects fail while every held counter keeps one, for up to `quietResetMs` after its
   * last write. Holding a counter costs one real wrong secret, so a store keyed by something a
   * stranger chooses freely (a typed name) can still be filled at one wrong guess per subject.
   * Size the cap well above the subjects the app expects to fail in one quiet period.
   */
  maxEntries?: number
  /** The clock the sweep reads; give it the lockout's own. Defaults to the host clock. */
  clock?: Clock
}

/**
 * Thrown by {@link MemoryLockoutStore.track}, and rejected by `update`, when a new subject meets a
 * full store (see {@link MemoryLockoutStoreOptions.maxEntries}). Answer it like a lock.
 */
export class LockoutStoreFullError extends Error {
  constructor(size: number) {
    super(`lockout store is full: it holds ${size} subjects and none can be dropped yet`)
    this.name = "LockoutStoreFullError"
  }
}

/** One subject's counter and when the store last wrote it. */
interface Row {
  state: LockoutState
  touchedAt: number
}

/** Counters in a `Map`. Each update runs synchronously, so it is atomic within the process. */
export class MemoryLockoutStore implements LockoutStore {
  readonly #rows = new Map<string, Row>()
  /**
   * The keys of counters with a zero count and no lock, oldest first. They decide nothing, so a
   * full store drops one of them for a new subject in constant time.
   */
  readonly #idle = new Set<string>()
  readonly #createMissing: boolean
  readonly #quietResetMs: number | undefined
  readonly #maxEntries: number
  readonly #clock: Clock
  /**
   * Set only while the store is full after a drop pass: the earliest time one of the counters it
   * kept can be dropped. `-Infinity` whenever the last pass made room.
   */
  #fullUntil = Number.NEGATIVE_INFINITY
  #lastSweepAt: number
  #updatesSinceSweep = 0

  constructor(options: MemoryLockoutStoreOptions = {}) {
    const { quietResetMs, maxEntries } = options
    this.#createMissing = options.createMissing ?? true
    if (quietResetMs !== undefined && !(Number.isInteger(quietResetMs) && quietResetMs > 0)) {
      throw new TypeError("quietResetMs must be an integer > 0")
    }
    if (maxEntries !== undefined && !(Number.isInteger(maxEntries) && maxEntries >= 1)) {
      throw new TypeError("maxEntries must be an integer >= 1")
    }
    if (maxEntries !== undefined && quietResetMs === undefined) {
      throw new TypeError("maxEntries needs quietResetMs")
    }
    if (quietResetMs !== undefined && !this.#createMissing) {
      throw new TypeError("quietResetMs is not allowed with createMissing: false")
    }
    this.#quietResetMs = quietResetMs
    this.#maxEntries = maxEntries ?? Number.POSITIVE_INFINITY
    this.#clock = options.clock ?? systemClock
    this.#lastSweepAt = quietResetMs === undefined ? 0 : this.#clock.now()
  }

  /** Counters held. Exposed so a bounded-memory test can assert the bound directly. */
  get size(): number {
    return this.#rows.size
  }

  /**
   * Starts tracking `subject` at a zero count, as inserting its row would. Throws when the store
   * is full (see {@link MemoryLockoutStoreOptions.maxEntries}).
   */
  track(subject: LockoutSubject): void {
    const key = String(subject)
    const now = this.#quietResetMs === undefined ? 0 : this.#clock.now()
    this.#maybeSweep(now)
    if (this.#rows.has(key)) return
    if (this.#rows.size >= this.#maxEntries) this.#makeRoom(now)
    this.#rows.set(key, {
      state: { failures: 0, lockedUntil: null, lastFailureAt: null },
      touchedAt: now,
    })
    this.#idle.add(key)
  }

  /** A copy of the subject's state, or `undefined` when it is not tracked. */
  get(subject: LockoutSubject): LockoutState | undefined {
    const row = this.#rows.get(String(subject))
    return row === undefined ? undefined : { ...row.state }
  }

  update(
    subject: LockoutSubject,
    change: (current: LockoutState | undefined) => LockoutState | undefined,
  ): Promise<void> {
    try {
      if (this.#createMissing) this.track(subject)
      const next = change(this.get(subject))
      const key = String(subject)
      const row = this.#rows.get(key)
      if (next !== undefined && row !== undefined) {
        row.state = { ...next }
        if (this.#quietResetMs !== undefined) row.touchedAt = this.#clock.now()
        if (next.failures === 0 && next.lockedUntil === null) this.#idle.add(key)
        else this.#idle.delete(key)
      }
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Runs the sweep now instead of waiting for the next due one. Returns the counters removed;
   * always 0 without {@link MemoryLockoutStoreOptions.quietResetMs}.
   */
  sweep(now: number = this.#clock.now()): number {
    this.#lastSweepAt = now
    this.#updatesSinceSweep = 0
    let removed = 0
    for (const [key, row] of this.#rows) {
      if (this.#droppableAt(row) <= now) {
        this.#delete(key)
        removed += 1
      }
    }
    return removed
  }

  /**
   * The earliest time `row` decides nothing any more: the next check would then start it again
   * from zero, exactly as it starts a subject the store does not hold. `Infinity` when that time
   * never comes.
   */
  #droppableAt(row: Row): number {
    const quietResetMs = this.#quietResetMs
    if (quietResetMs === undefined) return Number.POSITIVE_INFINITY
    const { failures, lockedUntil, lastFailureAt } = row.state
    // Without a failure time the quiet reset never applies, so only a zero count is as good as new.
    if (lastFailureAt === null && failures !== 0) return Number.POSITIVE_INFINITY
    return Math.max(
      lockedUntil ?? Number.NEGATIVE_INFINITY,
      row.touchedAt + quietResetMs,
      lastFailureAt === null ? Number.NEGATIVE_INFINITY : lastFailureAt + quietResetMs,
    )
  }

  #delete(key: string): void {
    this.#rows.delete(key)
    this.#idle.delete(key)
  }

  /**
   * Called for a new subject while the store is full. Drops the oldest counter with a zero count
   * and no lock, else what a sweep would drop, and throws when that freed no slot.
   *
   * The pass walks every counter, so it runs at most once until the first counter it kept can be
   * dropped (`#fullUntil`): a flood of new subjects against a full store is refused in constant
   * time. A write can make a kept counter droppable before that time: a `refund` zeroes its count
   * and lifts its lock, which the zero-count check catches first, and the regular sweep catches the
   * rest.
   */
  #makeRoom(now: number): void {
    const oldestIdle = this.#idle.values().next()
    if (!oldestIdle.done) return this.#delete(oldestIdle.value)
    if (now >= this.#fullUntil) {
      let freeAt = Number.POSITIVE_INFINITY
      for (const [key, row] of this.#rows) {
        const droppableAt = this.#droppableAt(row)
        if (droppableAt <= now) this.#delete(key)
        else freeAt = Math.min(freeAt, droppableAt)
      }
      if (this.#rows.size < this.#maxEntries) {
        this.#fullUntil = Number.NEGATIVE_INFINITY
        return
      }
      this.#fullUntil = freeAt
    }
    throw new LockoutStoreFullError(this.#rows.size)
  }

  /** Sweeps at most once per `quietResetMs`, and forces one after {@link SWEEP_EVERY_UPDATES}. */
  #maybeSweep(now: number): void {
    if (this.#quietResetMs === undefined) return
    this.#updatesSinceSweep += 1
    const due = now - this.#lastSweepAt >= this.#quietResetMs
    if (due || this.#updatesSinceSweep >= SWEEP_EVERY_UPDATES) this.sweep(now)
  }
}
