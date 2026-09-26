import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { shutdownSignal, ShutdownSignalError } from "./shutdown-signal.ts"

/** An in-memory stand-in for `Deno.addSignalListener`/`Deno.removeSignalListener`. */
function fakeSignals(options: { refuse?: Deno.Signal } = {}) {
  const listeners = new Map<Deno.Signal, Set<() => void>>()
  return {
    addSignalListener(signal: Deno.Signal, handler: () => void) {
      if (signal === options.refuse) throw new TypeError(`${signal} is not supported`)
      const set = listeners.get(signal) ?? new Set()
      set.add(handler)
      listeners.set(signal, set)
    },
    removeSignalListener(signal: Deno.Signal, handler: () => void) {
      listeners.get(signal)?.delete(handler)
    },
    /** Deliver `signal` to every listener registered for it now. */
    fire(signal: Deno.Signal) {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler()
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
})
