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
