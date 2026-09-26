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

/**
 * Build a saver whose every file write waits for a gate the test releases by hand, so the test
 * controls which writes are in flight and in which order they land. Unless `elapsed` is false, the
 * window has already elapsed when it returns, so the next mark writes inline.
 */
function gatedHarness(
  options: {
    elapsed?: boolean
    flushBatchSize?: number
    onFlushError?: (error: unknown) => void
  } = {},
) {
  const fs = fakeFs()
  const clock = fakeClock()
  const gates: (() => void)[] = []
  let items = 0
  const saver = new ThrottledJsonSaver({
    fs: {
      ...fs,
      writeText: (path: string, content: string) => {
        const gate = new Promise<void>((resolve) => gates.push(resolve))
        return gate.then(() => fs.writeText(path, content))
      },
    },
    path: "/s.json",
    serialize: () => ({ items }),
    clock,
    timers: fakeTimers(),
    pid: 1,
    flushIntervalMs: 1000,
    flushBatchSize: options.flushBatchSize ?? 1000,
    onFlushError: options.onFlushError,
  })
  if (options.elapsed ?? true) clock.advance(1000)
  return {
    fs,
    saver,
    clock,
    gates,
    saved: () => JSON.parse(fs.files.get("/s.json") ?? "null"),
    mark(n: number) {
      items = n
      saver.markDirty()
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
  it("runs one write at a time when marks keep arriving after the window", async () => {
    const h = gatedHarness()
    h.mark(1)
    h.mark(2)
    await drain()
    expect(h.gates.length).toBe(1)
    h.gates.shift()?.()
    // The second mark becomes one follow-up write, started only after the first one landed.
    await waitForCount(h.gates, 1)
    expect(h.saved()).toEqual({ items: 1 })
    h.gates.shift()?.()
    await drain()
    expect(h.saved()).toEqual({ items: 2 })
    expect(h.saver.writes).toBe(2)
    expect(h.gates.length).toBe(0)
  })

  it("ends with the newest snapshot on disk when later writes are released first", async () => {
    const h = gatedHarness()
    h.mark(1)
    h.mark(2)
    h.mark(3)
    // Release the newest pending write first, every round, until nothing is left in flight.
    for (let round = 0; round < 10; round++) {
      await drain()
      if (h.gates.length === 0) break
      h.gates.pop()?.()
    }
    expect(h.gates.length).toBe(0)
    expect(h.saved()).toEqual({ items: 3 })
    expect(h.saver.dirty).toBe(false)
  })

  it("stays dirty until the newest snapshot has landed", async () => {
    const h = gatedHarness()
    h.mark(1)
    await drain()
    expect(h.gates.length).toBe(1)
    // The write has started but not landed, so the change is not on disk yet.
    expect(h.saver.dirty).toBe(true)
    h.gates.shift()?.()
    await drain()
    expect(h.saver.dirty).toBe(false)
  })

  it("resolves flush only after the follow-up write of the newest mark has landed", async () => {
    const h = gatedHarness()
    h.mark(1)
    h.mark(2)
    let done = false
    const flushed = h.saver.flush().then((wrote) => {
      done = true
      return wrote
    })
    await drain()
    h.gates.shift()?.()
    await waitForCount(h.gates, 1)
    expect(done).toBe(false)
    h.gates.shift()?.()
    await drain()
    // Flush waited for the follow-up instead of starting a write of its own next to it.
    expect(h.gates.length).toBe(0)
    // The follow-up already wrote the newest state, so flush itself has nothing left to write.
    expect(await flushed).toBe(false)
    expect(h.saved()).toEqual({ items: 2 })
    expect(h.saver.dirty).toBe(false)
    expect(h.saver.writes).toBe(2)
  })

  it("does not start a second write while an explicit flush is writing", async () => {
    const h = gatedHarness()
    h.mark(1)
    await waitForCount(h.gates, 1)
    h.gates.shift()?.()
    await drain()
    // Inside the new window, so this mark only arms the timer and `flush` does the write.
    h.mark(2)
    const flushed = h.saver.flush()
    await waitForCount(h.gates, 1)
    // The window elapses while the flush's write is in flight, so this mark is due at once.
    h.clock.advance(1000)
    h.mark(3)
    await drain()
    expect(h.gates.length).toBe(1)
    h.gates.shift()?.()
    expect(await flushed).toBe(true)
    await waitForCount(h.gates, 1)
    h.gates.shift()?.()
    await drain()
    expect(h.saved()).toEqual({ items: 3 })
    expect(h.saver.dirty).toBe(false)
  })
  it("resolves flush once its own marks landed while a producer keeps marking", async () => {
    const h = gatedHarness()
    h.mark(1)
    let done = false
    const flushed = h.saver.flush().then((wrote) => {
      done = true
      return wrote
    })
    // Every write takes as long as the window, and a new mark arrives during each one.
    for (let round = 2; round <= 5; round++) {
      await waitForCount(h.gates, 1)
      h.clock.advance(1000)
      h.mark(round)
      h.gates.shift()?.()
      await drain()
      if (done) break
    }
    expect(done).toBe(true)
    expect(await flushed).toBe(false)
    expect(h.saver.writes).toBe(1)
    // The producer's newer mark is still carried by the follow-up write.
    await waitForCount(h.gates, 1)
    h.gates.shift()?.()
    await drain()
    expect(h.saved()).toEqual({ items: 2 })
  })

  it("drops a pending follow-up write on dispose", async () => {
    const h = gatedHarness()
    h.mark(1)
    h.mark(2)
    h.saver.dispose()
    await waitForCount(h.gates, 1)
    h.gates.shift()?.()
    await drain()
    expect(h.gates.length).toBe(0)
    expect(h.saved()).toEqual({ items: 1 })
    expect(h.saver.dirty).toBe(true)
  })

  it("keeps the marks made during a failed write in the batch count", async () => {
    const h = gatedHarness({ elapsed: false, flushBatchSize: 5 })
    h.fs.failWrites.add("/s.json.1.0.tmp")
    h.mark(1)
    h.mark(2)
    const flushed = h.saver.flush()
    await waitForCount(h.gates, 1)
    // Two marks while the write runs: inside the window and under the batch size, so no write yet.
    h.mark(3)
    h.mark(4)
    h.gates.shift()?.()
    await expect(flushed).rejects.toThrow("write refused")
    // Two marks from before the failed write plus two during it, plus this one, reach the batch.
    h.mark(5)
    await drain()
    expect(h.gates.length).toBe(1)
    h.gates.shift()?.()
    await drain()
    expect(h.saved()).toEqual({ items: 5 })
  })
})
