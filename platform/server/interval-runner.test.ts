import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { fakeTimers } from "./_fake-fs.ts"
import { startIntervalRunner } from "./interval-runner.ts"

const HOUR = 3_600_000

/** Lets the promise chain of a tick settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("startIntervalRunner", () => {
  it("runs the task once per interval, first after one interval", async () => {
    const timers = fakeTimers()
    let runs = 0
    startIntervalRunner({ task: () => void runs++, intervalMs: HOUR, onError: () => {}, timers })

    expect(runs).toBe(0)
    expect(timers.scheduled).toEqual([HOUR])
    timers.runAll()
    await settle()
    expect(runs).toBe(1)
    timers.runAll()
    await settle()
    expect(runs).toBe(2)
  })

  it("reports a failed tick and runs again on the next one", async () => {
    const timers = fakeTimers()
    const reported: unknown[] = []
    let runs = 0
    startIntervalRunner({
      task: () => {
        runs++
        return runs === 1 ? Promise.reject(new Error("connect ECONNREFUSED")) : Promise.resolve()
      },
      intervalMs: HOUR,
      onError: (error) => reported.push(error),
      timers,
    })

    timers.runAll()
    await settle()
    expect(reported.length).toBe(1)
    expect(String(reported[0])).toContain("ECONNREFUSED")

    timers.runAll()
    await settle()
    expect(runs).toBe(2)
    expect(reported.length).toBe(1)
  })

  it("reports a task that throws synchronously and keeps going", async () => {
    const timers = fakeTimers()
    const reported: unknown[] = []
    startIntervalRunner({
      task: () => {
        throw new Error("boom")
      },
      intervalMs: HOUR,
      onError: (error) => reported.push(error),
      timers,
    })

    timers.runAll()
    await settle()

    expect(reported.length).toBe(1)
    expect(timers.pending).toBe(1)
  })

  it("keeps going when the reporter itself throws", async () => {
    const timers = fakeTimers()
    startIntervalRunner({
      task: () => Promise.reject(new Error("boom")),
      intervalMs: HOUR,
      onError: () => {
        throw new Error("reporter down")
      },
      timers,
    })

    timers.runAll()
    await settle()

    expect(timers.pending).toBe(1)
  })

  it("does not start the next tick while the current one is still running", async () => {
    const timers = fakeTimers()
    let finish = () => {}
    let runs = 0
    startIntervalRunner({
      task: () => {
        runs++
        return new Promise<void>((resolve) => (finish = resolve))
      },
      intervalMs: HOUR,
      onError: () => {},
      timers,
    })

    timers.runAll()
    await settle()
    expect(runs).toBe(1)
    expect(timers.pending).toBe(0) // nothing is scheduled while the task runs

    finish()
    await settle()
    expect(timers.pending).toBe(1)
  })

  it("starts nothing after stop, and clears a pending tick", async () => {
    const timers = fakeTimers()
    let runs = 0
    const stop = startIntervalRunner({
      task: () => void runs++,
      intervalMs: HOUR,
      onError: () => {},
      timers,
    })

    stop()
    stop()
    timers.runAll()
    await settle()

    expect(runs).toBe(0)
    expect(timers.pending).toBe(0)
  })

  it("lets a running tick finish after stop but schedules no successor", async () => {
    const timers = fakeTimers()
    let finish = () => {}
    const stop = startIntervalRunner({
      task: () => new Promise<void>((resolve) => (finish = resolve)),
      intervalMs: HOUR,
      onError: () => {},
      timers,
    })
    timers.runAll()
    await settle()

    stop()
    finish()
    await settle()

    expect(timers.pending).toBe(0)
  })

  it("refuses an interval that is not positive or does not fit a timer", () => {
    for (const intervalMs of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
      expect(() =>
        startIntervalRunner({ task: () => {}, intervalMs, onError: () => {}, timers: fakeTimers() })
      ).toThrow(RangeError)
    }
  })
})
