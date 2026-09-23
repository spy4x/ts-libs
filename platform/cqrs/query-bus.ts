import type { Query, QueryConstructor, QueryHandler, QueryResult } from "./types.ts"

/**
 * Routes a query instance to the one handler registered for its class, and infers the returned
 * value's type from the query class alone — no cast at the call site.
 *
 * Same shape as {@link CommandBus}, kept as a separate class rather than a shared generic base so
 * "read" and "write" stay two distinct types at the call site — registering a query handler on
 * the command bus, or vice versa, is a compile error, not a runtime one.
 *
 * Each `QueryBus` instance owns its own handler map; two instances never share state.
 *
 * @example
 * ```ts
 * class GetUser implements Query<{ id: number }, { id: number; name: string }> {
 *   readonly __resultType?: { id: number; name: string }
 *   constructor(public data: { id: number }) {}
 * }
 *
 * const bus = new QueryBus()
 * bus.register(GetUser, async (query) => ({ id: query.data.id, name: "Ada" }))
 * const user = await bus.execute(new GetUser({ id: 1 })) // { id: number; name: string }
 * ```
 */
export class QueryBus {
  private handlers: Map<
    QueryConstructor<Query<unknown, unknown>>,
    QueryHandler<Query<unknown, unknown>>
  > = new Map()

  /** Register `handler` as the one handler for `queryClass`. A second call replaces it. */
  register<T extends Query<unknown, unknown>>(
    queryClass: QueryConstructor<T>,
    handler: QueryHandler<T>,
  ): void {
    this.handlers.set(queryClass, handler as QueryHandler<Query<unknown, unknown>>)
  }

  /** Run the handler registered for `query`'s class. Throws when none is registered. */
  async execute<T extends Query<unknown, unknown>>(query: T): Promise<QueryResult<T>> {
    const QueryClass = query.constructor as QueryConstructor<T>
    const handler = this.handlers.get(QueryClass)

    if (!handler) {
      throw new Error(`No handler registered for query: ${QueryClass.name}`)
    }

    return await handler(query) as QueryResult<T>
  }

  /** Names of every query class with a registered handler, in registration order. */
  getRegisteredQueries(): string[] {
    return Array.from(this.handlers.keys()).map((qry) => qry.name)
  }
}
