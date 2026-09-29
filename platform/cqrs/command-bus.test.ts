import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { CommandBus } from "./command-bus.ts"
import type { Command } from "./types.ts"

class PingCommand implements Command<{ value: string }, { value: string }> {
  readonly __resultType?: { value: string }
  constructor(public data: { value: string }) {}
}

describe("CommandBus", () => {
  it("executes registered handler", async () => {
    const bus = new CommandBus()
    bus.register(PingCommand, (command) => Promise.resolve({ value: `pong:${command.data.value}` }))

    const result = await bus.execute(new PingCommand({ value: "hi" }))

    expect(result).toEqual({ value: "pong:hi" })
  })

  it("throws when handler missing", async () => {
    const bus = new CommandBus()

    await expect(bus.execute(new PingCommand({ value: "hi" }))).rejects.toThrow(
      "No handler registered for command: PingCommand",
    )
  })

  it("lists registered commands", () => {
    const bus = new CommandBus()
    bus.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))

    expect(bus.getRegisteredCommands()).toEqual(["PingCommand"])
  })

  it("shares no state between instances", () => {
    const busA = new CommandBus()
    busA.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))
    const busB = new CommandBus()

    expect(busB.getRegisteredCommands()).toEqual([])
  })
})

describe("CommandBus middleware", () => {
  it("runs middlewares in registration order, outermost first, around the handler", async () => {
    const order: string[] = []
    const bus = new CommandBus()
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
    bus.register(PingCommand, (command) => {
      order.push("handler")
      return Promise.resolve({ value: command.data.value })
    })

    expect(await bus.execute(new PingCommand({ value: "pong" }))).toEqual({ value: "pong" })
    expect(order).toEqual([
      "first:before",
      "second:before",
      "handler",
      "second:after",
      "first:after",
    ])
  })

  it("hands the middleware the command instance, so it can read its class and payload", async () => {
    const seen: unknown[] = []
    const bus = new CommandBus()
    bus.use((message, next) => {
      seen.push(message.constructor, message.data)
      return next()
    })
    bus.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))

    await bus.execute(new PingCommand({ value: "hi" }))

    expect(seen).toEqual([PingCommand, { value: "hi" }])
  })

  it("stops before the handler when a middleware rejects", async () => {
    let handled = false
    const bus = new CommandBus()
    bus.use(() => Promise.reject(new Error("blocked")))
    bus.register(PingCommand, () => {
      handled = true
      return Promise.resolve({ value: "unreachable" })
    })

    await expect(bus.execute(new PingCommand({ value: "x" }))).rejects.toThrow("blocked")
    expect(handled).toBe(false)
  })

  it("turns a synchronous throw into a rejected next() for the middleware around it", async () => {
    let outerSaw: unknown
    const bus = new CommandBus()
    bus.use((_message, next) =>
      next().catch((error) => {
        outerSaw = error
        throw error
      })
    )
    bus.use(() => {
      throw new Error("thrown synchronously")
    })
    bus.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))

    await expect(bus.execute(new PingCommand({ value: "x" }))).rejects.toThrow(
      "thrown synchronously",
    )
    expect(outerSaw).toBeInstanceOf(Error)
  })

  it("returns a middleware's own value when it does not call next()", async () => {
    let handled = false
    const bus = new CommandBus()
    bus.use(() => Promise.resolve({ value: "from middleware" }))
    bus.register(PingCommand, () => {
      handled = true
      return Promise.resolve({ value: "from handler" })
    })

    expect(await bus.execute(new PingCommand({ value: "x" }))).toEqual({
      value: "from middleware",
    })
    expect(handled).toBe(false)
  })

  it("rejects a second next() call instead of running the handler again", async () => {
    let handlerRuns = 0
    const bus = new CommandBus()
    bus.use(async (_message, next) => {
      await next()
      return await next()
    })
    bus.register(PingCommand, (command) => {
      handlerRuns++
      return Promise.resolve({ value: command.data.value })
    })

    await expect(bus.execute(new PingCommand({ value: "x" }))).rejects.toThrow(
      "called next() more than once",
    )
    expect(handlerRuns).toBe(1)
  })

  it("dispatches straight to the handler when no middleware is registered", async () => {
    const bus = new CommandBus()
    bus.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))

    expect(await bus.execute(new PingCommand({ value: "direct" }))).toEqual({ value: "direct" })
  })

  it("keeps a middleware added during a dispatch out of that dispatch", async () => {
    let lateRuns = 0
    const bus = new CommandBus()
    bus.use((_message, next) => {
      bus.use((_m, innerNext) => {
        lateRuns++
        return innerNext()
      })
      return next()
    })
    bus.register(PingCommand, (command) => Promise.resolve({ value: command.data.value }))

    await bus.execute(new PingCommand({ value: "x" }))

    expect(lateRuns).toBe(0)
  })
})
