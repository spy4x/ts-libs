/**
 * `@spy4x/platform/cqrs` — an in-process command bus, query bus and event bus.
 *
 * - {@link CommandBus} — one handler per command class, type-inferred result.
 * - {@link QueryBus} — same shape as `CommandBus`, kept distinct so a read cannot register where a
 *   write is expected.
 * - {@link EventBus} — publish/subscribe, delivered on a microtask, with per-listener error
 *   isolation.
 *
 * `CommandBus.use` and `QueryBus.use` add a {@link CqrsMiddleware}: a step that runs around every
 * dispatch, before the handler, and may stop it.
 *
 * None of the three keeps state outside its own instance.
 *
 * | Module             | Contents                                                           |
 * | ------------------ | ------------------------------------------------------------------ |
 * | `cqrs/command-bus` | `CommandBus` — one handler per command class                       |
 * | `cqrs/query-bus`   | `QueryBus` — same shape, kept a distinct type from the command bus |
 * | `cqrs/event-bus`   | `EventBus` — publish/subscribe, delivered on a microtask           |
 * | `cqrs/types`       | `Command`, `Query`, `Event` and their constructor/handler types    |
 * | `cqrs/middleware`  | internal: the runner behind `CommandBus.use` and `QueryBus.use`    |
 *
 * `EventBus.emit` isolates listeners from each other: a listener failure — a synchronous throw or a
 * rejected returned promise — is reported through a constructor-supplied `onListenerError`
 * (`console.error` by default) instead of aborting the listeners after it. `once` unsubscribes
 * before it calls the listener, so a throwing listener does not leak its subscription.
 *
 * ## Middleware
 *
 * `CommandBus.use(middleware)` and `QueryBus.use(middleware)` add a `CqrsMiddleware`: a step that runs
 * around every `execute`, whatever transport produced the message. Put checks there that are neither
 * transport mechanics nor business rules, such as session strength, auditing or tracing; one
 * registration covers every handler on that bus.
 *
 * ```ts
 * import { CommandBus, type CqrsMiddleware, QueryBus } from "@spy4x/platform/cqrs"
 *
 * const anonymous = new Set<unknown>([SignInCommand])
 * const requireActor: CqrsMiddleware = (message, next) => {
 *   if (anonymous.has(message.constructor)) return next()
 *   const data = message.data as { actor?: unknown }
 *   if (!data.actor) throw new Error(`${message.constructor.name} carries no actor`)
 *   return next()
 * }
 * commandBus.use(requireActor)
 * queryBus.use(requireActor)
 * ```
 *
 * - Middlewares run in registration order, the first registered outermost; the handler runs last.
 *   With none registered, `execute` calls the handler directly.
 * - A middleware receives the message instance itself, so `message.constructor` tells it the class
 *   and `message.data` the payload.
 * - It stops the dispatch by throwing, or by returning its own value without calling `next()`. A
 *   synchronous throw reaches the middleware around it as a rejected `next()`.
 * - Calling `next()` twice rejects with "called next() more than once" instead of running the rest of
 *   the chain and the handler again.
 * - A missing handler still throws before any middleware runs, and a middleware added during a
 *   dispatch applies from the next `execute`.
 *
 * `EventBus` has no `use`. `emit` returns nothing, delivers on a microtask to any number of listeners,
 * and isolates their failures, so a middleware there could not stop anything from the caller's point
 * of view and has no single result to wrap. A cross-cutting check on events belongs in the listener,
 * or before the `emit`.
 *
 * @module
 */

export { CommandBus } from "./command-bus.ts"
export { QueryBus } from "./query-bus.ts"
export { EventBus, type EventBusErrorHandler } from "./event-bus.ts"
export type {
  Command,
  CommandConstructor,
  CommandHandler,
  CommandResult,
  CqrsMiddleware,
  Event,
  EventConstructor,
  Query,
  QueryConstructor,
  QueryHandler,
  QueryResult,
} from "./types.ts"
