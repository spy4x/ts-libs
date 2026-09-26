/**
 * Turn operating-system signals (`SIGINT`, `SIGTERM`) into one `AbortSignal`, so a worker loop
 * that already takes a signal stops cleanly on Ctrl+C or a container stop.
 *
 * Windows: the default list works with Deno 2.7.6 or later, where `SIGTERM` fires on logoff and
 * system shutdown.
 *
 * @module
 */

/** The reason a {@link shutdownSignal} carries when an operating-system signal aborted it. */
export class ShutdownSignalError extends Error {
  /** The signal that fired first. */
  readonly signal: Deno.Signal

  /** @param signal The signal that fired first. */
  constructor(signal: Deno.Signal) {
    super(`Received ${signal}`)
    this.name = "ShutdownSignalError"
    this.signal = signal
  }
}

/** Options for {@link shutdownSignal}. */
export interface ShutdownSignalOptions {
  /** The signals to listen for. Defaults to `["SIGINT", "SIGTERM"]`. */
  signals?: readonly Deno.Signal[]
  /**
   * A parent signal. When it aborts first, every listener is removed and the returned signal
   * aborts with the parent's reason, so a caller that stops for another reason leaks nothing.
   */
  signal?: AbortSignal
  /** Registers a listener. Defaults to `Deno.addSignalListener`; injected by tests. */
  addSignalListener?: (signal: Deno.Signal, handler: () => void) => void
  /** Removes a listener. Defaults to `Deno.removeSignalListener`; injected by tests. */
  removeSignalListener?: (signal: Deno.Signal, handler: () => void) => void
  /**
   * Receives an error thrown while removing a listener. Removal runs inside a signal or abort
   * callback, where a thrown error would end the process before the caller's cleanup finishes,
   * so it is reported here instead. Defaults to `console.error`.
   */
  onError?: (error: unknown) => void
}

/**
 * Return an `AbortSignal` that aborts on the first of `options.signals` (default `SIGINT` and
 * `SIGTERM`). It aborts exactly once, with a {@link ShutdownSignalError} naming the signal, and
 * on that first signal removes every listener it added, so a second Ctrl+C falls back to Deno's
 * default behaviour and ends the process.
 *
 * If registering one of the signals throws, the listeners already added are removed before that
 * error is rethrown. If removing a listener throws, every other listener is still removed, the
 * signal still aborts, and the error goes to `options.onError` (default `console.error`) instead of
 * being thrown out of a callback nobody can catch.
 *
 * @example
 * ```ts
 * const signal = shutdownSignal()
 * await processor.run(signal)
 * ```
 */
export function shutdownSignal(options: ShutdownSignalOptions = {}): AbortSignal {
  const signals = options.signals ?? ["SIGINT", "SIGTERM"]
  const add = options.addSignalListener ?? Deno.addSignalListener
  const remove = options.removeSignalListener ?? Deno.removeSignalListener
  const parent = options.signal
  const onError = options.onError ?? console.error
  const controller = new AbortController()

  if (parent?.aborted) {
    controller.abort(parent.reason)
    return controller.signal
  }

  const handlers = new Map<Deno.Signal, () => void>()

  /** Remove every listener, trying each one and reporting every removal error to `onError`. */
  const detach = () => {
    for (const [signal, handler] of handlers) {
      try {
        remove(signal, handler)
      } catch (error) {
        onError(error)
      }
    }
    handlers.clear()
    parent?.removeEventListener("abort", onParentAbort)
  }

  // Removing every listener before aborting is what makes a later signal a no-op; `abort` itself
  // ignores a second call, so no separate guard is needed.
  const stop = (reason: unknown) => {
    detach()
    controller.abort(reason)
  }
  const onParentAbort = () => stop(parent?.reason)

  try {
    for (const signal of new Set(signals)) {
      const handler = () => stop(new ShutdownSignalError(signal))
      add(signal, handler)
      handlers.set(signal, handler)
    }
  } catch (error) {
    // Removal errors go to `onError`; the registration error is the one thrown.
    detach()
    throw error
  }

  parent?.addEventListener("abort", onParentAbort, { once: true })
  return controller.signal
}
