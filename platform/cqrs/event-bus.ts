import type { Event, EventConstructor } from "./types.ts"

/**
 * Called when a listener fails — throws synchronously or returns a rejected promise — instead of
 * letting the failure propagate. Defaults to `console.error`, the one sink a framework-agnostic
 * package can assume exists; a host with a real logger passes its own via the `EventBus`
 * constructor.
 */
export type EventBusErrorHandler = (
  eventClass: EventConstructor<Event<unknown>>,
  error: unknown,
) => void

const defaultErrorHandler: EventBusErrorHandler = (eventClass, error) => {
  console.error(`[event-bus] listener for ${eventClass.name} failed`, error)
}

/**
 * In-process publish/subscribe bus for one event class per subscription.
 *
 * `emit` schedules delivery on a microtask, after the call that raised the event returns, and
 * isolates listeners from each other: a listener that throws, or returns a promise that rejects,
 * is reported through {@link EventBusErrorHandler} instead of stopping the other listeners in the
 * same dispatch or crashing the process on an unhandled rejection. This differs from the template
 * this was ported from, whose `for` loop let the first throwing listener abort every listener
 * after it and surface as an uncaught exception inside the microtask — see `platform/README.md`
 * for the fix, verified with a listener that throws in `event-bus.test.ts`.
 *
 * Each `EventBus` instance owns its own listener map; two instances never share state.
 *
 * @example
 * ```ts
 * class UserCreated implements Event<{ id: number }> {
 *   constructor(public data: { id: number }) {}
 * }
 *
 * const bus = new EventBus()
 * const off = bus.on(UserCreated, (event) => console.log(event.data?.id))
 * bus.emit(new UserCreated({ id: 1 }))
 * off()
 * ```
 */
export class EventBus {
  private listeners: Map<
    EventConstructor<Event<unknown>>,
    Array<(event: Event<unknown>) => void | Promise<void>>
  > = new Map()

  constructor(private onListenerError: EventBusErrorHandler = defaultErrorHandler) {}

  /** Subscribe `callback` to every `eventClass` emitted from now on. Returns an unsubscribe. */
  on<T extends Event<unknown>>(
    eventClass: EventConstructor<T>,
    callback: (event: T) => void | Promise<void>,
  ): () => void {
    if (!this.listeners.get(eventClass)) {
      this.listeners.set(eventClass, [])
    }
    this.listeners.get(eventClass)!.push(
      callback as (event: Event<unknown>) => void | Promise<void>,
    )
    return () => {
      const callbacks = this.listeners.get(eventClass) || []
      this.listeners.set(eventClass, callbacks.filter((cb) => cb !== callback))
    }
  }

  /**
   * Subscribe `callback` to the next `eventClass` only, then unsubscribe.
   *
   * The unsubscribe runs before `callback`, not after, so a `callback` that throws still leaves
   * the subscription removed — otherwise a throwing "once" handler would never detach and would
   * run again on the next `emit`, defeating "once".
   */
  once<T extends Event<unknown>>(
    eventClass: EventConstructor<T>,
    callback: (event: T) => void | Promise<void>,
  ): () => void {
    let unsubscribe = (): void => {}
    unsubscribe = this.on(eventClass, (event) => {
      unsubscribe()
      return callback(event)
    })
    return unsubscribe
  }

  /**
   * Deliver `event` to every listener subscribed to its class, on a microtask.
   *
   * Listeners run in subscription order against a snapshot of the list taken when this microtask
   * runs, so a listener that subscribes or unsubscribes during dispatch affects only later `emit`
   * calls, never the one in progress. A synchronous throw or a rejected returned promise is caught
   * per listener and handed to the constructor's `onListenerError`, so it cannot stop a sibling
   * listener in the same dispatch.
   */
  emit<T extends Event<unknown>>(event: T): void {
    queueMicrotask(() => {
      const eventClass = event.constructor as EventConstructor<T>
      const callbacks = this.listeners.get(eventClass)
      if (!callbacks) {
        return
      }
      for (const callback of [...callbacks]) {
        try {
          const result = callback(event as Event<unknown>)
          if (result instanceof Promise) {
            result.catch((error) => this.onListenerError(eventClass, error))
          }
        } catch (error) {
          this.onListenerError(eventClass, error)
        }
      }
    })
  }
}
