/**
 * What a task list shows: the orders it can be sorted in, the subtask tree, search over title, notes
 * and tags, and the Today and Upcoming views. Everything is a pure function of the tasks, the
 * current moment and the viewer's time zone; nothing reads the clock. Days are the viewer's, and
 * only tasks that still need doing appear in the views. A repeating task is shown where its due
 * value says; the next occurrence is not computed here.
 *
 * @module
 */

import { sortRows, type SortRule } from "./sort.ts"
import { filterRows, search } from "./text.ts"
import { IcalDateKind } from "@spy4x/time/ical"
import {
  dateDay,
  dateInstant,
  isOpen,
  PriorityBand,
  priorityBand,
  type Task,
  type TaskDate,
  type TaskNode,
} from "@spy4x/time/ical-tasks-model"
import { addDays, isoDateInTz } from "@spy4x/time/tz"

/** How a list shows its tasks. */
export enum SortMode {
  Manual = 1,
  Due,
  Priority,
  Title,
}

/** Tasks.org counts seconds from 2001-01-01; Unix time counts from 1970. This is the gap in ms. */
const APPLE_EPOCH_MS = 978_307_200_000

interface Row {
  task: Task
  /** The manual position: `X-APPLE-SORT-ORDER`, or the creation time in Apple seconds. */
  position: number | undefined
  due: number | undefined
  /** 1 for high to 3 for low; absent for a task with no priority, which sorts last. */
  band: number | undefined
  title: string
}

type Key = Exclude<keyof Row, "task">

const BAND_RANK: Record<PriorityBand, number | undefined> = {
  [PriorityBand.High]: 1,
  [PriorityBand.Medium]: 2,
  [PriorityBand.Low]: 3,
  [PriorityBand.None]: undefined,
}

/**
 * When a due value sorts. A date sorts at 23:59 of its day, after the timed dues of that day, as
 * Tasks.org sorts it. This is for ordering only: a date is still due the whole day.
 */
function dueSortInstant(due: TaskDate, zone: string): number {
  if (due.kind !== IcalDateKind.Date) return dateInstant(due, zone).getTime()
  return dateInstant({ ...due, kind: IcalDateKind.Floating, time: `23:59:00` }, zone).getTime()
}

/**
 * Where a task sits in manual order. A task that was never dragged has no `X-APPLE-SORT-ORDER`;
 * Tasks.org then uses its creation time in seconds since 2001-01-01, so it falls among the dragged
 * tasks by age.
 */
function manualPosition(task: Task, zone: string): number | undefined {
  if (task.sortOrder !== undefined) return task.sortOrder
  if (!task.created) return undefined
  return (dateInstant(task.created, zone).getTime() - APPLE_EPOCH_MS) / 1000
}

const asc = (key: Key): SortRule<Key> => ({ key, direction: `asc` })

/**
 * Each order falls back to the ones after it, so two tasks that tie always land in the same place.
 * A task with no value in a column (no due date, no priority, no manual position) comes after
 * those that have one. Tasks that tie on every column keep the order they came in.
 */
const RULES: Record<SortMode, SortRule<Key>[]> = {
  [SortMode.Manual]: [asc(`position`), asc(`title`)],
  [SortMode.Due]: [asc(`due`), asc(`band`), asc(`title`)],
  [SortMode.Priority]: [asc(`band`), asc(`title`)],
  [SortMode.Title]: [asc(`title`), asc(`due`)],
}

/**
 * The tasks in the order `mode` names, as a viewer in `zone` sees them. Does not change `tasks`.
 *
 * - Manual: `X-APPLE-SORT-ORDER` ascending, as Tasks.org shows it; a task without one counts as
 *   created-at, and ties go by title.
 * - Due: earliest first.
 * - Priority: high (1 to 4), medium (5), low (6 to 9), none; ties go by title.
 * - Title: case-insensitive, with `item 2` before `item 10`.
 */
export function sortTasks(tasks: readonly Task[], mode: SortMode, zone: string): Task[] {
  const rows: Row[] = tasks.map((task) => ({
    task,
    position: manualPosition(task, zone),
    due: task.due ? dueSortInstant(task.due, zone) : undefined,
    band: BAND_RANK[priorityBand(task.priority)],
    title: task.title,
  }))
  return sortRows(rows, RULES[mode]).map((row) => row.task)
}

/**
 * Nests each task under its parent (`parentUid`). The subtasks of a task are in manual order
 * whatever order the list uses, as Tasks.org shows them; the top level keeps the order of `tasks`,
 * so sort first to order it.
 *
 * - A task with no parent, or a parent that is not in `tasks`, is at the top.
 * - A cycle (A under B under A, or a task under itself) is cut at the member that comes first in
 *   `tasks`, which goes to the top with the rest of the cycle below it.
 * - When two tasks share a `UID`, children attach to the first; the second is shown at the top.
 */
export function buildTree(tasks: readonly Task[], zone: string): TaskNode[] {
  const indexOfUid = new Map<string, number>()
  tasks.forEach((task, index) => {
    if (!indexOfUid.has(task.uid)) indexOfUid.set(task.uid, index)
  })
  const parent = tasks.map((task) => {
    if (task.parentUid === undefined) return -1
    const found = indexOfUid.get(task.parentUid)
    return found ?? -1
  })

  cutCycles(parent)

  const nodes: TaskNode[] = tasks.map((task) => ({ task, children: [] }))
  const roots: TaskNode[] = []
  // Adding the tasks in manual order puts every node's children in manual order.
  const manual = sortTasks(tasks, SortMode.Manual, zone)
  const nodeOf = new Map(nodes.map((node) => [node.task, node]))
  const indexOf = new Map(tasks.map((task, index) => [task, index]))
  for (const task of manual) {
    const index = indexOf.get(task)!
    if (parent[index] === -1) continue
    nodes[parent[index]].children.push(nodeOf.get(task)!)
  }
  nodes.forEach((node, index) => {
    if (parent[index] === -1) roots.push(node)
  })
  return roots
}

/** Sets the parent of one member of every cycle to -1. Changes `parent`. */
function cutCycles(parent: number[]): void {
  // 0 not seen, 1 on the path being walked, 2 known to reach the top
  const state = parent.map(() => 0)
  for (let start = 0; start < parent.length; start++) {
    const path: number[] = []
    let at = start
    while (at !== -1 && state[at] === 0) {
      state[at] = 1
      path.push(at)
      at = parent[at]
    }
    if (at !== -1 && state[at] === 1) {
      const cycle = path.slice(path.indexOf(at))
      parent[Math.min(...cycle)] = -1
    }
    for (const index of path) state[index] = 2
  }
}

/** A task and how deep it sits, for a screen that draws the tree as indented rows. */
export interface TreeRow {
  task: Task
  depth: number
}

/**
 * The tree as rows, parents before their children. A node whose `UID` is in `collapsed` hides its
 * descendants.
 */
export function flattenTree(
  nodes: readonly TaskNode[],
  collapsed: ReadonlySet<string> = new Set(),
): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (list: readonly TaskNode[], depth: number) => {
    for (const node of list) {
      rows.push({ task: node.task, depth })
      if (!collapsed.has(node.task.uid)) visit(node.children, depth + 1)
    }
  }
  visit(nodes, 0)
  return rows
}

/**
 * The tasks that match `query`, in their input order. Every word of the query must appear in the
 * title, the notes or a tag. A blank query matches nothing.
 */
export function searchTasks(tasks: readonly Task[], query: string): Task[] {
  if (query.trim() === ``) return []
  return filterRows(
    [...tasks],
    query,
    (task, word) =>
      search(task.title, word) || search(task.notes, word) ||
      task.tags.some((tag) => search(tag, word)),
  )
}

/** How many days after today the Upcoming view reaches. */
export const UPCOMING_DAYS = 14

/** The Today view. */
export interface TodayView {
  /** Open tasks whose due value has passed, earliest first, across all lists. */
  overdue: Task[]
  /** Open tasks due later today, earliest first. */
  today: Task[]
}

/** The tasks due on one day of the Upcoming view. */
export interface UpcomingDay {
  /** `YYYY-MM-DD` in the viewer's zone. */
  date: string
  tasks: Task[]
}

/**
 * Whether a due value has passed. A date is overdue from the day after it; a time is overdue the
 * moment it passes, as Tasks.org colours it.
 */
export function isOverdue(due: TaskDate, now: Date, zone: string): boolean {
  if (due.kind === IcalDateKind.Date) return due.date < isoDateInTz(now, zone)
  return dateInstant(due, zone).getTime() < now.getTime()
}

/** Overdue above today. A task due today whose time has passed counts as overdue. */
export function todayView(tasks: readonly Task[], now: Date, zone: string): TodayView {
  const todayDate = isoDateInTz(now, zone)
  const overdue: Task[] = []
  const today: Task[] = []
  for (const task of tasks) {
    if (!isOpen(task) || !task.due) continue
    if (isOverdue(task.due, now, zone)) overdue.push(task)
    else if (dateDay(task.due, zone) === todayDate) today.push(task)
  }
  return {
    overdue: sortTasks(overdue, SortMode.Due, zone),
    today: sortTasks(today, SortMode.Due, zone),
  }
}

/**
 * Tomorrow through {@link UPCOMING_DAYS} days after today, one entry per day that has tasks, in
 * date order. Tasks inside a day are earliest first.
 */
export function upcomingView(tasks: readonly Task[], now: Date, zone: string): UpcomingDay[] {
  const first = addDays(isoDateInTz(now, zone), 1)
  const last = addDays(first, UPCOMING_DAYS - 1)
  const byDay = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!isOpen(task) || !task.due) continue
    const day = dateDay(task.due, zone)
    if (day < first || day > last) continue
    byDay.set(day, [...(byDay.get(day) ?? []), task])
  }
  return [...byDay.keys()].sort().map((date) => ({
    date,
    tasks: sortTasks(byDay.get(date)!, SortMode.Due, zone),
  }))
}

/** A new `X-APPLE-SORT-ORDER` to write for one task. */
export interface SortOrderChange {
  uid: string
  sortOrder: number
}

/**
 * The `X-APPLE-SORT-ORDER` values to write so that task `uid` sits at `toIndex` among its
 * siblings, as the manual order of {@link sortTasks} shows it, without touching more tasks than
 * needed.
 *
 * `siblings` are the children of one parent (or the top level of one list) in manual order.
 * `toIndex` counts after the task is taken out, so it is the index the task has in the new list;
 * a value past either end is clamped to that end. Throws when `uid` is not in `siblings` or
 * `toIndex` is not an integer.
 *
 * - Moving a task to where it already is returns `[]`.
 * - Normally one change is returned: an integer strictly between the new neighbours, or one step
 *   past the neighbour at an end.
 * - With no room (neighbours less than 2 apart, tied, or a neighbour with neither a stored value
 *   nor a creation time), the fewest tasks are rewritten that keep the new order: every other
 *   task keeps its value where the integers between its kept neighbours suffice. The values
 *   written are spread evenly between those neighbours, or one step apart past an end.
 *
 * A task is written only when its effective position changes, and the result lists tasks in their
 * new order. Apply it with `sortOrder` on each listed task, then sort again.
 */
export function reorderTask(
  siblings: readonly Task[],
  uid: string,
  toIndex: number,
  zone: string,
): SortOrderChange[] {
  if (!Number.isInteger(toIndex)) throw new RangeError(`toIndex must be an integer`)
  const from = siblings.findIndex((task) => task.uid === uid)
  if (from < 0) throw new RangeError(`task ${uid} is not among the siblings`)
  const list = siblings.filter((_, index) => index !== from)
  const to = Math.min(Math.max(toIndex, 0), list.length)
  if (to === from) return []
  const moved = siblings[from]
  list.splice(to, 0, moved)

  const current = list.map((task) => manualPosition(task, zone))
  // Chains of tasks that keep their value: strictly rising, with room for the writes between.
  const length: number[] = []
  const previous: number[] = []
  let last = -1
  for (let i = 0; i < list.length; i++) {
    const here = current[i]
    if (here === undefined) continue
    length[i] = 1
    previous[i] = -1
    for (let j = 0; j < i; j++) {
      const there = current[j]
      if (there === undefined || length[j] === undefined) continue
      if (Math.ceil(here) - 1 - Math.floor(there) < i - j - 1) continue
      if (length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        previous[i] = j
      }
    }
    if (last < 0 || length[i] > length[last]) last = i
  }

  const anchors: number[] = []
  for (let i = last; i >= 0; i = previous[i]) anchors.unshift(i)

  const values: (number | undefined)[] = list.map(() => undefined)
  const fill = (from: number, to: number, value: (k: number, count: number) => number) => {
    for (let k = from; k < to; k++) values[k] = value(k - from, to - from)
  }
  if (anchors.length === 0) {
    fill(0, list.length, (k) => k)
  } else {
    const first = anchors[0]
    fill(0, first, (k, count) => Math.ceil(current[first]!) - 1 - (count - 1 - k))
    for (let a = 0; a + 1 < anchors.length; a++) {
      const lowIndex = anchors[a]
      const highIndex = anchors[a + 1]
      const low = Math.floor(current[lowIndex]!) + 1
      const room = Math.ceil(current[highIndex]!) - low
      fill(lowIndex + 1, highIndex, (k, count) => low + Math.floor(((k + 0.5) * room) / count))
    }
    const end = anchors[anchors.length - 1]
    fill(end + 1, list.length, (k) => Math.floor(current[end]!) + 1 + k)
  }

  const changes: SortOrderChange[] = []
  list.forEach((task, index) => {
    const value = values[index]
    if (value !== undefined && value !== current[index]) {
      changes.push({ uid: task.uid, sortOrder: value })
    }
  })
  return changes
}
