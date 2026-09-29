import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { QueryBus } from "./query-bus.ts"
import type { Query } from "./types.ts"

class PingQuery implements Query<{ value: string }, { value: string }> {
  readonly __resultType?: { value: string }
  constructor(public data: { value: string }) {}
}

describe("QueryBus", () => {
  it("executes registered handler", async () => {
    const bus = new QueryBus()
    bus.register(PingQuery, (query) => Promise.resolve({ value: `pong:${query.data.value}` }))

    const result = await bus.execute(new PingQuery({ value: "hi" }))

    expect(result).toEqual({ value: "pong:hi" })
  })

  it("throws when handler missing", async () => {
    const bus = new QueryBus()

    await expect(bus.execute(new PingQuery({ value: "hi" }))).rejects.toThrow(
      "No handler registered for query: PingQuery",
    )
  })

  it("lists registered queries", () => {
    const bus = new QueryBus()
    bus.register(PingQuery, (query) => Promise.resolve({ value: query.data.value }))

    expect(bus.getRegisteredQueries()).toEqual(["PingQuery"])
  })

  it("shares no state between instances", () => {
    const busA = new QueryBus()
    busA.register(PingQuery, (query) => Promise.resolve({ value: query.data.value }))
    const busB = new QueryBus()

    expect(busB.getRegisteredQueries()).toEqual([])
  })
})

describe("QueryBus middleware", () => {
  it("runs middlewares in registration order, outermost first, around the handler", async () => {
    const order: string[] = []
    const bus = new QueryBus()
    bus.use(async (_message, next) => {
      order.push("first:before")
      const result = await next()
      order.push("first:after")
      return result
    })
    bus.use(async (_message, next) => {
      order.push("second:before")
      const result = await next()
      order.push("second:after")
      return result
    })
    bus.register(PingQuery, (query) => {
      order.push("handler")
      return Promise.resolve({ value: query.data.value })
    })

    expect(await bus.execute(new PingQuery({ value: "pong" }))).toEqual({ value: "pong" })
    expect(order).toEqual([
      "first:before",
      "second:before",
      "handler",
      "second:after",
      "first:after",
    ])
  })

  it("hands the middleware the query instance, so it can read its class and payload", async () => {
    const seen: unknown[] = []
    const bus = new QueryBus()
    bus.use((message, next) => {
      seen.push(message.constructor, message.data)
      return next()
    })
    bus.register(PingQuery, (query) => Promise.resolve({ value: query.data.value }))

    await bus.execute(new PingQuery({ value: "hi" }))

    expect(seen).toEqual([PingQuery, { value: "hi" }])
  })

  it("stops before the handler when a middleware rejects", async () => {
    let handled = false
    const bus = new QueryBus()
    bus.use(() => Promise.reject(new Error("blocked")))
    bus.register(PingQuery, () => {
      handled = true
      return Promise.resolve({ value: "unreachable" })
    })

    await expect(bus.execute(new PingQuery({ value: "x" }))).rejects.toThrow("blocked")
    expect(handled).toBe(false)
  })

  it("dispatches straight to the handler when no middleware is registered", async () => {
    const bus = new QueryBus()
    bus.register(PingQuery, (query) => Promise.resolve({ value: query.data.value }))

    expect(await bus.execute(new PingQuery({ value: "direct" }))).toEqual({ value: "direct" })
  })
})
