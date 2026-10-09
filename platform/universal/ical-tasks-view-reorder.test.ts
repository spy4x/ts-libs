import { expect } from "@std/expect"
import type { Task } from "@spy4x/time/ical-tasks-model"
import { reorderTask, SortMode, sortTasks } from "./ical-tasks-view.ts"
import { fixtureTask, task } from "../../time/testdata/tasks/fixtures.ts"

const UTC = `UTC`

/** A task with a stored position, or with none and a creation time when `created` is given. */
function make(uid: string, sortOrder?: number, created?: boolean): Task {
  const lines = sortOrder === undefined ? [] : [`X-APPLE-SORT-ORDER:${sortOrder}`]
  const base = fixtureTask(task(uid, uid, lines))
  return created === false ? { ...base, created: undefined } : base
}

/** A task that has neither a stored position nor a creation time. */
const bare = (uid: string) => make(uid, undefined, false)

const uids = (tasks: readonly Task[]) => tasks.map((t) => t.uid)

/** Writes the changes into the tasks, sorts them manually, and returns the uids. */
function apply(tasks: readonly Task[], changes: { uid: string; sortOrder: number }[]): string[] {
  const written = new Map(changes.map((c) => [c.uid, c.sortOrder]))
  const next = tasks.map((t) => written.has(t.uid) ? { ...t, sortOrder: written.get(t.uid) } : t)
  return uids(sortTasks(next, SortMode.Manual, UTC))
}

Deno.test("moving a task to the start writes one value just below the first", () => {
  const tasks = [make(`a`, 10), make(`b`, 20), make(`c`, 30)]
  expect(reorderTask(tasks, `c`, 0, UTC)).toEqual([{ uid: `c`, sortOrder: 9 }])
})

Deno.test("moving a task between two others writes one value between them", () => {
  const tasks = [make(`a`, 10), make(`b`, 20), make(`c`, 30)]
  expect(reorderTask(tasks, `a`, 1, UTC)).toEqual([{ uid: `a`, sortOrder: 25 }])
})

Deno.test("moving a task to the end writes one value just past the last", () => {
  const tasks = [make(`a`, 10), make(`b`, 20), make(`c`, 30)]
  expect(reorderTask(tasks, `a`, 2, UTC)).toEqual([{ uid: `a`, sortOrder: 31 }])
})

Deno.test("an index past the end is the end", () => {
  const tasks = [make(`a`, 10), make(`b`, 20)]
  expect(reorderTask(tasks, `a`, 99, UTC)).toEqual([{ uid: `a`, sortOrder: 21 }])
  const toStart = reorderTask(tasks, `b`, -5, UTC)
  expect(toStart.length).toBe(1)
  expect(apply(tasks, toStart)).toEqual([`b`, `a`])
})

Deno.test("moving a task to where it already is writes nothing", () => {
  const tasks = [make(`a`, 10), make(`b`, 10), make(`c`, 30)]
  expect(reorderTask(tasks, `b`, 1, UTC)).toEqual([])
  expect(reorderTask(tasks, `a`, 0, UTC)).toEqual([])
})

Deno.test("neighbours one apart rewrite only the tasks that must move", () => {
  const tasks = [make(`a`, 1), make(`b`, 2), make(`c`, 3), make(`d`, 100)]
  const changes = reorderTask(tasks, `d`, 1, UTC)
  expect(changes.length).toBe(2)
  expect(apply(tasks, changes)).toEqual([`a`, `d`, `b`, `c`])
})

Deno.test("a gap of one rewrites one neighbour when that leaves room", () => {
  const tasks = [make(`a`, 5), make(`b`, 6), make(`c`, 50), make(`d`, 90)]
  const changes = reorderTask(tasks, `d`, 1, UTC)
  expect(changes.length).toBe(2)
  expect(apply(tasks, changes)).toEqual([`a`, `d`, `b`, `c`])
})

Deno.test("tied neighbours get distinct values", () => {
  const tasks = [make(`a`, 7), make(`b`, 7), make(`c`, 7), make(`d`, 100)]
  const changes = reorderTask(tasks, `d`, 1, UTC)
  expect(apply(tasks, changes)).toEqual([`a`, `d`, `b`, `c`])
  expect(new Set(changes.map((c) => c.sortOrder)).size).toBe(changes.length)
})

Deno.test("tasks without a stored value are placed by creation time and keep their place", () => {
  const tasks = [make(`a`, 100_000_000), make(`b`), make(`c`, 900_000_000)]
  const changes = reorderTask(tasks, `c`, 0, UTC)
  expect(changes.length).toBe(1)
  expect(apply(tasks, changes)).toEqual([`c`, `a`, `b`])
})

Deno.test("a task with neither a value nor a creation time gets a value when moved past", () => {
  const tasks = [make(`a`, 5), bare(`b`), bare(`c`)]
  const changes = reorderTask(tasks, `a`, 2, UTC)
  expect(apply(tasks, changes)).toEqual([`b`, `c`, `a`])
  expect(reorderTask(tasks, `b`, 1, UTC)).toEqual([])
})

Deno.test("negative values order and receive values below zero", () => {
  const tasks = [make(`a`, -30), make(`b`, -20), make(`c`, -10)]
  expect(reorderTask(tasks, `c`, 0, UTC)).toEqual([{ uid: `c`, sortOrder: -31 }])
  expect(reorderTask(tasks, `a`, 1, UTC)).toEqual([{ uid: `a`, sortOrder: -15 }])
})

Deno.test("an unknown uid or a fractional index throws", () => {
  const tasks = [make(`a`, 1)]
  expect(() => reorderTask(tasks, `x`, 0, UTC)).toThrow(RangeError)
  expect(() => reorderTask(tasks, `a`, 0.5, UTC)).toThrow(RangeError)
})

Deno.test("applying the changes and sorting again gives the intended order, for random lists", () => {
  let seed = 12345
  const random = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 400; round++) {
    const size = 1 + random(8)
    const spread = [3, 10, 1000][random(3)]
    const tasks = Array.from({ length: size }, (_, i) => {
      const kind = random(6)
      const uid = `t${i}`
      if (kind === 0) return make(uid)
      if (kind === 1) return bare(uid)
      return make(uid, random(spread) - Math.floor(spread / 3))
    })
    const siblings = sortTasks(tasks, SortMode.Manual, UTC)
    const moved = siblings[random(size)]
    const toIndex = random(size)
    const intended = siblings.filter((t) => t !== moved)
    intended.splice(toIndex, 0, moved)

    const changes = reorderTask(siblings, moved.uid, toIndex, UTC)
    const message = `round ${round}: ${JSON.stringify({ toIndex, changes, uids: uids(siblings) })}`
    expect(apply(siblings, changes), message).toEqual(uids(intended))
    expect(new Set(changes.map((c) => c.uid)).size, message).toBe(changes.length)
  }
})
