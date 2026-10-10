/**
 * A reminder runner: on a timer, it reads the current tasks, works out which reminders became due
 * since its last run, and hands each one to the caller's `notify`.
 *
 * What it promises:
 *
 *  - Every tick asks for the tasks again, so a task that was completed, snoozed or moved by
 *    another client before its moment is simply not due. Nothing is scheduled ahead.
 *  - It remembers when it last ran and which reminders it already sent, in a state port the
 *    caller supplies. A restart therefore neither repeats a reminder nor skips one that came due
 *    while the server was down.
 *  - After a long stop it catches up at most `catchUpMs` (an hour by default). A reminder older
 *    than that is dropped: a notification hours late is noise.
 *  - Ticks never overlap. The next one is scheduled when the current one has finished, and a
 *    `tick()` called while one runs joins it.
 *  - A failure is reported through `onError` and never stops the next tick. When the tasks cannot
 *    be read, or `notify` fails, the window is tried again on the next tick; what was sent is not
 *    sent twice. A reminder that keeps failing is dropped once it is older than `catchUpMs`.
 *  - A tick has a deadline (`tickTimeoutMs`, two minutes by default). A `listTasks`, `notify` or
 *    state call that has not settled by then is abandoned and reported, its abort signal fires,
 *    and the next tick runs as usual. So a call that never settles cannot stop the runner or
 *    hang `stop()`.
 *  - The very first run, with no stored state, starts from "now" and sends nothing older.
 *  - `stop()` clears the timer and waits for a running tick.
 *
 * The clock and the timer are parameters, so a test needs no real time. Runs on any runtime:
 * nothing here touches `Deno.*`.
 *
 * @example
 * ```ts
 * const runner = createReminderRunner({
 *   listTasks: () => fetchTaskIcsTexts(),
 *   // from `@spy4x/integrations/push-reminders`; a hand-written one answers "delivered",
 *   // "retry" or "drop"
 *   notify: createReminderNotify({ sender, userId: "owner", url: "/" }),
 *   state: store.state("reminders"),
 *   zone: "Europe/Berlin",
 *   onError: (error, step) => console.error(`reminders: ${step} failed`, error),
 * })
 * runner.start()
 * ```
 * @module
 */
import { type } from "arktype"
import { type DueReminder, dueReminders } from "@spy4x/time/ical-tasks-reminders"
import { type Clock, systemClock } from "../universal/time.ts"
import { systemTimerPort, type TimerPort } from "./throttled-saver.ts"

/** How often the runner ticks unless `intervalMs` says otherwise: once a minute. */
export const DEFAULT_REMINDER_INTERVAL_MS = 60_000
/** How far back the runner catches up unless `catchUpMs` says otherwise: one hour. */
export const DEFAULT_REMINDER_CATCH_UP_MS = 3_600_000
/** How long one tick may take unless `tickTimeoutMs` says otherwise: two minutes. */
export const DEFAULT_REMINDER_TICK_TIMEOUT_MS = 120_000

/** What the runner remembers between ticks and across restarts. */
export interface ReminderRunnerState {
  /** The end of the last window that was fully handled, in milliseconds since the epoch. */
  lastRunAt: number
  /** The reminders already sent: `DueReminder.key` to its moment in milliseconds. */
  sent: Record<string, number>
}

/**
 * Where the runner keeps its {@link ReminderRunnerState}. `state(name)` of the file push store in
 * `@spy4x/integrations/push-file-store` fits.
 */
export interface ReminderStatePort {
  /** The stored state, or `null` when there is none. The runner validates what it gets. */
  load(): Promise<unknown>
  save(state: ReminderRunnerState): Promise<void>
}

/** Which part of a tick failed, as {@link ReminderRunnerOptions.onError} is told. */
export type ReminderRunnerStep = "load-state" | "list-tasks" | "notify" | "save-state"

/**
 * What `notify` says about one reminder:
 *
 *  - `"delivered"` (or nothing): done, never handed to `notify` again.
 *  - `"retry"`: not delivered for a reason that may pass. The whole call is repeated on the next
 *    tick, until the reminder is older than `catchUpMs`. A rejection means the same.
 *  - `"drop"`: it can never be delivered, such as a payload the push service will always refuse.
 *    It is reported once through `onError` and never tried again.
 */
export type ReminderNotifyResult = "delivered" | "retry" | "drop"

/** Options of {@link createReminderRunner}. */
export interface ReminderRunnerOptions {
  /**
   * The iCalendar text of every task that may carry a reminder, read fresh on each call. The
   * signal aborts when the tick's deadline passes: hand it to `fetch`.
   */
  listTasks: (signal: AbortSignal) => Promise<readonly string[]> | readonly string[]
  /**
   * Delivers one due reminder and says how it went; see {@link ReminderNotifyResult}.
   *
   * A `"retry"` or a rejection repeats the whole call on the next tick, for every device. So when
   * a reminder goes to several devices, answer `"delivered"` as soon as one device got it, or
   * when no device is subscribed: otherwise the devices that work get it again each minute while
   * one keeps failing. Answer `"retry"` only when every device failed for a reason that may pass.
   * `createReminderNotify` in `@spy4x/integrations/push-reminders` does exactly this for a Web
   * Push sender. The signal aborts when the tick's deadline passes.
   */
  notify: (
    reminder: DueReminder,
    signal: AbortSignal,
  ) => Promise<ReminderNotifyResult | void> | ReminderNotifyResult | void
  state: ReminderStatePort
  /** Told about every failure; the runner carries on. The error is the caller's own, unchanged. */
  onError: (error: unknown, step: ReminderRunnerStep) => void
  /** IANA zone that date-only and floating task dates are read in. An unknown one is refused. */
  zone: string
  /** The time of day (`HH:MM`) a date-only due or start date stands for. Default `00:00`. */
  dateOnlyTime?: string
  /** Milliseconds between the end of one tick and the start of the next. Default one minute. */
  intervalMs?: number
  /**
   * The longest stretch a tick looks back over, in milliseconds. Default one hour. Never less
   * than `intervalMs`: a tick would then skip part of the time since the tick before.
   */
  catchUpMs?: number
  /**
   * How long one tick may take, in milliseconds, before what it waits on is abandoned and
   * reported. Default two minutes.
   */
  tickTimeoutMs?: number
  /** Defaults to the system clock. */
  clock?: Clock
  /** Defaults to real timers. */
  timers?: TimerPort
}

/** A runner built by {@link createReminderRunner}. */
export interface ReminderRunner {
  /** Runs a tick now and then one every interval. A second call while started does nothing. */
  start(): void
  /** Clears the timer and resolves when a running tick has finished. Never rejects. */
  stop(): Promise<void>
  /**
   * Runs one tick now, or joins the one that is running. Never rejects: failures go to `onError`.
   */
  tick(): Promise<void>
}

const stateSchema = type({
  lastRunAt: "number",
  sent: "Record<string, number>",
})

/**
 * Builds a runner; nothing runs until {@link ReminderRunner.start} or {@link ReminderRunner.tick}.
 *
 * @throws {RangeError} when `intervalMs` or `tickTimeoutMs` is not positive, `catchUpMs` is less
 * than `intervalMs`, or `zone` is not a time zone this runtime knows.
 * @throws {TypeError} when `dateOnlyTime` is not a time of day.
 */
export function createReminderRunner(options: ReminderRunnerOptions): ReminderRunner {
  const { listTasks, notify, state: port } = options
  const clock = options.clock ?? systemClock
  const timers = options.timers ?? systemTimerPort
  const intervalMs = options.intervalMs ?? DEFAULT_REMINDER_INTERVAL_MS
  const catchUpMs = options.catchUpMs ?? DEFAULT_REMINDER_CATCH_UP_MS
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new RangeError("intervalMs must be a positive number")
  }
  if (!Number.isFinite(catchUpMs) || catchUpMs < intervalMs) {
    throw new RangeError("catchUpMs must be a number of at least intervalMs")
  }
  const tickTimeoutMs = options.tickTimeoutMs ?? DEFAULT_REMINDER_TICK_TIMEOUT_MS
  if (!Number.isFinite(tickTimeoutMs) || tickTimeoutMs <= 0) {
    throw new RangeError("tickTimeoutMs must be a positive number")
  }
  try {
    // With a zone it does not know, every date-only and floating task would silently never remind.
    new Intl.DateTimeFormat("en", { timeZone: options.zone })
  } catch {
    throw new RangeError("zone is not a time zone this runtime knows")
  }
  const reading = { zone: options.zone, dateOnlyTime: options.dateOnlyTime }
  // A bad `dateOnlyTime` is a configuration error: found here, not at the first tick.
  dueReminders("", { after: new Date(0), upTo: new Date(0) }, reading)

  const report = (error: unknown, step: ReminderRunnerStep): void => {
    try {
      options.onError(error, step)
    } catch {
      // A failing error handler must not stop the runner either.
    }
  }

  /** The state in memory once it was loaded; the port is read once per process. */
  let memory: { lastRunAt: number | undefined; sent: Map<string, number> } | undefined
  let running: Promise<void> | undefined
  let handle: number | undefined
  let started = false

  /** Runs `work`, giving up when the tick's deadline passes. */
  type Within = <T>(work: () => Promise<T> | T) => Promise<T>

  async function save(within: Within, lastRunAt: number, sent: Map<string, number>): Promise<void> {
    try {
      await within(() => port.save({ lastRunAt, sent: Object.fromEntries(sent) }))
    } catch (error) {
      report(error, "save-state")
    }
  }

  async function runTick(): Promise<void> {
    const controller = new AbortController()
    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(new Error(`the tick took longer than ${tickTimeoutMs} ms and was abandoned`))
      })
    })
    // Nothing may be waiting on it when the deadline passes.
    expired.catch(() => {})
    const deadline = timers.set(() => controller.abort(), tickTimeoutMs)
    const within: Within = (work) => Promise.race([Promise.resolve().then(work), expired])
    try {
      await runSteps(within, controller.signal)
    } finally {
      timers.clear(deadline)
    }
  }

  async function runSteps(within: Within, signal: AbortSignal): Promise<void> {
    if (!memory) {
      let loaded: unknown
      try {
        loaded = await within(() => port.load())
      } catch (error) {
        return report(error, "load-state")
      }
      const valid = loaded === null || loaded === undefined ? undefined : stateSchema(loaded)
      if (valid instanceof type.errors) {
        // Reported, then replaced by the next save: the runner starts over from now.
        report(new Error("the stored reminder state is not valid; starting from now"), "load-state")
        memory = { lastRunAt: undefined, sent: new Map() }
      } else {
        memory = { lastRunAt: valid?.lastRunAt, sent: new Map(Object.entries(valid?.sent ?? {})) }
      }
    }

    const now = clock.now()
    const floor = now - catchUpMs
    // No state yet: start from now. After a clock that moved back, `after` is later than `now`:
    // that window is empty, and the next one starts at `now`.
    const after = Math.max(memory.lastRunAt ?? now, floor)
    // Kept even when this tick fails, so a first run that cannot read the tasks still starts here.
    memory.lastRunAt = after
    // A key at or before the floor can never be in a later window, so it is forgotten.
    for (const [key, at] of memory.sent) if (at <= floor) memory.sent.delete(key)

    let tasks: readonly string[]
    try {
      tasks = await within(() => listTasks(signal))
    } catch (error) {
      return report(error, "list-tasks")
    }
    const window = { after: new Date(after), upTo: new Date(now) }
    const due = tasks.flatMap((ics) => dueReminders(ics, window, reading))
      .sort((left, right) => left.at.getTime() - right.at.getTime())

    let delivered = true
    for (const reminder of due) {
      if (memory.sent.has(reminder.key)) continue
      let result: ReminderNotifyResult | void
      try {
        result = await within(() => notify(reminder, signal))
      } catch (error) {
        report(error, "notify")
        // Past the deadline nothing more is started: the window stays open for the next tick.
        if (signal.aborted) return
        delivered = false
        continue
      }
      if (result === "retry") {
        delivered = false
        report(new Error("a reminder was not delivered and will be tried again"), "notify")
        continue
      }
      if (result === "drop") {
        report(new Error("a reminder can never be delivered and was dropped"), "notify")
      }
      memory.sent.set(reminder.key, reminder.at.getTime())
      // Saved at once, so a crash later in this tick does not send it again.
      await save(within, after, memory.sent)
      if (signal.aborted) return
    }
    // The window is closed only when everything in it was delivered.
    memory.lastRunAt = delivered ? now : after
    await save(within, memory.lastRunAt, memory.sent)
  }

  function tick(): Promise<void> {
    running ??= runTick()
      // Every awaited step reports for itself; what is left is a `listTasks` result that is not
      // a list of texts.
      .catch((error) => report(error, "list-tasks"))
      .finally(() => {
        running = undefined
      })
    return running
  }

  async function loop(): Promise<void> {
    handle = undefined
    await tick()
    if (started && handle === undefined) handle = timers.set(() => void loop(), intervalMs)
  }

  return {
    tick,
    start() {
      if (started) return
      started = true
      void loop()
    },
    async stop() {
      started = false
      if (handle !== undefined) timers.clear(handle)
      handle = undefined
      await running
    },
  }
}
