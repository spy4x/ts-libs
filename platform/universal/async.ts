import { DEFAULT_DEBOUNCE_DELAY } from "./constants.ts"

/** Wait `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Trailing-edge debounce.
 *
 * Each call resets the timer; only the last call's arguments reach `fn`. The timer is **unref'd**
 * where the runtime supports it, so a pending debounce never keeps a Deno process alive — an
 * improvement over the source, which held the event loop open for the full delay.
 *
 * `cancel()` drops a pending call, and `pending()` reports whether one is queued, which is what
 * makes the behaviour assertable without sleeping.
 */
export interface Debounced<Params extends unknown[]> {
  (...args: Params): void
  /** Drop a queued invocation. */
  cancel(): void
  /** Whether an invocation is queued. */
  pending(): boolean
}

/** Wrap `fn` in a trailing-edge debounce. */
export function debounce<Params extends unknown[]>(
  fn: (...args: Params) => unknown,
  delay = DEFAULT_DEBOUNCE_DELAY,
): Debounced<Params> {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = (...args: Params) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, delay)
    // Deno and Node expose `unref`; browsers do not.
    const handle = timer as unknown as { unref?: () => void }
    handle.unref?.()
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  debounced.pending = () => timer !== null
  return debounced
}
