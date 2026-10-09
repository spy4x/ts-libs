/**
 * The task a screen shows, read out of one CalDAV resource: its fields, where it lives (`href`,
 * `etag`, list) and the raw iCalendar text, so an edit can patch the text without losing what this
 * file does not model. Parsing is {@link readTodo}'s job; this file maps its result and adds what
 * the resource knows (`href`, `etag`) and what a list needs (priority bands, open or not, the day a
 * due value falls on for a viewer).
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
  type AlarmTrigger,
  AlarmTriggerKind,
  readTodo,
  type Todo,
  TodoStatus,
} from "./ical-tasks.ts"
import { isoDateInTz } from "./tz.ts"

/** A task's state, as a VTODO `STATUS` says it. The same enum as {@link TodoStatus}. */
export { TodoStatus as TaskStatus }

/** How Tasks.org groups the iCalendar priority numbers 1 to 9 (0 is none). */
export enum PriorityBand {
  None = 1,
  Low,
  Medium,
  High,
}

/** A due or start value. */
export type TaskDate = IcalDateValue

/** A reminder the task carries. Read-only in v1. */
export interface TaskReminder {
  /** The `VALARM` trigger as written, e.g. `-PT15M`: what to show when `alarm` cannot be described. */
  trigger: string
  /**
   * The trigger with what it is counted from (`RELATED=START` or `END`), so "before due" and
   * "before start" stay apart. Feed it to `describeAlarmTrigger`.
   */
  alarm: AlarmTrigger
}

/** One task as a screen shows it. */
export interface Task {
  /** The task's `UID`. */
  uid: string
  /** Where the task lives on the CalDAV server. */
  href: string
  /** The version the browser holds, sent back as `If-Match` on a save. */
  etag: string
  /** The raw iCalendar text this task was read from, so an edit can patch it. */
  ics: string
  /** The `href` of the list (calendar) the task belongs to. */
  listHref: string
  title: string
  notes: string
  status: TodoStatus
  /** The iCalendar `PRIORITY`, 0 to 9. */
  priority: number
  due?: TaskDate
  start?: TaskDate
  /** The `CATEGORIES` values. */
  tags: string[]
  /** The `UID` of the parent task, from `RELATED-TO`. */
  parentUid?: string
  /** `X-APPLE-SORT-ORDER`, the manual position inside a list. */
  sortOrder?: number
  /**
   * When the task was created: `CREATED`, or `DTSTAMP` when the task has no `CREATED`. Tasks.org
   * places a task that was never dragged at this time in manual order.
   */
  created?: TaskDate
  /** The `RRULE` as written; present when the task repeats. */
  repeatRule?: string
  reminders: TaskReminder[]
}

/** A task with its subtasks, for the tree a list shows. */
export interface TaskNode {
  task: Task
  children: TaskNode[]
}

/** A task list: a CalDAV calendar that holds tasks. */
export interface TaskList {
  /** Where the list lives on the CalDAV server. */
  href: string
  name: string
  /** A CSS colour, when the server has one. */
  color?: string
  /** How many tasks are not completed. */
  openCount: number
}

/** What the CalDAV server hands over for one task. */
export interface TaskSource {
  href: string
  etag: string
  /** The `href` of the list the task lives in. */
  listHref: string
  /** The iCalendar text of the task's resource. */
  ics: string
}

/** The result of {@link parseTask}: the task, or a message that says why there is none. */
export type ParseTaskResult =
  | { success: true; output: Task; error: null }
  | { success: false; output: null; error: string }

/**
 * Reads one task. A resource with no VTODO, or with one that has no `UID`, is a failure with a
 * message, never a throw: one odd resource must not take the whole list down.
 */
export function parseTask(source: TaskSource): ParseTaskResult {
  const parsed = parseIcal(source.ics)
  if (!parsed.success) return { success: false, output: null, error: parsed.error.message }
  const todo = readTodo(parsed.output)
  if (!todo) return { success: false, output: null, error: `No VTODO in ${source.href}` }
  if (!todo.uid) return { success: false, output: null, error: `No UID in ${source.href}` }
  return { success: true, output: toTask(todo, todo.uid, source, parsed.output), error: null }
}

function toTask(todo: Todo, uid: string, source: TaskSource, root: IcalComponent): Task {
  const task: Task = {
    uid,
    href: source.href,
    etag: source.etag,
    ics: source.ics,
    listHref: source.listHref,
    title: todo.summary ?? ``,
    notes: todo.description ?? ``,
    // A task with no STATUS is open, as Tasks.org reads it.
    status: todo.status ?? TodoStatus.NeedsAction,
    priority: todo.priority ?? 0,
    tags: todo.categories,
    reminders: todo.alarms.flatMap(toReminder),
  }
  const created = todo.created ?? stampOf(root)
  if (created) task.created = created
  if (todo.due) task.due = todo.due
  if (todo.start) task.start = todo.start
  // Only a parent link makes a subtask; CHILD and SIBLING links say nothing about this task's own
  // parent.
  const parent = todo.relatedTo.find((link) => link.type === `PARENT`)
  if (parent) task.parentUid = parent.uid
  if (todo.sortOrder !== undefined) task.sortOrder = todo.sortOrder
  if (todo.rrule) task.repeatRule = todo.rrule
  return task
}

/** The `DTSTAMP` of the task's VTODO, which `readTodo` does not return. */
function stampOf(root: IcalComponent): TaskDate | undefined {
  const todo = root.name.toUpperCase() === `VTODO`
    ? root
    : root.components.find((component) => component.name.toUpperCase() === `VTODO`)
  const stamp = todo && getProperty(todo, `DTSTAMP`)
  return stamp ? readDate(stamp) : undefined
}

function toReminder(alarm: Todo[`alarms`][number]): TaskReminder[] {
  const trigger = alarm.trigger
  if (!trigger) return []
  if (trigger.kind === AlarmTriggerKind.Relative) {
    return [{ trigger: trigger.duration, alarm: trigger }]
  }
  const { date, time = `00:00:00` } = trigger.at
  return [{ trigger: `${date.replace(/-/g, ``)}T${time.replace(/:/g, ``)}Z`, alarm: trigger }]
}

/** Tasks.org's grouping of the iCalendar priority: 1 to 4 high, 5 medium, 6 to 9 low, 0 none. */
export function priorityBand(priority: number): PriorityBand {
  if (priority >= 1 && priority <= 4) return PriorityBand.High
  if (priority === 5) return PriorityBand.Medium
  if (priority >= 6 && priority <= 9) return PriorityBand.Low
  return PriorityBand.None
}

/** Whether the task still needs doing: not completed and not cancelled. */
export function isOpen(task: Task): boolean {
  return task.status === TodoStatus.NeedsAction || task.status === TodoStatus.InProcess
}

/**
 * The instant a due or start value denotes for a viewer in `zone`. A date is midnight of that day
 * and a floating time is that wall clock, both in `zone`; a UTC time is itself; a zoned time keeps
 * its own zone. A zoned value whose `TZID` this runtime does not know (a vendor name such as
 * `W. Europe Standard Time`) is read as a wall clock in `zone`, so it still lands on a day and
 * never disappears from a view.
 */
export function dateInstant(value: TaskDate, zone: string): Date {
  const exact = resolveInstant(value, { zone })
  if (exact) return exact
  const wallClock = resolveInstant({ ...value, kind: IcalDateKind.Floating, tzid: undefined }, {
    zone,
  })
  // Reached only for a corrupt value, such as an impossible date; far in the future keeps the task
  // visible in lists and out of every date view.
  return wallClock ?? new Date(8.64e15)
}

/**
 * The calendar day (`YYYY-MM-DD`) on which a due or start value falls for a viewer in `zone`.
 * A date and a floating time stay on the day they are written; a UTC or zoned time is converted
 * to `zone`.
 */
export function dateDay(value: TaskDate, zone: string): string {
  if (value.kind === IcalDateKind.Date || value.kind === IcalDateKind.Floating) return value.date
  return isoDateInTz(dateInstant(value, zone), zone)
}
