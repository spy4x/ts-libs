/**
 * `@ts-libs/platform/cqrs` — an in-process command bus, query bus and event bus.
 *
 * - {@link CommandBus} — one handler per command class, type-inferred result.
 * - {@link QueryBus} — same shape as `CommandBus`, kept distinct so a read cannot register where a
 *   write is expected.
 * - {@link EventBus} — publish/subscribe, delivered on a microtask, with per-listener error
 *   isolation (see `event-bus.ts` for what changed from the source this was ported from).
 *
 * None of the three keeps state outside its own instance.
 */

export { CommandBus } from "./command-bus.ts"
export { QueryBus } from "./query-bus.ts"
export { EventBus, type EventBusErrorHandler } from "./event-bus.ts"
export type {
  Command,
  CommandConstructor,
  CommandHandler,
  CommandResult,
  Event,
  EventConstructor,
  Query,
  QueryConstructor,
  QueryHandler,
  QueryResult,
} from "./types.ts"
