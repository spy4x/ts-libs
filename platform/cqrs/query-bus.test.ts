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
