/** Bounded-concurrency helpers: a parallel map and a fair async mutex. */

/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 *
 * Completion order is irrelevant: the result array matches the input order. The first rejection
 * wins — the returned promise rejects as soon as any worker fails, and the remaining workers
 * finish in the background rather than being cancelled (there is no cancellation primitive in
 * `Promise`). `limit` is clamped to at least 1, and a `limit` greater than the item count simply
 * means "all at once".
 *
 * This is the *bounded fan-out* variant: one worker per item, capped at `limit` in flight.
 */
export async function mapConcurrent<Item, Out>(
  items: readonly Item[],
  limit: number,
  fn: (item: Item, index: number) => Promise<Out>,
): Promise<Out[]> {
  if (!Number.isFinite(limit)) throw new Error("mapConcurrent: limit must be finite")
  const workers = Math.max(1, Math.min(Math.trunc(limit), items.length))
  const results = new Array<Out>(items.length)
  let next = 0

  const run = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: workers }, run))
  return results
}

interface Waiter {
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
}

/**
 * A fair mutual-exclusion lock for async critical sections.
 *
 * Waiters are served strictly in arrival order: a caller that arrives while the lock is held
 * cannot overtake one already queued, even across an `await`. `acquire()` resolves to an
 * idempotent release function, so the critical section is bounded by a `try/finally`.
 *
 * @example
 * ```ts
 * const release = await mutex.acquire()
 * try {
 *   await write()
 * } finally {
 *   release()
 * }
 * ```
 */
export class AsyncMutex {
  #locked = false
  readonly #waiters: Waiter[] = []
  /** Monotonic count of acquires that actually took the lock — the fairness assertion hook. */
  #acquisitions = 0

  /** Number of callers currently queued behind the holder. */
  get queued(): number {
    return this.#waiters.length
  }

  /** Whether the lock is held (including during a hand-off). */
  get locked(): boolean {
    return this.#locked
  }

  /** How many acquires have taken the lock. Serviced order is observable through this. */
  get acquisitions(): number {
    return this.#acquisitions
  }

  /** Wait for the lock, then return the idempotent release function. */
  acquire(): Promise<() => void> {
    if (!this.#locked) {
      this.#locked = true
      this.#acquisitions++
      return Promise.resolve(this.#releaser())
    }
    // A bare `new Promise` widens its resolver parameter, so the promise is built explicitly.
    return new Promise<() => void>((resolve, reject) => {
      this.#waiters.push({ resolve, reject })
    })
  }

  /**
   * Run `fn` under the lock and release it afterwards, even when `fn` throws.
   *
   * Preferred over {@link acquire}: the `finally` that releases is written once, here.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /**
   * Hand the lock to the next waiter in FIFO order, or free it.
   *
   * Every waiter receives its own releaser and the lock is held again before the hand-off
   * returns, so an acquire racing the hand-off joins the back of the queue rather than jumping it.
   */
  #releaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (!next) {
        this.#locked = false
        return
      }
      this.#acquisitions++
      next.resolve(this.#releaser())
    }
  }
}
