import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { fakeClock, fakeTimers } from "./_fake-fs.ts"
import {
  createReminderRunner,
  DEFAULT_REMINDER_CATCH_UP_MS,
  DEFAULT_REMINDER_INTERVAL_MS,
  type ReminderRunnerOptions,
  type ReminderRunnerState,
  type ReminderStatePort,
} from "./reminder-runner.ts"

const at = (iso: string) => new Date(iso).getTime()
const MINUTE = 60_000

/** A task due at `due` (UTC, `YYYYMMDDTHHMMSSZ`) with a reminder at that moment. */
function task(uid: string, due: string, extra: string[] = []): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTODO",
    `UID:${uid}`,
    `SUMMARY:Task ${uid}`,
    `DUE:${due}`,
    ...extra,
    "BEGIN:VALARM",
    "TRIGGER;RELATED=END:PT0S",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VTODO",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

/** A state port in memory that keeps a copy, as a file would, and can be told to fail. */
function memoryState(initial: unknown = null) {
  const port = {
    stored: initial,
    saves: 0,
    failLoad: false,
    failSave: false,
    load(): Promise<unknown> {
      if (port.failLoad) return Promise.reject(new Error("state unreadable"))
      return Promise.resolve(structuredClone(port.stored))
    },
    save(state: ReminderRunnerState): Promise<void> {
      if (port.failSave) return Promise.reject(new Error("disk full"))
      port.saves++
      port.stored = structuredClone(state)
      return Promise.resolve()
    },
  }
  return port satisfies ReminderStatePort
}

/** A runner over fakes, with what it was asked and what it reported. */
function setup(start: string, overrides: Partial<ReminderRunnerOptions> = {}) {
  const world = {
    clock: fakeClock(at(start)),
    timers: fakeTimers(),
    state: memoryState(),
    tasks: [] as string[],
    listed: 0,
    sent: [] as string[],
    errors: [] as string[],
  }
  const options = (): ReminderRunnerOptions => ({
    listTasks: () => {
      world.listed++
      return world.tasks
    },
    notify: (reminder) => {
      world.sent.push(reminder.key)
    },
    state: world.state,
    onError: (error, step) => {
      world.errors.push(`${step}: ${error instanceof Error ? error.message : String(error)}`)
    },
    zone: "UTC",
    clock: world.clock,
    timers: world.timers,
    ...overrides,
  })
  return {
    world,
    runner: createReminderRunner(options()),
    again: () => createReminderRunner(options()),
  }
}

describe("reminder runner: what a tick sends", () => {
  it("sends a reminder that came due since the last tick, once", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    expect(world.sent).toEqual([])
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toHaveLength(1)
    expect(world.errors).toEqual([])
  })

  it("hands notify the task's UID, summary and moment", async () => {
    const seen: unknown[] = []
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      notify: (reminder) => {
        seen.push(reminder)
      },
    })
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(seen).toEqual([{
      uid: "a",
      summary: "Task a",
      at: new Date("2026-10-12T10:00:00Z"),
      key: "a|2026-10-12T10:00:00.000Z",
    }])
  })

  it("sends nothing older than now on the very first run", async () => {
    const { world, runner } = setup("2026-10-12T10:00:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual([])
    expect(world.state.stored).toEqual({ lastRunAt: at("2026-10-12T10:01:30Z"), sent: {} })
  })

  it("sends the reminders of one tick earliest first, across tasks", async () => {
    const { world, runner } = setup("2026-10-12T09:00:00Z")
    await runner.tick()
    world.tasks = [task("late", "20261012T093000Z"), task("early", "20261012T091500Z")]
    world.clock.set(at("2026-10-12T09:45:00Z"))
    await runner.tick()
    expect(world.sent).toEqual(["early|2026-10-12T09:15:00.000Z", "late|2026-10-12T09:30:00.000Z"])
  })

  it("reads date-only due dates in the given zone and at the given time of day", async () => {
    const { world, runner } = setup("2026-10-12T06:59:00Z", {
      zone: "Europe/Berlin",
      dateOnlyTime: "09:00",
    })
    world.tasks = [task("a", "20261012").replace("DUE:", "DUE;VALUE=DATE:")]
    await runner.tick()
    world.clock.advance(2 * MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T07:00:00.000Z"])
  })
})

describe("reminder runner: tasks changed elsewhere before the moment", () => {
  it("does not remind for a task that was completed before its moment", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.tasks = [task("a", "20261012T100000Z", ["STATUS:COMPLETED"])]
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual([])
  })

  it("does not remind for a task that was deleted before its moment", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.tasks = []
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual([])
  })

  it("reminds at the new time of a task that was moved before its moment", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.tasks = [task("a", "20261012T100200Z")]
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual([])
    world.clock.advance(2 * MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:02:00.000Z"])
  })

  it("reminds at the snooze, not at the moment, of a task snoozed on another device", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    // The phone rang at 10:00:00 and the reminder was snoozed there for 15 minutes at 10:00:10.
    world.tasks = [
      task("a", "20261012T100000Z", [
        "X-MOZ-LASTACK:20261012T100010Z",
        "X-MOZ-SNOOZE-TIME:20261012T101510Z",
      ]),
    ]
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual([])
    world.clock.set(at("2026-10-12T10:15:30Z"))
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:15:10.000Z"])
  })
})

describe("reminder runner: restarts and long stops", () => {
  it("sends what came due while the server was down, and does not repeat what it sent", async () => {
    const { world, runner, again } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z"), task("b", "20261012T100500Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
    await runner.stop()

    world.clock.set(at("2026-10-12T10:10:00Z"))
    const second = again()
    await second.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z", "b|2026-10-12T10:05:00.000Z"])

    world.clock.advance(MINUTE)
    await again().tick()
    expect(world.sent).toHaveLength(2)
  })

  it("does not repeat a sent reminder after a restart when its window stayed open", async () => {
    let failing = true
    const delivered: string[] = []
    const { world, runner, again } = setup("2026-10-12T09:59:30Z", {
      notify: (reminder) => {
        if (reminder.uid === "b" && failing) throw new Error("push service down")
        delivered.push(reminder.uid)
      },
    })
    world.tasks = [task("a", "20261012T100000Z"), task("b", "20261012T100010Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(delivered).toEqual(["a"])
    // The window is still open: the stored last run did not move past the failed reminder.
    expect((world.state.stored as ReminderRunnerState).lastRunAt).toBe(at("2026-10-12T09:59:30Z"))

    failing = false
    world.clock.advance(MINUTE)
    await again().tick()
    expect(delivered).toEqual(["a", "b"])
  })

  it("catches up one hour by default after a long stop and drops older reminders", async () => {
    expect(DEFAULT_REMINDER_CATCH_UP_MS).toBe(60 * MINUTE)
    const { world, runner, again } = setup("2026-10-12T10:00:00Z")
    await runner.tick()
    await runner.stop()
    world.tasks = [
      task("old", "20261012T103000Z"),
      task("edge", "20261012T120000Z"),
      task("recent", "20261012T120001Z"),
    ]
    world.clock.set(at("2026-10-12T13:00:00Z"))
    await again().tick()
    expect(world.sent).toEqual(["recent|2026-10-12T12:00:01.000Z"])
  })

  it("catches up the stretch catchUpMs names", async () => {
    const { world, runner, again } = setup("2026-10-12T10:00:00Z", { catchUpMs: 10 * MINUTE })
    await runner.tick()
    await runner.stop()
    world.tasks = [task("old", "20261012T124000Z"), task("recent", "20261012T125500Z")]
    world.clock.set(at("2026-10-12T13:00:00Z"))
    await again().tick()
    expect(world.sent).toEqual(["recent|2026-10-12T12:55:00.000Z"])
  })

  it("forgets a sent reminder once it is older than the catch-up stretch", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z", { catchUpMs: 10 * MINUTE })
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(Object.keys((world.state.stored as ReminderRunnerState).sent)).toHaveLength(1)
    world.clock.set(at("2026-10-12T10:09:59Z"))
    await runner.tick()
    expect(Object.keys((world.state.stored as ReminderRunnerState).sent)).toHaveLength(1)
    world.clock.set(at("2026-10-12T10:10:00Z"))
    await runner.tick()
    expect((world.state.stored as ReminderRunnerState).sent).toEqual({})
    expect(world.sent).toHaveLength(1)
  })

  it("does not send again when the clock moves back", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    world.clock.set(at("2026-10-12T09:58:00Z"))
    await runner.tick()
    world.clock.set(at("2026-10-12T10:01:00Z"))
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
    expect(world.errors).toEqual([])
  })
})

describe("reminder runner: failures", () => {
  it("reports a failed task read and covers the missed stretch on the next tick", async () => {
    let failing = false
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      listTasks: () => {
        if (failing) throw new Error("caldav down")
        return world.tasks
      },
    })
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    failing = true
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.errors).toEqual(["list-tasks: caldav down"])
    expect(world.sent).toEqual([])
    failing = false
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
  })

  it("reports a failed notify, still sends the others, and tries the failed one again", async () => {
    let failing = true
    const delivered: string[] = []
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      notify: (reminder) => {
        if (reminder.uid === "a" && failing) return Promise.reject(new Error("push service down"))
        delivered.push(reminder.uid)
      },
    })
    world.tasks = [task("a", "20261012T100000Z"), task("b", "20261012T100010Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(delivered).toEqual(["b"])
    expect(world.errors).toEqual(["notify: push service down"])
    failing = false
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(delivered).toEqual(["b", "a"])
  })

  it("drops a reminder that keeps failing once it is older than the catch-up stretch", async () => {
    let attempts = 0
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      catchUpMs: 5 * MINUTE,
      notify: () => {
        attempts++
        throw new Error("push service down")
      },
    })
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    for (let minute = 0; minute < 10; minute++) {
      world.clock.advance(MINUTE)
      await runner.tick()
    }
    // 10:00:30 to 10:04:30: the tick at 10:05:30 looks back to 10:00:30 and no longer sees it.
    expect(attempts).toBe(5)
  })

  it("reports a failed state save and does not send the reminder again", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z")
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.state.failSave = true
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toHaveLength(1)
    expect(world.errors).toEqual(["save-state: disk full", "save-state: disk full"])
    world.state.failSave = false
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toHaveLength(1)
    expect((world.state.stored as ReminderRunnerState).sent).toEqual({
      "a|2026-10-12T10:00:00.000Z": at("2026-10-12T10:00:00Z"),
    })
  })

  it("sends nothing while the state cannot be read, and reports it on every tick", async () => {
    const { world, runner } = setup("2026-10-12T10:00:30Z")
    world.state.stored = { lastRunAt: at("2026-10-12T09:59:30Z"), sent: {} }
    world.state.failLoad = true
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    await runner.tick()
    expect(world.errors).toEqual(["load-state: state unreadable", "load-state: state unreadable"])
    expect(world.sent).toEqual([])
    expect(world.state.saves).toBe(0)
    world.state.failLoad = false
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
  })

  it("reports stored state of another shape and starts over from now", async () => {
    for (const stored of [{ lastRunAt: "yesterday", sent: {} }, { sent: {} }, [], "state"]) {
      const { world, runner } = setup("2026-10-12T10:00:30Z")
      world.state.stored = stored
      world.tasks = [task("a", "20261012T100000Z"), task("b", "20261012T100100Z")]
      await runner.tick()
      expect(world.errors).toHaveLength(1)
      expect(world.errors[0]).toContain("load-state:")
      world.clock.advance(MINUTE)
      await runner.tick()
      expect(world.sent).toEqual(["b|2026-10-12T10:01:00.000Z"])
      expect(world.errors).toHaveLength(1)
    }
  })

  it("carries on when onError itself throws", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      listTasks: () => {
        world.listed++
        if (world.listed === 1) throw new Error("caldav down")
        return world.tasks
      },
      onError: () => {
        throw new Error("logger down")
      },
    })
    world.tasks = [task("a", "20261012T100000Z")]
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    world.clock.advance(MINUTE)
    await runner.tick()
    expect(world.sent).toEqual(["a|2026-10-12T10:00:00.000Z"])
  })

  it("reports a task list that is not a list instead of rejecting", async () => {
    const { world, runner } = setup("2026-10-12T09:59:30Z", {
      listTasks: () => null as unknown as string[],
    })
    await runner.tick()
    expect(world.errors).toHaveLength(1)
    expect(world.errors[0]).toContain("list-tasks:")
  })
})

describe("reminder runner: the timer", () => {
  it("ticks at once on start, then once per interval", async () => {
    expect(DEFAULT_REMINDER_INTERVAL_MS).toBe(MINUTE)
    const { world, runner } = setup("2026-10-12T10:00:00Z")
    runner.start()
    await runner.tick()
    expect(world.listed).toBe(1)
    await Promise.resolve()
    expect(world.timers.scheduled).toEqual([MINUTE])
    expect(world.timers.pending).toBe(1)
    world.timers.runAll()
    await runner.tick()
    await Promise.resolve()
    expect(world.listed).toBe(2)
    expect(world.timers.scheduled).toEqual([MINUTE, MINUTE])
    expect(world.timers.pending).toBe(1)
    await runner.stop()
  })

  it("schedules the next tick only when the running one has finished", async () => {
    const waiting: (() => void)[] = []
    const { world, runner } = setup("2026-10-12T10:00:00Z", {
      listTasks: () => new Promise<string[]>((resolve) => waiting.push(() => resolve([]))),
    })
    runner.start()
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(world.timers.pending).toBe(0)
    waiting.splice(0).forEach((open) => open())
    await runner.tick()
    await Promise.resolve()
    expect(world.timers.pending).toBe(1)
    await runner.stop()
  })

  it("waits the interval it was given", async () => {
    const { world, runner } = setup("2026-10-12T10:00:00Z", { intervalMs: 5_000 })
    runner.start()
    await runner.tick()
    await Promise.resolve()
    expect(world.timers.scheduled).toEqual([5_000])
    await runner.stop()
  })

  it("starts once, however often start is called", async () => {
    const { world, runner } = setup("2026-10-12T10:00:00Z")
    runner.start()
    runner.start()
    await runner.tick()
    await Promise.resolve()
    expect(world.listed).toBe(1)
    expect(world.timers.pending).toBe(1)
    // Again while the timer of the next tick is pending: no second tick, no second timer.
    runner.start()
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(world.listed).toBe(1)
    expect(world.timers.scheduled).toEqual([MINUTE])
    await runner.stop()
  })

  it("never runs two ticks at once: a tick asked for while one runs joins it", async () => {
    let calls = 0
    const waiting: (() => void)[] = []
    const { world, runner } = setup("2026-10-12T10:00:00Z", {
      listTasks: () => {
        calls++
        return new Promise<string[]>((resolve) => waiting.push(() => resolve([])))
      },
    })
    runner.start()
    const first = runner.tick()
    const second = runner.tick()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    // Nothing is scheduled while a tick runs, so the timer cannot start a second one either.
    expect(world.timers.pending).toBe(0)
    waiting.splice(0).forEach((open) => open())
    await Promise.all([first, second])
    expect(calls).toBe(1)
    await runner.stop()
  })

  it("leaves no timer behind after stop, and ticks no more", async () => {
    const { world, runner } = setup("2026-10-12T10:00:00Z")
    runner.start()
    await runner.tick()
    await Promise.resolve()
    expect(world.timers.pending).toBe(1)
    await runner.stop()
    expect(world.timers.pending).toBe(0)
    world.timers.runAll()
    await Promise.resolve()
    expect(world.listed).toBe(1)
  })

  it("waits for a running tick on stop and schedules nothing after it", async () => {
    const waiting: (() => void)[] = []
    let finished = false
    const { world, runner } = setup("2026-10-12T10:00:00Z", {
      listTasks: () =>
        new Promise<string[]>((resolve) =>
          waiting.push(() => {
            finished = true
            resolve([])
          })
        ),
    })
    runner.start()
    await Promise.resolve()
    await Promise.resolve()
    let stopped = false
    const stopping = runner.stop().then(() => (stopped = true))
    for (let turn = 0; turn < 5; turn++) await Promise.resolve()
    expect(stopped).toBe(false)
    waiting.splice(0).forEach((open) => open())
    await stopping
    expect(finished).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(world.timers.pending).toBe(0)
  })

  it("can be started again after a stop", async () => {
    const { world, runner } = setup("2026-10-12T10:00:00Z")
    runner.start()
    await runner.stop()
    runner.start()
    await runner.tick()
    await Promise.resolve()
    expect(world.timers.pending).toBe(1)
    await runner.stop()
    expect(world.timers.pending).toBe(0)
  })
})

describe("reminder runner: options it refuses", () => {
  it("refuses an interval that is not positive and a negative catch-up", () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setup("2026-10-12T10:00:00Z", { intervalMs })).toThrow(RangeError)
    }
    for (const catchUpMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => setup("2026-10-12T10:00:00Z", { catchUpMs })).toThrow(RangeError)
    }
  })

  it("refuses a dateOnlyTime that is not a time of day, before any tick", () => {
    expect(() => setup("2026-10-12T10:00:00Z", { dateOnlyTime: "9am" })).toThrow(TypeError)
  })
})
