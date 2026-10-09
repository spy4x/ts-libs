import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  createSyncRunner,
  flushOutbox,
  type SyncFlushResult,
  type SyncRunnerState,
  type SyncRunnerTarget,
} from "./sync-runner.ts"
import { drainMicrotasks, FakeClock } from "./testing.ts"

function createPage() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const add = (type: string, listener: (event: Event) => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)!.add(listener)
  }
  const remove = (type: string, listener: (event: Event) => void) => {
    listeners.get(type)?.delete(listener)
  }
  const page = {
    visibilityState: "visible",
    fire(type: string, init: { persisted?: boolean } = {}) {
      const event = Object.assign(new Event(type), init)
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event)
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    target: {
      document: {
        get visibilityState() {
          return page.visibilityState
        },
        addEventListener: add,
        removeEventListener: remove,
      },
      addEventListener: add,
      removeEventListener: remove,
    } as SyncRunnerTarget,
  }
  return page
}

/** A flush the test settles by hand, run by run. */
function controlledFlush() {
  const runs: Array<{ resolve(result?: SyncFlushResult): void; reject(error: unknown): void }> = []
  return {
    runs,
    started: () => runs.length,
    flush: () =>
      new Promise<SyncFlushResult>((resolve, reject) => {
        runs.push({ resolve, reject })
      }),
    /** Settles the latest run and lets the runner react. */
    async finish(result?: SyncFlushResult) {
      runs[runs.length - 1].resolve(result)
      await drainMicrotasks()
    },
    async fail(error: unknown = new Error("boom")) {
      runs[runs.length - 1].reject(error)
      await drainMicrotasks()
    },
  }
}

function setup(overrides: { baseDelayMs?: number; maxDelayMs?: number } = {}) {
  const page = createPage()
  const clock = new FakeClock()
  const control = controlledFlush()
  const runner = createSyncRunner({
    flush: control.flush,
    target: page.target,
    clock,
    random: () => 1, // the longest delay jitter allows, so delays equal the plain schedule
    ...overrides,
  })
  return { page, clock, control, runner }
}

describe("createSyncRunner runs", () => {
  it("runs once when it starts", async () => {
    const { runner, control } = setup()
    runner.start()
    await drainMicrotasks()
    expect(control.started()).toBe(1)
  })

  it("does not run before it starts, nor on a kick", async () => {
    const { runner, control } = setup()
    await runner.kick()
    expect(control.started()).toBe(0)
  })

  it("runs when the browser goes online", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await control.finish()

    page.fire("online")
    await drainMicrotasks()

    expect(control.started()).toBe(2)
  })

  it("runs when the page becomes visible and not when it is hidden", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await control.finish()

    page.visibilityState = "hidden"
    page.fire("visibilitychange")
    await drainMicrotasks()
    expect(control.started()).toBe(1)

    page.visibilityState = "visible"
    page.fire("visibilitychange")
    await drainMicrotasks()
    expect(control.started()).toBe(2)
  })

  it("runs when the window gains focus", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await control.finish()

    page.fire("focus")
    await drainMicrotasks()

    expect(control.started()).toBe(2)
  })

  it("runs when a page is restored from the back-forward cache", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await control.finish()

    page.fire("pageshow", { persisted: true })
    await drainMicrotasks()

    expect(control.started()).toBe(2)
  })

  it("runs on demand and resolves when that run has finished", async () => {
    const { runner, control } = setup()
    runner.start()
    await control.finish()

    let done = false
    const kicked = runner.kick().then(() => done = true)
    await drainMicrotasks()
    expect(control.started()).toBe(2)
    expect(done).toBe(false)

    await control.finish()
    await kicked
    expect(done).toBe(true)
  })

  it("starts listening once however often it is started", async () => {
    const { runner, control, page } = setup()
    runner.start()
    runner.start()
    await drainMicrotasks()

    expect(control.started()).toBe(1)
    expect(page.count()).toBe(4)
  })
})

describe("createSyncRunner one run at a time", () => {
  it("never runs two at once", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await drainMicrotasks()

    page.fire("online")
    page.fire("focus")
    await drainMicrotasks()

    expect(control.started()).toBe(1)
  })

  it("runs exactly once more after a run that was kicked several times meanwhile", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await drainMicrotasks()

    page.fire("online")
    page.fire("focus")
    void runner.kick()
    void runner.kick()
    await control.finish()
    expect(control.started()).toBe(2)

    await control.finish()
    expect(control.started()).toBe(2)
    expect(runner.getState().running).toBe(false)
  })

  it("resolves a kick made during a run only when the extra run has finished", async () => {
    const { runner, control } = setup()
    runner.start()
    await drainMicrotasks()
    let done = false
    const kicked = runner.kick().then(() => done = true)

    await control.finish()
    await drainMicrotasks()
    expect(done).toBe(false)

    await control.finish()
    await kicked
    expect(done).toBe(true)
  })
})

describe("createSyncRunner retries", () => {
  it("retries a flush that threw after a growing delay, doubling per failure in a row", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await control.fail()

    await clock.advance(999)
    expect(control.started()).toBe(1)
    await clock.advance(1)
    expect(control.started()).toBe(2)

    await control.fail()
    await clock.advance(1999)
    expect(control.started()).toBe(2)
    await clock.advance(1)
    expect(control.started()).toBe(3)

    await control.fail()
    await clock.advance(4000)
    expect(control.started()).toBe(4)
  })

  it("retries a flush that could not reach the server", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await control.finish("unreachable")

    await clock.advance(1000)

    expect(control.started()).toBe(2)
  })

  it("never waits longer than the longest delay", async () => {
    const { runner, control, clock } = setup({ baseDelayMs: 1000, maxDelayMs: 3000 })
    runner.start()
    for (let i = 0; i < 6; i++) {
      await control.finish("unreachable")
      await clock.advance(3000)
    }
    expect(control.started()).toBe(7)
  })

  it("starts the delays again after a run that completed", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await control.fail()
    await clock.advance(1000)
    await control.fail()
    await clock.advance(2000)
    await control.finish()
    expect(runner.getState().failures).toBe(0)

    void runner.kick()
    await drainMicrotasks()
    await control.finish("unreachable")
    await clock.advance(1000)

    expect(control.started()).toBe(5)
  })

  it("replaces the wait with an immediate run when the network comes back", async () => {
    const { runner, control, clock, page } = setup()
    runner.start()
    await control.fail()
    expect(clock.pendingTimers).toBe(1)

    page.fire("online")
    await drainMicrotasks()

    expect(control.started()).toBe(2)
    expect(clock.pendingTimers).toBe(0)
    expect(runner.getState().nextRetryAt).toBeNull()
  })

  it("does not run the cancelled retry again at its old time", async () => {
    const { runner, control, clock, page } = setup()
    runner.start()
    await control.fail()
    page.fire("online")
    await control.finish()

    await clock.advance(10_000)

    expect(control.started()).toBe(2)
  })

  it("runs a kick that arrived during a failing run at once, not after the delay", async () => {
    const { runner, control, clock, page } = setup()
    runner.start()
    await drainMicrotasks()
    page.fire("online")

    await control.fail()

    expect(control.started()).toBe(2)
    expect(clock.pendingTimers).toBe(0)
  })
})

describe("createSyncRunner state", () => {
  it("shows a run in progress and then the quiet state", async () => {
    const { runner, control } = setup()
    expect(runner.getState()).toEqual({
      running: false,
      lastError: null,
      failures: 0,
      nextRetryAt: null,
    })

    runner.start()
    await drainMicrotasks()
    expect(runner.getState().running).toBe(true)

    await control.finish()
    expect(runner.getState().running).toBe(false)
  })

  it("shows the error of a failed run and when the retry comes", async () => {
    const { runner, control, clock } = setup()
    await clock.advance(5000)
    runner.start()
    const error = new Error("socket closed")

    await control.fail(error)

    expect(runner.getState()).toEqual({
      running: false,
      lastError: error,
      failures: 1,
      nextRetryAt: 6000,
    })
  })

  it("shows no error for a server that could not be reached, only the retry", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await control.fail()
    await clock.advance(1000)

    await control.finish("unreachable")

    expect(runner.getState().lastError).toBeNull()
    expect(runner.getState().failures).toBe(2)
    expect(runner.getState().nextRetryAt).toBe(1000 + 2000)
  })

  it("clears the error after a run that completed", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await control.fail()
    await clock.advance(1000)
    await control.finish()

    expect(runner.getState().lastError).toBeNull()
    expect(runner.getState().failures).toBe(0)
  })

  it("tells subscribers about every change until they unsubscribe", async () => {
    const { runner, control } = setup()
    const seen: SyncRunnerState[] = []
    const unsubscribe = runner.subscribe((state) => seen.push(state))

    runner.start()
    await control.finish()
    expect(seen.map((s) => s.running)).toContain(true)
    expect(seen[seen.length - 1].running).toBe(false)

    unsubscribe()
    const count = seen.length
    void runner.kick()
    await control.finish()
    expect(seen.length).toBe(count)
  })
})

describe("createSyncRunner stop", () => {
  it("removes every listener and timer", async () => {
    const { runner, control, clock, page } = setup()
    runner.start()
    await control.fail()
    expect(page.count()).toBe(4)
    expect(clock.pendingTimers).toBe(1)

    runner.stop()

    expect(page.count()).toBe(0)
    expect(clock.pendingTimers).toBe(0)
    expect(runner.getState().nextRetryAt).toBeNull()
  })

  it("does not run again after it is stopped", async () => {
    const { runner, control, clock, page } = setup()
    runner.start()
    await control.fail()
    runner.stop()

    page.fire("online")
    await clock.advance(120_000)
    await runner.kick()

    expect(control.started()).toBe(1)
  })

  it("schedules no retry when it is stopped during a run that then fails", async () => {
    const { runner, control, clock } = setup()
    runner.start()
    await drainMicrotasks()

    runner.stop()
    await control.fail()

    expect(clock.pendingTimers).toBe(0)
    expect(runner.getState().running).toBe(false)
  })

  it("can be started again after it was stopped", async () => {
    const { runner, control, page } = setup()
    runner.start()
    await control.finish()
    runner.stop()

    runner.start()
    await drainMicrotasks()

    expect(control.started()).toBe(2)
    expect(page.count()).toBe(4)
  })
})

describe("flushOutbox", () => {
  const outboxWith = (...statuses: Array<"pending" | "conflict">) => {
    let flushed = 0
    return {
      outbox: {
        flush: () => {
          flushed++
          return Promise.resolve()
        },
        entries: () => statuses.map((status) => ({ status })),
      },
      flushed: () => flushed,
    }
  }

  it("completes when the queue is empty after the flush", async () => {
    const { outbox, flushed } = outboxWith()
    expect(await flushOutbox(outbox)()).toBeUndefined()
    expect(flushed()).toBe(1)
  })

  it("asks for a retry when a write is still waiting after the flush", async () => {
    expect(await flushOutbox(outboxWith("pending").outbox)()).toBe("unreachable")
  })

  it("completes when only conflicts remain, because they wait for a person", async () => {
    expect(await flushOutbox(outboxWith("conflict").outbox)()).toBeUndefined()
  })
})
