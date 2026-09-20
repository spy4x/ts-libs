import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { AsyncMutex } from "./concurrency.ts"

/** Wait for a condition the event loop has to reach, without assuming how many ticks that takes. */
async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

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
