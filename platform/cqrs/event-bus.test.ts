import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { EventBus } from "./event-bus.ts"
import type { Event } from "./types.ts"

class PingEvent implements Event<{ value: string }> {
  constructor(public data: { value: string }) {}
}

/** Every `emit` schedules delivery on a microtask; flush it before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => resolve()))
}

describe("EventBus", () => {
  it("emits to listeners", async () => {
    const bus = new EventBus()
    let received: string | null = null
    bus.on(PingEvent, (event) => {
      received = event.data?.value ?? null
    })

    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(received).toBe("ok")
  })

  it("unsubscribes from listener", async () => {
    const bus = new EventBus()
    let hits = 0
    const off = bus.on(PingEvent, () => {
      hits += 1
    })

    off()
    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(hits).toBe(0)
  })

  it("keeps another subscription of the same function when one unsubscribes", async () => {
    const bus = new EventBus()
    const seen: string[] = []
    const refresh = (event: PingEvent) => {
      seen.push(event.data.value)
    }
    bus.on(PingEvent, refresh)
    const off = bus.on(PingEvent, refresh)

    off()
    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(seen).toEqual(["ok"])
  })

  it("removes only one registration when the same unsubscribe is called twice", async () => {
    const bus = new EventBus()
    const seen: string[] = []
    const refresh = (event: PingEvent) => {
      seen.push(event.data.value)
    }
    bus.on(PingEvent, refresh)
    bus.on(PingEvent, refresh)
    const off = bus.on(PingEvent, refresh)

    off()
    off()
    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(seen).toEqual(["ok", "ok"])
  })

  it("once fires once", async () => {
    const bus = new EventBus()
    let hits = 0
    bus.once(PingEvent, () => {
      hits += 1
    })

    bus.emit(new PingEvent({ value: "a" }))
    bus.emit(new PingEvent({ value: "b" }))
    await flush()

    expect(hits).toBe(1)
  })

  it("does not stop other listeners when one throws", async () => {
    const bus = new EventBus(() => {}) // silence the default console.error for this case
    let secondRan = false
    bus.on(PingEvent, () => {
      throw new Error("boom")
    })
    bus.on(PingEvent, () => {
      secondRan = true
    })

    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(secondRan).toBe(true)
  })

  it("reports a throwing listener through onListenerError instead of throwing", async () => {
    const errors: unknown[] = []
    const bus = new EventBus((_eventClass, error) => errors.push(error))
    bus.on(PingEvent, () => {
      throw new Error("boom")
    })

    bus.emit(new PingEvent({ value: "ok" }))
    await flush()

    expect(errors).toEqual([new Error("boom")])
  })

  it("reports a rejected async listener through onListenerError", async () => {
    const errors: unknown[] = []
    const bus = new EventBus((_eventClass, error) => errors.push(error))
    bus.on(PingEvent, () => Promise.reject(new Error("async boom")))

    bus.emit(new PingEvent({ value: "ok" }))
    await flush()
    await flush() // one more tick for the rejected promise's `.catch` to run

    expect(errors).toEqual([new Error("async boom")])
  })

  it("does not run a listener subscribed during the current dispatch until the next emit", async () => {
    const bus = new EventBus()
    const ran: string[] = []
    bus.on(PingEvent, () => {
      ran.push("first")
      bus.on(PingEvent, () => {
        ran.push("late")
      })
    })

    bus.emit(new PingEvent({ value: "a" }))
    await flush()

    expect(ran).toEqual(["first"])

    bus.emit(new PingEvent({ value: "b" }))
    await flush()

    expect(ran).toEqual(["first", "first", "late"])
  })

  it("unsubscribes a once listener even when it throws", async () => {
    const bus = new EventBus(() => {})
    let hits = 0
    bus.once(PingEvent, () => {
      hits += 1
      throw new Error("boom")
    })

    bus.emit(new PingEvent({ value: "a" }))
    await flush()
    bus.emit(new PingEvent({ value: "b" }))
    await flush()

    expect(hits).toBe(1)
  })
})
