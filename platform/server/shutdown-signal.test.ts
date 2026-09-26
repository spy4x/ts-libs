import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { shutdownSignal, ShutdownSignalError } from "./shutdown-signal.ts"

/** An in-memory stand-in for `Deno.addSignalListener`/`Deno.removeSignalListener`. */
function fakeSignals(options: { refuse?: Deno.Signal; stuck?: Deno.Signal } = {}) {
  const listeners = new Map<Deno.Signal, Set<() => void>>()
  return {
    addSignalListener(signal: Deno.Signal, handler: () => void) {
      if (signal === options.refuse) throw new TypeError(`${signal} is not supported`)
      const set = listeners.get(signal) ?? new Set()
      set.add(handler)
      listeners.set(signal, set)
    },
    removeSignalListener(signal: Deno.Signal, handler: () => void) {
      if (signal === options.stuck) throw new Error(`cannot remove ${signal}`)
      listeners.get(signal)?.delete(handler)
    },
    /** Deliver `signal` to every listener registered for it now. */
    fire(signal: Deno.Signal) {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler()
    },
    /** How many listeners are registered for `signal`. */
    countFor(signal: Deno.Signal): number {
      return listeners.get(signal)?.size ?? 0
    },
    /** How many listeners are registered across every signal. */
    count(): number {
      let total = 0
      for (const set of listeners.values()) total += set.size
      return total
    },
    listening(): Deno.Signal[] {
      return [...listeners].filter(([, set]) => set.size > 0).map(([signal]) => signal)
    },
  }
}

describe("shutdownSignal", () => {
  it("listens for SIGINT and SIGTERM by default", () => {
    const fake = fakeSignals()
    shutdownSignal(fake)
    expect(fake.listening()).toEqual(["SIGINT", "SIGTERM"])
  })

  it("aborts once on the first signal", () => {
    const fake = fakeSignals()
    const signal = shutdownSignal(fake)
    let aborts = 0
    signal.addEventListener("abort", () => aborts++)
    expect(signal.aborted).toBe(false)
    fake.fire("SIGTERM")
    expect(signal.aborted).toBe(true)
    expect(aborts).toBe(1)
  })

  it("ignores a second signal after the first", () => {
    const fake = fakeSignals()
    const signal = shutdownSignal(fake)
    let aborts = 0
    signal.addEventListener("abort", () => aborts++)
    fake.fire("SIGINT")
    const reason = signal.reason
    fake.fire("SIGTERM")
    fake.fire("SIGINT")
    expect(aborts).toBe(1)
    expect(signal.reason).toBe(reason)
  })

  it("removes every listener on the first signal", () => {
    const fake = fakeSignals()
    shutdownSignal(fake)
    expect(fake.count()).toBe(2)
    fake.fire("SIGINT")
    expect(fake.count()).toBe(0)
  })

  it("listens only for a custom signal list", () => {
    const fake = fakeSignals()
    const signal = shutdownSignal({ ...fake, signals: ["SIGHUP"] })
    expect(fake.listening()).toEqual(["SIGHUP"])
    fake.fire("SIGINT")
    expect(signal.aborted).toBe(false)
    fake.fire("SIGHUP")
    expect(signal.aborted).toBe(true)
  })

  it("names the signal that fired in the abort reason", () => {
    const fake = fakeSignals()
    const signal = shutdownSignal(fake)
    fake.fire("SIGTERM")
    expect(signal.reason).toBeInstanceOf(ShutdownSignalError)
    expect(signal.reason.signal).toBe("SIGTERM")
    expect(signal.reason.message).toBe("Received SIGTERM")
  })

  it("removes every listener and takes the parent's reason when the parent aborts first", () => {
    const fake = fakeSignals()
    const parent = new AbortController()
    const signal = shutdownSignal({ ...fake, signal: parent.signal })
    parent.abort("done")
    expect(signal.aborted).toBe(true)
    expect(signal.reason).toBe("done")
    expect(fake.count()).toBe(0)
  })

  it("adds no listener when the parent is already aborted", () => {
    const fake = fakeSignals()
    const parent = new AbortController()
    parent.abort("early")
    const signal = shutdownSignal({ ...fake, signal: parent.signal })
    expect(signal.reason).toBe("early")
    expect(fake.count()).toBe(0)
  })

  it("removes the listeners it added when registering a later signal throws", () => {
    const fake = fakeSignals({ refuse: "SIGTERM" })
    expect(() => shutdownSignal(fake)).toThrow(TypeError)
    expect(fake.count()).toBe(0)
  })

  it("registers a signal listed twice only once", () => {
    const fake = fakeSignals()
    shutdownSignal({ ...fake, signals: ["SIGINT", "SIGINT"] })
    expect(fake.countFor("SIGINT")).toBe(1)
  })

  it("stops following the parent once a signal has fired", () => {
    const fake = fakeSignals()
    let parentListeners = 0
    const tracked = {
      aborted: false,
      reason: undefined,
      addEventListener: () => parentListeners++,
      removeEventListener: () => parentListeners--,
    } as unknown as AbortSignal
    shutdownSignal({ ...fake, signal: tracked })
    expect(parentListeners).toBe(1)
    fake.fire("SIGINT")
    expect(parentListeners).toBe(0)
  })

  it("still aborts and removes the other listeners when one removal throws", () => {
    const fake = fakeSignals({ stuck: "SIGINT" })
    const reported: unknown[] = []
    const signal = shutdownSignal({
      ...fake,
      signals: ["SIGINT", "SIGTERM", "SIGHUP"],
      onError: (error) => reported.push(error),
    })
    expect(() => fake.fire("SIGTERM")).not.toThrow()
    expect(reported.map((error) => (error as Error).message)).toEqual(["cannot remove SIGINT"])
    expect(signal.aborted).toBe(true)
    expect(signal.reason.signal).toBe("SIGTERM")
    expect(fake.countFor("SIGTERM")).toBe(0)
    expect(fake.countFor("SIGHUP")).toBe(0)
  })

  it("throws the registration error and reports a rollback removal that also throws", () => {
    const fake = fakeSignals({ stuck: "SIGINT", refuse: "SIGHUP" })
    const reported: unknown[] = []
    const onError = (error: unknown) => reported.push(error)
    expect(() => shutdownSignal({ ...fake, signals: ["SIGINT", "SIGTERM", "SIGHUP"], onError }))
      .toThrow("SIGHUP is not supported")
    expect(fake.countFor("SIGTERM")).toBe(0)
    expect(reported.map((error) => (error as Error).message)).toEqual(["cannot remove SIGINT"])
  })
})
