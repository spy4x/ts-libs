/**
 * Which reminders of a task are due: the moments its `VALARM`s and its snooze denote, filtered to
 * a time window.
 *
 * The rules:
 *
 * - A relative trigger counts from `DTSTART` (`RELATED=START`, the default) or from `DUE`
 *   (`RELATED=END`). A week is seven days and a day is 24 hours. A trigger relative to a date the
 *   task does not have is skipped.
 * - An absolute trigger (`TRIGGER;VALUE=DATE-TIME`) is its own moment.
 * - `X-MOZ-SNOOZE-TIME` on the task is one more reminder at that moment. Tasks.org and Thunderbird
 *   write a snooze this way.
 * - A reminder is acknowledged, and so never due, when its moment is not after `X-MOZ-LASTACK` on
 *   the task or on its `VALARM`, or after the `VALARM`'s `ACKNOWLEDGED` (RFC 9074). Tasks.org
 *   writes `X-MOZ-LASTACK` on the task when a reminder is dismissed or snoozed.
 * - A date-only `DTSTART` or `DUE` is read at `dateOnlyTime` (midnight by default) in the given
 *   zone, a floating time is that wall clock in the given zone, and a `TZID` value keeps its own
 *   zone, including one a `VTIMEZONE` of the same resource defines; a `TZID` that is neither known
 *   to this runtime nor defined there is read as a wall clock in the given zone, as `dateInstant`
 *   does.
 * - A completed or cancelled task has no reminders.
 *
 * Nothing here throws for a task it cannot read: text that is not iCalendar, a resource with no
 * VTODO or no `UID`, and a trigger that is not a duration all give no reminders. Only the first
 * VTODO that is not a recurrence override is read, as `readTodo` does: Tasks.org keeps a repeating
 * task as one VTODO whose `DUE` moves forward.
 *
 * Runs in the browser and on the server: web-platform APIs only, no `Deno.*`.
 * @module
 */

import {
  getProperty,
  type IcalComponent,
  IcalDateKind,
  type IcalDateValue,
  parseIcal,
  readDate,
  resolveInstant,
} from "./ical.ts"
import {
  AlarmRelated,
  type AlarmTrigger,
  AlarmTriggerKind,
  findMaster,
  readTodo,
  type Todo,
  TodoStatus,
} from "./ical-tasks.ts"
import { dateInstant } from "./ical-tasks-model.ts"

/** A half-open stretch of time: after `after`, up to and including `upTo`. */
export interface ReminderWindow {
  /** Exclusive lower bound: a reminder at exactly this moment belongs to the window before. */
  after: Date
  /** Inclusive upper bound. */
  upTo: Date
}

/** Options of {@link dueReminders}. */
export interface DueRemindersOptions {
  /** IANA zone that date-only and floating values are read in, such as `Europe/Berlin`. */
  zone: string
  /**
   * The wall-clock time (`HH:MM` or `HH:MM:SS`) a date-only `DTSTART` or `DUE` stands for, so a
   * reminder "when due" on a task with no time does not ring at midnight. Default `00:00`.
   */
  dateOnlyTime?: string
}

/** One reminder of one task, placed in time. */
export interface DueReminder {
  /** The task's `UID`. */
  uid: string
  /** The task's `SUMMARY`; empty when it has none. */
  summary: string
  /** The moment the reminder is for. */
  at: Date
  /**
   * `<UID>|<moment as ISO 8601 UTC>`: the same for the same reminder on every read, so a sender
   * can remember what it already sent.
   */
  key: string
}

const DURATION = /^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i
/** Milliseconds per captured unit of {@link DURATION}: week, day, hour, minute, second. */
const UNIT_MS = [604_800_000, 86_400_000, 3_600_000, 60_000, 1_000]
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

/** An RFC 5545 duration in milliseconds, or `undefined` when it is not one. */
function durationMs(text: string): number | undefined {
  const value = text.trim()
  const match = DURATION.exec(value)
  // A duration needs at least one unit, and a `T` needs a time part after it.
  if (!match || /T$/i.test(value) || match.slice(2).every((part) => part === undefined)) {
    return undefined
  }
  const total = UNIT_MS.reduce((sum, unit, index) => sum + Number(match[index + 2] ?? 0) * unit, 0)
  return match[1] === "-" ? -total : total
}

/** The instant of a UTC or zoned date-time property of `component`, such as `X-MOZ-LASTACK`. */
function instantOf(
  component: IcalComponent,
  name: string,
  zone: string,
  root: IcalComponent,
): number | undefined {
  const property = getProperty(component, name)
  const value = property && readDate(property)
  return value ? resolveInstant(value, { zone, root })?.getTime() : undefined
}

/** The instant a `DTSTART` or `DUE` value stands for; see the module rules. */
function anchorInstant(
  value: IcalDateValue,
  zone: string,
  dateOnlyTime: string,
  root: IcalComponent,
): number {
  const read = value.kind === IcalDateKind.Date
    ? { kind: IcalDateKind.Floating, date: value.date, time: dateOnlyTime }
    : value
  return dateInstant(read, zone, root).getTime()
}

/** The moment of one trigger in milliseconds, or `undefined` when it cannot be placed in time. */
function triggerMoment(
  trigger: AlarmTrigger | undefined,
  todo: Todo,
  zone: string,
  dateOnlyTime: string,
  root: IcalComponent,
): number | undefined {
  if (!trigger) return undefined
  if (trigger.kind === AlarmTriggerKind.Absolute) {
    return resolveInstant(trigger.at, { zone, root })?.getTime()
  }
  const anchor = trigger.related === AlarmRelated.End ? todo.due : todo.start
  const offset = durationMs(trigger.duration)
  if (!anchor || offset === undefined) return undefined
  return anchorInstant(anchor, zone, dateOnlyTime, root) + offset
}

function normaliseTimeOfDay(value: string | undefined): string {
  if (value === undefined) return "00:00:00"
  if (!TIME_OF_DAY.test(value)) {
    throw new TypeError("dateOnlyTime must be HH:MM or HH:MM:SS")
  }
  return value.length === 5 ? `${value}:00` : value
}

/**
 * Every reminder of the task in `ics` that can be placed in time and is not acknowledged, earliest
 * first. Two reminders at the same moment are one.
 */
function taskReminders(ics: string, options: DueRemindersOptions): DueReminder[] {
  const dateOnlyTime = normaliseTimeOfDay(options.dateOnlyTime)
  const parsed = parseIcal(ics)
  if (!parsed.success) return []
  const component = findMaster(parsed.output, "VTODO")
  const todo = readTodo(parsed.output)
  if (!component || !todo?.uid) return []
  if (
    todo.status === TodoStatus.Completed || todo.status === TodoStatus.Cancelled || todo.completed
  ) return []

  const { zone } = options
  const root = parsed.output
  const taskAck = instantOf(component, "X-MOZ-LASTACK", zone, root) ?? -Infinity
  const valarms = component.components.filter((child) => child.name.toUpperCase() === "VALARM")
  const moments = new Set<number>()
  // `todo.alarms` is read from the same VALARMs in the same order.
  todo.alarms.forEach((alarm, index) => {
    const moment = triggerMoment(alarm.trigger, todo, zone, dateOnlyTime, root)
    if (moment === undefined) return
    const ack = Math.max(
      taskAck,
      instantOf(valarms[index], "X-MOZ-LASTACK", zone, root) ?? -Infinity,
      instantOf(valarms[index], "ACKNOWLEDGED", zone, root) ?? -Infinity,
    )
    if (moment > ack) moments.add(moment)
  })
  const snooze = instantOf(component, "X-MOZ-SNOOZE-TIME", zone, root)
  if (snooze !== undefined && snooze > taskAck) moments.add(snooze)

  const uid = todo.uid
  return [...moments]
    // Outside what a `Date` can hold, such as a trigger of millions of weeks: its ISO text would throw.
    .filter((moment) => Math.abs(moment) < 8.64e15)
    .sort((left, right) => left - right)
    .map((moment) => {
      const at = new Date(moment)
      return { uid, summary: todo.summary ?? "", at, key: `${uid}|${at.toISOString()}` }
    })
}

/**
 * The reminders of the task in `ics` whose moment falls in `window`: after `window.after`, up to
 * and including `window.upTo`, earliest first. Consecutive windows therefore never report a
 * reminder twice and never miss one. Two reminders of the task at the same moment are one. See the
 * module documentation for the rules.
 *
 * @param ics The iCalendar text of one task resource (a `VCALENDAR` with a `VTODO`).
 * @throws {TypeError} when `options.dateOnlyTime` is not a time of day. Never for the task.
 *
 * @example
 * ```ts
 * const due = dueReminders(task.ics, { after: lastRun, upTo: new Date() }, { zone: "Europe/Berlin" })
 * for (const reminder of due) await notify(reminder.summary, reminder.key)
 * ```
 */
export function dueReminders(
  ics: string,
  window: ReminderWindow,
  options: DueRemindersOptions,
): DueReminder[] {
  const after = window.after.getTime()
  const upTo = window.upTo.getTime()
  return taskReminders(ics, options).filter((reminder) => {
    const moment = reminder.at.getTime()
    return moment > after && moment <= upTo
  })
}
