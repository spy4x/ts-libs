/**
 * The in-memory {@link LockoutStore}, held to the same contract as the Postgres one. For tests and
 * single-process tools: it forgets everything on restart, which is what the lockout exists to
 * survive, so do not use it in a deployed server.
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
   * When a new subject arrives and the store is full, it first drops what a sweep would drop. If
   * it is still full, the new subject is **refused**: `update` rejects and `track` throws, and no
   * counter is created. A counter that still decides something is never evicted to make room, so
   * a flood of new subjects cannot clear a running lock or a count. The cost is that checks for
   * new subjects fail for as long as the held counters keep being written, and for up to
   * `quietResetMs` after the last write. One request per held subject per quiet period is enough
   * to keep the store full, and an ordinary successful check holds its slot for `quietResetMs`
   * too. Size the cap well above the subjects the app expects in one quiet period.
   */
  maxEntries?: number
  /** The clock the sweep reads; give it the lockout's own. Defaults to the host clock. */
  clock?: Clock
}

/** One subject's counter and when the store last wrote it. */
interface Row {
  state: LockoutState
  touchedAt: number
}

/** Counters in a `Map`. Each update runs synchronously, so it is atomic within the process. */
export class MemoryLockoutStore implements LockoutStore {
  readonly #rows = new Map<string, Row>()
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
      const row = this.#rows.get(String(subject))
      if (next !== undefined && row !== undefined) {
        row.state = { ...next }
        if (this.#quietResetMs !== undefined) row.touchedAt = this.#clock.now()
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
        this.#rows.delete(key)
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

  /**
   * Called for a new subject while the store is full. Drops what a sweep would drop, and throws
   * when that freed no slot.
   *
   * The pass walks every counter, so it runs at most once until the first counter it kept can be
   * dropped (`#fullUntil`): a flood of new subjects against a full store is refused in constant
   * time. A later write to a kept counter only moves its time further out, so the bound holds.
   */
  #makeRoom(now: number): void {
    if (now >= this.#fullUntil) {
      let freeAt = Number.POSITIVE_INFINITY
      for (const [key, row] of this.#rows) {
        const droppableAt = this.#droppableAt(row)
        if (droppableAt <= now) this.#rows.delete(key)
        else freeAt = Math.min(freeAt, droppableAt)
      }
      if (this.#rows.size < this.#maxEntries) {
        this.#fullUntil = Number.NEGATIVE_INFINITY
        return
      }
      this.#fullUntil = freeAt
    }
    throw new Error(
      `lockout store is full: it holds ${this.#rows.size} subjects and none can be dropped yet`,
    )
  }

  /** Sweeps at most once per `quietResetMs`, and forces one after {@link SWEEP_EVERY_UPDATES}. */
  #maybeSweep(now: number): void {
    if (this.#quietResetMs === undefined) return
    this.#updatesSinceSweep += 1
    const due = now - this.#lastSweepAt >= this.#quietResetMs
    if (due || this.#updatesSinceSweep >= SWEEP_EVERY_UPDATES) this.sweep(now)
  }
}
