/**
 * The in-memory {@link LockoutStore}, held to the same contract as the Postgres one. For tests and
 * single-process tools: it forgets everything on restart, which is what the lockout exists to
 * survive, so do not use it in a deployed server.
 *
 * @module
 */

import type { LockoutState, LockoutStore, LockoutSubject } from "./mod.ts"

/** Options for {@link MemoryLockoutStore}. */
export interface MemoryLockoutStoreOptions {
  /**
   * `true` (the default) starts an unknown subject at a zero count. `false` treats it as one with
   * nothing to guess, until {@link MemoryLockoutStore.track} adds it.
   */
  createMissing?: boolean
}

/** Counters in a `Map`. Each update runs synchronously, so it is atomic within the process. */
export class MemoryLockoutStore implements LockoutStore {
  readonly #rows = new Map<string, LockoutState>()
  readonly #createMissing: boolean

  constructor(options: MemoryLockoutStoreOptions = {}) {
    this.#createMissing = options.createMissing ?? true
  }

  /** Starts tracking `subject` at a zero count, as inserting its row would. */
  track(subject: LockoutSubject): void {
    const key = String(subject)
    if (!this.#rows.has(key)) {
      this.#rows.set(key, { failures: 0, lockedUntil: null, lastFailureAt: null })
    }
  }

  /** A copy of the subject's state, or `undefined` when it is not tracked. */
  get(subject: LockoutSubject): LockoutState | undefined {
    const row = this.#rows.get(String(subject))
    return row === undefined ? undefined : { ...row }
  }

  update(
    subject: LockoutSubject,
    change: (current: LockoutState | undefined) => LockoutState | undefined,
  ): Promise<void> {
    try {
      if (this.#createMissing) this.track(subject)
      const next = change(this.get(subject))
      const key = String(subject)
      if (next !== undefined && this.#rows.has(key)) this.#rows.set(key, { ...next })
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(error)
    }
  }
}
