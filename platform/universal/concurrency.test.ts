import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { AsyncMutex, mapConcurrent } from "./concurrency.ts"

/** Wait for a condition the event loop has to reach, without assuming how many ticks that takes. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe("mapConcurrent", () => {
  it("preserves input order even when completion order differs", async () => {
    const delays = [30, 1, 20, 2]
    const result = await mapConcurrent(delays, 4, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return delay
    })
    expect(result).toEqual(delays)
  })

  it("never runs more than the limit at once", async () => {
    let inFlight = 0
    let peak = 0
    await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return null
    })
    expect(peak).toBe(3)
  })

  it("passes the index alongside the item", async () => {
    const seen = await mapConcurrent(
      ["a", "b", "c"],
      2,
      (item, index) => Promise.resolve(`${index}:${item}`),
    )
    expect(seen).toEqual(["0:a", "1:b", "2:c"])
  })

  it("returns an empty array for an empty input without calling fn", async () => {
    let calls = 0
    const result = await mapConcurrent([], 3, () => {
      calls++
      return Promise.resolve(1)
    })
    expect(result).toEqual([])
    expect(calls).toBe(0)
  })

  it("clamps a limit below one up to one, so calls stay serial", async () => {
    let peak = 0
    let inFlight = 0
    await mapConcurrent([1, 2, 3], 0, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      return null
    })
    expect(peak).toBe(1)
  })

  it("accepts a limit larger than the item count", async () => {
    expect(await mapConcurrent([1, 2], 100, (n) => Promise.resolve(n * 2))).toEqual([2, 4])
  })

  it("rejects with the first failure", async () => {
    await expect(
      mapConcurrent([1, 2, 3], 2, (n) => {
        if (n === 2) return Promise.reject(new Error("boom on two"))
        return Promise.resolve(n)
      }),
    ).rejects.toThrow("boom on two")
  })

  it("rejects a non-finite limit rather than starting unbounded work", async () => {
    await expect(mapConcurrent([1], Number.POSITIVE_INFINITY, (n) => Promise.resolve(n)))
      .rejects.toThrow("limit must be finite")
  })
})

describe("AsyncMutex", () => {
  it("grants the lock immediately when free", async () => {
    const mutex = new AsyncMutex()
    const release = await mutex.acquire()
    expect(mutex.locked).toBe(true)
    expect(mutex.queued).toBe(0)
    expect(mutex.acquisitions).toBe(1)
    release()
    expect(mutex.locked).toBe(false)
  })

  it("serialises two critical sections", async () => {
    const mutex = new AsyncMutex()
    const order: string[] = []
    const first = mutex.runExclusive(async () => {
      order.push("first:in")
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push("first:out")
    })
    const second = mutex.runExclusive(() => {
      order.push("second:in")
    })
    await Promise.all([first, second])
    expect(order).toEqual(["first:in", "first:out", "second:in"])
  })

  it("serves waiters in arrival order, never letting a later one jump the queue", async () => {
    const mutex = new AsyncMutex()
    const served: string[] = []
    const gates = new Map<string, () => void>()

    // Hold the lock so every other caller has to queue.
    const releaseHolder = await mutex.acquire()

    const queue = (name: string) =>
      mutex.runExclusive(() => {
        served.push(name)
        return new Promise<void>((resolve) => gates.set(name, resolve))
      })

    const names = ["a", "b", "c", "d"]
    const waiting = names.map(queue)
    expect(mutex.queued).toBe(4)

    releaseHolder()
    // Drain one at a time: releasing hands the lock to exactly one waiter, so the next name can
    // only enter after the previous one has finished.
    for (const name of names) {
      await waitFor(() => gates.has(name))
      gates.get(name)?.()
    }
    await Promise.all(waiting)
    expect(served).toEqual(names)
    expect(mutex.queued).toBe(0)
    expect(mutex.locked).toBe(false)
  })

  it("gives each waiter its own idempotent release", async () => {
    const mutex = new AsyncMutex()
    const holder = mutex.acquire()
    const waiter = mutex.acquire()
    const releaseHolder = await holder
    releaseHolder()
    releaseHolder() // second call must not free the waiter's lock
    expect(mutex.locked).toBe(true)
    const releaseWaiter = await waiter
    releaseWaiter()
    releaseWaiter()
    expect(mutex.locked).toBe(false)
  })

  it("releases the lock when the critical section throws", async () => {
    const mutex = new AsyncMutex()
    await expect(
      mutex.runExclusive(() => {
        throw new Error("inside")
      }),
    ).rejects.toThrow("inside")
    expect(mutex.locked).toBe(false)
    expect(mutex.queued).toBe(0)
  })

  it("counts one acquisition per holder, in hand-off order", async () => {
    const mutex = new AsyncMutex()
    const done: number[] = []
    await Promise.all(
      [1, 2, 3].map((n) =>
        mutex.runExclusive(() => {
          done.push(n)
          return Promise.resolve()
        })
      ),
    )
    // Acquisition count is deterministic even though the values pushed are ordered by the queue.
    expect(mutex.acquisitions).toBe(3)
    expect(done).toEqual([1, 2, 3])
  })
})
