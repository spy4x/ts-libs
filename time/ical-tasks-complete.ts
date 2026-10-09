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
 * Tasks.org keeps its "repeat after completion" switch in its own database; it is not written to
 * the VTODO, so a task set to repeat from completion is advanced from its due date here.
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
  type Todo,
  type TodoPatch,
  TodoStatus,
} from "./ical-tasks.ts"
import { nextOccurrence, parseRrule } from "./rrule.ts"
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
 * already completed; a repeating task without DUE; a rule outside the subset of `./rrule.ts`, or
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
  if (!due) return refuse(CompleteTodoErrorCode.NoDueDate, `a repeating task needs a DUE date`)

  const after = resolveInstant(due, FLOATING)
  if (!after) {
    return refuse(CompleteTodoErrorCode.UnusableDate, `DUE has no usable time zone`)
  }
  const next = nextOccurrence(rule, { start: due, after })
  if (!next.success) {
    return refuse(CompleteTodoErrorCode.UnusableDate, next.error.message)
  }
  if (next.output === null) return complete(true)

  const newDue = next.output
  const patch: TodoPatch = { due: newDue }
  if (todo.start) {
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
  moveReminders(
    findMaster(copy, `VTODO`)!,
    resolveInstant(newDue, FLOATING)!.getTime() - after.getTime(),
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
