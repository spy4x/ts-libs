import type { Command, CqrsMiddleware, Query } from "./types.ts"

/**
 * Runs `middlewares` around `handler` for one message, the first registered outermost.
 *
 * Each step is awaited inside an `async` function, so a middleware that throws synchronously
 * rejects the dispatch the same way one that returns a rejected promise does, and the middleware
 * around it sees a rejected `next()` rather than a synchronous throw. A middleware that calls
 * `next()` a second time gets a rejection instead of running the rest of the chain, and the
 * handler, twice.
 */
export function runMiddlewares(
  middlewares: readonly CqrsMiddleware[],
  message: Command<unknown, unknown> | Query<unknown, unknown>,
  handler: () => Promise<unknown>,
): Promise<unknown> {
  let lastCalled = -1
  const step = async (index: number): Promise<unknown> => {
    if (index <= lastCalled) {
      throw new Error(`A CQRS middleware called next() more than once`)
    }
    lastCalled = index
    const middleware = middlewares[index]
    if (!middleware) return await handler()
    return await middleware(message, () => step(index + 1))
  }
  return step(0)
}
