/**
 * Shapes shared by {@link CommandBus}, {@link QueryBus} and {@link EventBus}: a message carries its
 * `data`, and a phantom `__resultType` property lets `execute` infer the handler's return type
 * from the message class alone, with no cast at the call site.
 */

/** A write intent: `TPayload` in, `TResult` out. */
export interface Command<TPayload, TResult> {
  data: TPayload
  /** Never set at runtime — read only by {@link CommandResult} to infer the handler's return type. */
  readonly __resultType?: TResult
}

/** A read intent: `TPayload` in, `TResult` out. */
export interface Query<TPayload, TResult> {
  data: TPayload
  /** Never set at runtime — read only by {@link QueryResult} to infer the handler's return type. */
  readonly __resultType?: TResult
}

/** A class implementing {@link Command}, matched by `CommandBus.register`/`execute`. */
// deno-lint-ignore no-explicit-any
export type CommandConstructor<T extends Command<unknown, unknown>> = new (...args: any[]) => T

/** A class implementing {@link Query}, matched by `QueryBus.register`/`execute`. */
// deno-lint-ignore no-explicit-any
export type QueryConstructor<T extends Query<unknown, unknown>> = new (...args: any[]) => T

/** The result type a {@link Command} class carries, extracted from its phantom `__resultType`. */
export type CommandResult<T extends Command<unknown, unknown>> = T extends Command<unknown, infer R>
  ? R
  : never

/** The result type a {@link Query} class carries, extracted from its phantom `__resultType`. */
export type QueryResult<T extends Query<unknown, unknown>> = T extends Query<unknown, infer R> ? R
  : never

/** Handler a {@link CommandBus} runs for one command class. */
export type CommandHandler<T extends Command<unknown, unknown>> = (
  command: T,
) => Promise<CommandResult<T>>

/** Handler a {@link QueryBus} runs for one query class. */
export type QueryHandler<T extends Query<unknown, unknown>> = (
  query: T,
) => Promise<QueryResult<T>>

/** A fact an {@link EventBus} distributes to its subscribers. */
export interface Event<TPayload> {
  data?: TPayload
}

/** A class implementing {@link Event}, matched by `EventBus.on`/`once`/`emit`. */
// deno-lint-ignore no-explicit-any
export type EventConstructor<T extends Event<unknown>> = new (...args: any[]) => T
