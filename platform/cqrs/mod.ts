/**
 * `@spy4x/platform/cqrs` — an in-process command bus, query bus and event bus.
 *
 * - {@link CommandBus} — one handler per command class, type-inferred result.
 * - {@link QueryBus} — same shape as `CommandBus`, kept distinct so a read cannot register where a
 *   write is expected.
 * - {@link EventBus} — publish/subscribe, delivered on a microtask, with per-listener error
 *   isolation (see `event-bus.ts` for what changed from the source this was ported from).
 *
 * `CommandBus.use` and `QueryBus.use` add a {@link CqrsMiddleware}: a step that runs around every
 * dispatch, before the handler, and may stop it.
 *
 * None of the three keeps state outside its own instance.
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
