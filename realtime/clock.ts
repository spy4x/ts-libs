/**
 * Time and timer ports.
 *
 * Every timing behaviour in this package goes through a {@link Clock}, so tests drive a
 * deterministic scheduler instead of sleeping, and no module reads `Date.now` or the timer globals
 * at import time.
 */

import { type Clock as PlatformClock, systemClock } from "@spy4x/platform/universal/time"

/** Opaque handle to a scheduled callback. */
export interface TimerHandle {
  /** Identifier, unique within the clock that issued the handle. */
  readonly id: number
}

/**
 * Time source and timer factory. Implementations: {@link createSystemClock}, `FakeClock`.
 *
 * Extends `Clock` from "@spy4x/platform/universal/time" (`#71`) with the timer methods this
 * package's transport needs on top of the plain instant source.
 */
export interface Clock extends PlatformClock {
  setInterval(callback: () => void, ms: number): TimerHandle
  clearInterval(handle: TimerHandle): void
  setTimeout(callback: () => void, ms: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/**
 * Clock backed by the platform timers.
 *
 * The globals are read at call time rather than captured at import time, so the module stays safe
 * to import on a server, in a worker and in a test that replaces `globalThis`. `now` delegates to
 * `@spy4x/platform/universal/time`'s `systemClock`, the same `Date.now()` read as before.
 */
export function createSystemClock(): Clock {
  return {
    ...systemClock,
    setInterval: (callback, ms) => ({
      id: Number(globalThis.setInterval(callback, ms)),
    }),
    clearInterval: (handle) => globalThis.clearInterval(handle.id),
    setTimeout: (callback, ms) => ({
      id: Number(globalThis.setTimeout(callback, ms)),
    }),
    clearTimeout: (handle) => globalThis.clearTimeout(handle.id),
  }
}
