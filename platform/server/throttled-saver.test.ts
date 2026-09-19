import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { fakeClock, fakeFs, fakeTimers } from "./_fake-fs.ts"
import { ThrottledJsonSaver } from "./throttled-saver.ts"

/**
 * Let a detached write finish. `markDirty` never returns a promise, so the write it starts can only
 * be awaited by yielding the event loop. A macrotask is used rather than a single microtask because
 * `atomicWriteJson` awaits several times; with the fake filesystem every one of those continuations
 * is a microtask, so they all run before this callback.
 */
function drain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Wait until `count` items have accumulated, so a gate is never shifted before it exists. */
async function waitForCount<T>(list: T[], count: number): Promise<void> {
  for (let i = 0; i < 100 && list.length < count; i++) await drain()
  if (list.length < count) throw new Error(`expected ${count} items, saw ${list.length}`)
}

/** Build a saver over a fake filesystem with a state object a test can mutate. */
function harness(options: { flushIntervalMs?: number; flushBatchSize?: number } = {}) {
  const fs = fakeFs()
  const clock = fakeClock(1_000_000)
  const timers = fakeTimers()
  let state = { version: 2, items: 0 }
  const saver = new ThrottledJsonSaver({
    fs,
    path: "/dir/state.json",
    serialize: () => state,
    clock,
    timers,
    pid: 99,
    nextSequence: (() => {
      let n = 0
      return () => n++
    })(),
    flushIntervalMs: options.flushIntervalMs ?? 2000,
    flushBatchSize: options.flushBatchSize ?? 25,
  })
  const saved = () => JSON.parse(fs.files.get("/dir/state.json") ?? "null")
  return {
    fs,
    clock,
    timers,
    saver,
    saved,
    setItems(n: number) {
      state = { version: 2, items: n }
    },
  }
}

describe("ThrottledJsonSaver", () => {
  it("writes nothing until a mark arrives", async () => {
    const h = harness()
    expect(await h.saver.flush()).toBe(false)
    expect(h.saver.writes).toBe(0)
    expect(h.fs.files.size).toBe(0)
  })

  it("defers a first mark instead of writing immediately", () => {
    const h = harness()
    h.saver.markDirty()
    expect(h.saver.dirty).toBe(true)
    expect(h.saver.writes).toBe(0)
    expect(h.timers.scheduled).toEqual([2000])
  })

  it("writes once for many marks inside one window", async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) {
      h.setItems(i)
      h.saver.markDirty()
    }
    // Ten marks, zero writes: the window has not elapsed and the batch size is not reached.
    expect(h.saver.writes).toBe(0)
    expect(h.timers.pending).toBe(1)
    expect(await h.saver.flush()).toBe(true)
    expect(h.saver.writes).toBe(1)
    expect(h.saved()).toEqual({ version: 2, items: 9 })
  })

  it("writes inline once the batch size is reached", async () => {
    const h = harness({ flushBatchSize: 3 })
    h.saver.markDirty()
    h.saver.markDirty()
    expect(h.saver.writes).toBe(0)
    h.saver.markDirty()
    await drain()
    expect(h.saver.writes).toBe(1)
    // The first two marks armed a timer; the batch hit cancels it.
    expect(h.timers.pending).toBe(0)
    expect(h.saver.dirty).toBe(false)
  })

  it("writes inline when a mark arrives after the window elapsed", async () => {
    const h = harness()
    h.saver.markDirty()
    await h.saver.flush()
    expect(h.saver.writes).toBe(1)

    // A mark well inside the next window defers again.
    h.clock.advance(300)
    h.saver.markDirty()
    expect(h.saver.writes).toBe(1)

    // A mark past the window writes without waiting for the timer.
    h.clock.advance(2000)
    h.saver.markDirty()
    await drain()
    expect(h.saver.writes).toBe(2)
  })

  it("flushes from the timer when the window elapses before the batch does", async () => {
    const h = harness()
    h.saver.markDirty()
    expect(h.timers.pending).toBe(1)
    h.clock.advance(2000)
    h.timers.runAll()
    await drain()
    expect(h.saver.writes).toBe(1)
    expect(h.saved()).toEqual({ version: 2, items: 0 })
  })

  it("writes atomically through a temp path unique per write", async () => {
    const h = harness()
    h.saver.markDirty()
    await h.saver.flush()
    h.clock.advance(3000)
    // A mark past the window writes inline rather than arming a timer, so its write is detached:
    // drain it before asserting.
    h.saver.markDirty()
    await drain()
    expect(h.saver.writes).toBe(2)
    const renames = h.fs.calls.filter((call) => call.op === "rename")
    expect(renames.map((call) => call.path)).toEqual([
      "/dir/state.json.99.0.tmp",
      "/dir/state.json.99.1.tmp",
    ])
    expect(h.fs.files.has("/dir/state.json.99.0.tmp")).toBe(false)
  })

  const detachesFailures = "reports a timer-driven failure through onFlushError, not unhandled"
  it(detachesFailures, async () => {
    const fs = fakeFs()
    const errors: unknown[] = []
    const saver = new ThrottledJsonSaver({
      fs,
      path: "/dir/state.json",
      serialize: () => ({ ok: true }),
      clock: fakeClock(),
      timers: fakeTimers(),
      pid: 1,
      flushIntervalMs: 10,
      flushBatchSize: 1,
      onFlushError: (error) => errors.push(error),
    })
    fs.failWrites.add("/dir/state.json.1.0.tmp")
    saver.markDirty()
    await drain()
    expect(errors.length).toBe(1)
    expect((errors[0] as Error).message).toContain("write refused")
    // The mark survives a failed write, so the next flush still tries.
    expect(saver.dirty).toBe(true)
  })

  it("rejects an explicit flush when the write fails", async () => {
    const h = harness()
    h.fs.failWrites.add("/dir/state.json.99.0.tmp")
    h.saver.markDirty()
    await expect(h.saver.flush()).rejects.toThrow("write refused")
  })

  it("keeps the mark after a detached write fails, so a later flush still saves it", async () => {
    const fs = fakeFs()
    const clock = fakeClock()
    const timers = fakeTimers()
    const errors: unknown[] = []
    let items = 0
    const saver = new ThrottledJsonSaver({
      fs,
      path: "/s.json",
      serialize: () => ({ items }),
      clock,
      timers,
      pid: 1,
      flushIntervalMs: 1000,
      flushBatchSize: 1,
      onFlushError: (error) => errors.push(error),
    })

    fs.failWrites.add("/s.json.1.0.tmp")
    items = 1
    saver.markDirty()
    await drain()
    expect(errors.length).toBe(1)

    // The disk recovered. The mark must still be pending, so the next flush writes it.
    fs.failWrites.clear()
    items = 2
    saver.markDirty()
    await drain()
    expect(saver.writes).toBe(1)
    expect(JSON.parse(fs.files.get("/s.json") as string)).toEqual({ items: 2 })
  })

  it("rejects an explicit flush that is already satisfied by an in-flight write", async () => {
    const h = harness()
    h.saver.markDirty()
    // `flush` waits for the detached write and then finds nothing left to do, rather than starting a
    // second write of the same state.
    expect(await h.saver.flush()).toBe(true)
    expect(await h.saver.flush()).toBe(false)
    expect(h.saver.writes).toBe(1)
  })

  it("drops a pending timer on dispose without writing", () => {
    const h = harness()
    h.saver.markDirty()
    h.saver.dispose()
    expect(h.timers.pending).toBe(0)
    expect(h.saver.writes).toBe(0)
    expect(h.saver.dirty).toBe(true)
  })

  it("does not lose a mark that lands while a write is in flight", async () => {
    const fs = fakeFs()
    const clock = fakeClock()
    const timers = fakeTimers()
    let items = 0
    // Each write is released by hand, so the test controls exactly which write is in flight.
    const gates: (() => void)[] = []
    const slowFs = {
      ...fs,
      writeText: (path: string, content: string) => {
        const gate = new Promise<void>((resolve) => gates.push(resolve))
        return gate.then(() => fs.writeText(path, content))
      },
    }
    const saver = new ThrottledJsonSaver({
      fs: slowFs,
      path: "/s.json",
      serialize: () => ({ items }),
      clock,
      timers,
      pid: 1,
      flushIntervalMs: 1000,
      // A high batch size keeps the batch path out of the way, so only the window and `flush`
      // can trigger a write.
      flushBatchSize: 1000,
    })

    items = 1
    saver.markDirty()
    expect(saver.writes).toBe(0)

    // A change arrives before the first write has landed.
    items = 2
    saver.markDirty()

    gates.shift()?.()
    await drain()
    // Two marks before the first write landed: the saver must still be dirty, because the document
    // on disk was serialised before the second change.
    expect(saver.dirty).toBe(true)

    const before = saver.writes
    const flushed = saver.flush()
    // The second write only starts once the first has finished, so its gate appears after this.
    await waitForCount(gates, 1)
    gates.shift()?.()
    expect(await flushed).toBe(true)
    expect(JSON.parse(fs.files.get("/s.json") as string)).toEqual({ items: 2 })
    expect(saver.writes).toBeGreaterThan(before)
    expect(saver.dirty).toBe(false)
  })
})
