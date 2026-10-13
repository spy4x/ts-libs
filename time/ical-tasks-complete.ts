/**
 * Complete and reopen a task the way Tasks.org does, on top of `./ical-tasks.ts`.
 *
 * A task without a repeat rule is completed with `STATUS:COMPLETED`, `COMPLETED` and
 * `PERCENT-COMPLETE:100`. A repeating task is not marked completed: it moves to its next
 * occurrence and stays open, as Tasks.org does (`RepeatTaskHelper.handleRepeat`, Tasks.org commit
 * b5c8b08). The rules, all taken from that source:
 *
 * - The next date is the first occurrence after the task's DUE, counted from DUE. DTSTART of the
 *   task is not the anchor, and "now" is not the reference: an overdue task moves one step from
 *   its old due date, even when the result is still in the past.
 * - DTSTART moves by the same offset as DUE, so the gap between them is kept.
 * - `COUNT` is lowered by one; at `COUNT=1`, or when no occurrence is left (`UNTIL`), the series
 *   ends and the task is completed with its rule as written.
 * - Reminders: absolute alarm triggers (`TRIGGER;VALUE=DATE-TIME`) move by the same offset, and
 *   `X-MOZ-SNOOZE-TIME` is dropped. Relative triggers and every other line stay as they are.
 *
 * Tasks.org keeps its "repeat after completion" switch in its own database and writes nothing
 * about it to the VTODO, so the choice it shows cannot be read here. This library keeps its own
 * copy of the choice in the task, as the line `X-REPEAT-FROM:COMPLETION`
 * ({@link RepeatFrom.Completion}), which Tasks.org keeps when it saves. A task with that line
 * counts from the day it is completed, the way Tasks.org's `RepeatTaskHelper` does for
 * `RepeatFrom.COMPLETION_DATE`; a task without it counts from its due date, as above. The two
 * settings are separate, so they can differ, and then the app the task is completed in decides.
 * Counted from completion:
 *
 * - The series starts again at the completion day: the next date is the first one the rule gives
 *   after that day, at the time of day the due date has. A date-only task, a floating time and a
 *   UTC time read the completion day in `options.timeZone`; a time with a `TZID` reads it in that
 *   zone.
 * - A weekly rule with `BYDAY` moves to the next listed weekday after the completion day, after
 *   skipping `INTERVAL - 1` weeks first.
 * - `COUNT` is lowered by one as above. `UNTIL` ends the series when the next date would pass it;
 *   Tasks.org does not check `UNTIL` for a weekly rule with `BYDAY` counted from completion.
 * - A task with no DUE gets one, date-only, and its DTSTART stays. One whose DTSTART has a time,
 *   or that says when it ends with `DURATION`, is refused as before: a date-only DUE fits
 *   neither.
 * - The old `FROM=COMPLETION` part inside an RRULE, which Tasks.org wrote before it had the
 *   switch, is not read as this choice and is never written: such a rule is refused, with or
 *   without the line.
 *
 * Everything is atomic: a refusal leaves the document as it was. The clock comes from the
 * caller. Runs in the browser and on the server: web-platform APIs only, no `Deno.*`.
 * @module
 */

import {
  getParameter,
  getProperties,
  IcalComponent,
  IcalDateKind,
  IcalDateValue,
  IcalResult,
  removeProperty,
  resolveInstant,
} from "./ical.ts"
import {
  findMaster,
  patchTodo,
  readTodo,
  RepeatFrom,
  type Todo,
  type TodoPatch,
  TodoStatus,
} from "./ical-tasks.ts"
import { nextOccurrence, parseRrule, type Rrule, RruleFreq } from "./rrule.ts"
import { hhmmInTz, isoDateInTz, isValidTimeZone } from "./tz.ts"

/** What {@link completeTodo} did. */
export enum CompleteTodoKind {
  /** A repeating task moved to its next occurrence and is still open. */
  Advanced = 1,
  /** The task is completed: it did not repeat, or its series has no occurrence left. */
  Completed,
}

/** Why {@link completeTodo} or {@link reopenTodo} refused. */
export enum CompleteTodoErrorCode {
  /** The document has no VTODO. */
  NoTodo = 1,
  /** The task is already completed. */
  AlreadyCompleted,
  /** {@link reopenTodo} on a task that is not completed. */
  NotCompleted,
  /** A repeating task with no DUE: Tasks.org would invent a date from the clock; this does not. */
  NoDueDate,
  /** The repeat rule is outside what this module reproduces (`part` names the rule part). */
  UnsupportedRule,
  /** A date has no usable instant, such as a vendor TZID. */
  UnusableDate,
  /** The edit itself was refused by the task helpers; `message` says why. */
  Rejected,
}

/** The error half of {@link CompleteTodoResult}. */
export interface CompleteTodoError {
  code: CompleteTodoErrorCode
  message: string
  /** The rule part at fault, upper-case, for {@link CompleteTodoErrorCode.UnsupportedRule}. */
  part?: string
}

/** `{ success, output, error }`: the output, or why there is none. */
export type CompleteTodoResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: CompleteTodoError }

/** What a successful {@link completeTodo} reports. */
export interface CompleteTodoOutput {
  kind: CompleteTodoKind
  /** The task as it now reads. */
  todo: Todo
}

/** Inputs of {@link completeTodo} and {@link reopenTodo}. */
export interface CompleteTodoOptions {
  /** The moment of the edit: DTSTAMP, LAST-MODIFIED and, for completing, COMPLETED. */
  now: Date
  /**
   * The IANA zone of the person completing the task. It decides which day "the day it was
   * completed" is for a task that counts from completion ({@link RepeatFrom.Completion}) and whose
   * due date has no `TZID`. Without it such a task is refused with
   * {@link CompleteTodoErrorCode.UnusableDate}; nothing else reads it.
   */
  timeZone?: string
}

/** Floating times and dates are read as UTC: only differences between them are used. */
const FLOATING = { zone: `UTC` }

const DAY_MS = 86_400_000

const refuse = (code: CompleteTodoErrorCode, message: string, part?: string) => ({
  success: false as const,
  output: null,
  error: part === undefined ? { code, message } : { code, message, part },
})
const done = <T>(output: T) => ({ success: true as const, output, error: null })

function rejected(result: IcalResult<unknown>) {
  return refuse(
    CompleteTodoErrorCode.Rejected,
    result.error?.message ?? `the edit was refused`,
  )
}

/** The wall-clock zone of a value, or `undefined` when it has none we can read. */
function zoneOf(value: IcalDateValue): string | undefined {
  const zone = value.kind === IcalDateKind.Utc
    ? `UTC`
    : value.kind === IcalDateKind.Zoned
    ? value.tzid
    : `UTC`
  return zone && isValidTimeZone(zone) ? zone : undefined
}

function isoDays(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS
}

function isoFromDays(days: number): string {
  return new Date(days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * `value` moved by the offset between two due values, the way Tasks.org adds the due offset to
 * the start: in milliseconds, so a zoned wall clock follows the clock change like it does.
 */
function shift(
  value: IcalDateValue,
  from: IcalDateValue,
  to: IcalDateValue,
): IcalDateValue | undefined {
  if (value.kind === IcalDateKind.Date) {
    return {
      ...value,
      date: isoFromDays(isoDays(value.date) + isoDays(to.date) - isoDays(from.date)),
    }
  }
  const zone = zoneOf(value)
  const a = resolveInstant(from, FLOATING)
  const b = resolveInstant(to, FLOATING)
  const v = resolveInstant(value, FLOATING)
  if (!zone || !a || !b || !v) return undefined
  const moved = new Date(v.getTime() + b.getTime() - a.getTime())
  const seconds = String(moved.getUTCSeconds()).padStart(2, `0`)
  return { ...value, date: isoDateInTz(moved, zone), time: `${hhmmInTz(moved, zone)}:${seconds}` }
}

/** `COUNT` lowered by one in the rule text; every other part stays where it was. */
function lowerCount(rrule: string): string {
  return rrule.replace(
    /(^|;)(COUNT=)(\d+)/i,
    (_, lead, name, n) => `${lead}${name}${Number(n) - 1}`,
  )
}

const pad = (n: number) => String(n).padStart(2, `0`)

/** Shift absolute alarm triggers written in UTC, and drop the snooze. */
function moveReminders(todo: IcalComponent, deltaMs: number) {
  removeProperty(todo, `X-MOZ-SNOOZE-TIME`)
  for (const alarm of todo.components) {
    if (alarm.name.toUpperCase() !== `VALARM`) continue
    for (const trigger of getProperties(alarm, `TRIGGER`)) {
      if (getParameter(trigger, `VALUE`)?.values[0]?.toUpperCase() !== `DATE-TIME`) continue
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(trigger.value)
      if (!m) continue
      const at = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) + deltaMs)
      trigger.value = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
        `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
    }
  }
}

/**
 * Where a series counted from completion starts again: the day `now` falls on, at the time of day
 * `due` has, as a value of the kind `due` is. Tasks.org does the same with the phone's zone
 * (`RepeatTaskHelper.setUpStartDate`). A task with no due date starts at the day alone.
 */
function completionAnchor(
  due: IcalDateValue | undefined,
  now: Date,
  timeZone: string | undefined,
): IcalDateValue | string {
  if (due?.kind === IcalDateKind.Zoned) {
    const zone = zoneOf(due)
    return zone ? { ...due, date: isoDateInTz(now, zone) } : `DUE has no usable time zone`
  }
  if (!timeZone || !isValidTimeZone(timeZone)) {
    return `a task that repeats from completion needs the timeZone option to know the day`
  }
  const date = isoDateInTz(now, timeZone)
  if (!due || due.kind === IcalDateKind.Date) return { kind: IcalDateKind.Date, date }
  if (due.kind === IcalDateKind.Floating) return { ...due, date }
  // A UTC time: its time of day as the person's clock shows it, on the day they completed it.
  const instant = resolveInstant(due, FLOATING)
  const at = instant && resolveInstant({
    kind: IcalDateKind.Floating,
    date,
    time: `${hhmmInTz(instant, timeZone)}:${due.time?.slice(6, 8) ?? `00`}`,
  }, { zone: timeZone })
  if (!at) return `DUE has no usable time`
  const iso = at.toISOString()
  return { kind: IcalDateKind.Utc, date: iso.slice(0, 10), time: iso.slice(11, 19) }
}

/**
 * The rule and the start that give the next date of a series counted from completion. A weekly
 * rule with BYDAY skips `INTERVAL - 1` weeks and then takes the next listed weekday, as Tasks.org
 * does (`RepeatTaskHelper.handleWeeklyRepeatAfterComplete`), not the weeks RFC 5545 would count
 * from the start. `COUNT` needs no care: it is 2 or more here, and the caller lowers it.
 */
function fromCompletion(rule: Rrule, anchor: IcalDateValue): [Rrule, IcalDateValue] {
  if (rule.freq !== RruleFreq.Weekly || rule.byDay.length === 0) return [rule, anchor]
  const date = isoFromDays(isoDays(anchor.date) + 7 * (rule.interval - 1))
  return [{ ...rule, interval: 1 }, { ...anchor, date }]
}

function isCompleted(todo: Todo): boolean {
  return todo.status === TodoStatus.Completed || todo.completed !== undefined
}

/**
 * Complete the first VTODO of `root` in place, as Tasks.org does. See the module description for
 * the rules. Returns {@link CompleteTodoKind.Advanced} for a repeating task that moved on, and
 * {@link CompleteTodoKind.Completed} otherwise (a repeating task whose series is over keeps its
 * RRULE as written).
 *
 * Refuses with a {@link CompleteTodoError}, leaving `root` as it was: no VTODO; a task that is
 * already completed; a repeating task without DUE (unless it counts from completion); a task that
 * counts from completion with no `options.timeZone` to name the day; a rule outside the subset of `./rrule.ts`, or
 * one Tasks.org reads differently (`BYDAY` on a daily or yearly rule, which it ignores; a
 * `FROM=` part); a DUE or DTSTART with no usable instant.
 */
export function completeTodo(
  root: IcalComponent,
  options: CompleteTodoOptions,
): CompleteTodoResult<CompleteTodoOutput> {
  const target = findMaster(root, `VTODO`)
  const todo = target && readTodo(root)
  if (!target || !todo) return refuse(CompleteTodoErrorCode.NoTodo, `no VTODO to complete`)
  if (isCompleted(todo)) {
    return refuse(CompleteTodoErrorCode.AlreadyCompleted, `the task is already completed`)
  }
  const complete = (series: boolean) => {
    const copy = structuredClone(root)
    const result = patchTodo(copy, { status: TodoStatus.Completed }, {
      now: options.now,
      completeSeries: series,
    })
    if (!result.success) return rejected(result)
    commit(root, copy)
    return done({ kind: CompleteTodoKind.Completed, todo: result.output })
  }
  if (!todo.repeats) return complete(false)

  const parsed = parseRrule(todo.rrule!)
  if (!parsed.success) {
    return refuse(CompleteTodoErrorCode.UnsupportedRule, parsed.error.message, parsed.error.part)
  }
  const rule = parsed.output
  if (rule.count === 1) return complete(true)
  const due = todo.due
  const counted = todo.repeatFrom === RepeatFrom.Completion
  // Without a due date only a task counted from completion has a day to count from. The new DUE
  // is a date, which a DTSTART with a time cannot stand next to, and no DUE may join a DURATION.
  const takesDue = (!todo.start || todo.start.kind === IcalDateKind.Date) &&
    getProperties(target, `DURATION`).length === 0
  if (!due && !(counted && takesDue)) {
    return refuse(CompleteTodoErrorCode.NoDueDate, `a repeating task needs a DUE date`)
  }
  const before = due && resolveInstant(due, FLOATING)
  if (due && !before) {
    return refuse(CompleteTodoErrorCode.UnusableDate, `DUE has no usable time zone`)
  }
  let from: [Rrule, IcalDateValue] | undefined = due && [rule, due]
  if (counted) {
    const anchor = completionAnchor(due, options.now, options.timeZone)
    if (typeof anchor === `string`) return refuse(CompleteTodoErrorCode.UnusableDate, anchor)
    from = fromCompletion(rule, anchor)
  }
  const [series, start] = from!
  const after = resolveInstant(start, FLOATING)
  if (!after) {
    return refuse(CompleteTodoErrorCode.UnusableDate, `DUE has no usable time zone`)
  }
  const next = nextOccurrence(series, { start, after })
  if (!next.success) {
    return refuse(CompleteTodoErrorCode.UnusableDate, next.error.message)
  }
  if (next.output === null) return complete(true)

  const newDue = next.output
  const patch: TodoPatch = { due: newDue }
  if (todo.start && due) {
    const start = shift(todo.start, due, newDue)
    if (!start) {
      return refuse(CompleteTodoErrorCode.UnusableDate, `DTSTART has no usable time zone`)
    }
    patch.start = start
  }
  if (rule.count !== undefined) patch.rrule = lowerCount(todo.rrule!)

  const copy = structuredClone(root)
  const result = patchTodo(copy, patch, { now: options.now })
  if (!result.success) return rejected(result)
  // A task that had no due date has no old date to measure the move from: its reminders stay.
  moveReminders(
    findMaster(copy, `VTODO`)!,
    before ? resolveInstant(newDue, FLOATING)!.getTime() - before.getTime() : 0,
  )
  commit(root, copy)
  return done({ kind: CompleteTodoKind.Advanced, todo: readTodo(root)! })
}

/**
 * Reopen a completed task in place: STATUS becomes `NEEDS-ACTION`, COMPLETED and a
 * `PERCENT-COMPLETE` of 100 are removed. Dates and the rule are not touched, so this undoes the
 * completion of a task that ended its series, not the move of a repeating task; for that, keep
 * the text from before.
 *
 * Refuses with {@link CompleteTodoErrorCode.NoTodo} or {@link CompleteTodoErrorCode.NotCompleted},
 * leaving `root` as it was.
 */
export function reopenTodo(
  root: IcalComponent,
  options: CompleteTodoOptions,
): CompleteTodoResult<Todo> {
  const todo = findMaster(root, `VTODO`) && readTodo(root)
  if (!todo) return refuse(CompleteTodoErrorCode.NoTodo, `no VTODO to reopen`)
  if (!isCompleted(todo)) {
    return refuse(CompleteTodoErrorCode.NotCompleted, `the task is not completed`)
  }
  const result = patchTodo(root, { status: TodoStatus.NeedsAction }, { now: options.now })
  return result.success ? done(result.output) : rejected(result)
}

function commit(root: IcalComponent, copy: IcalComponent) {
  root.properties = copy.properties
  root.components = copy.components
}
