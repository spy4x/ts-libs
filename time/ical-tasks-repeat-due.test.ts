// A repeat rule needs the due date it repeats from: `completeTask` moves a repeating task from its
// due date and refuses one without (#451). The edit that would write the pair is refused instead.

import { expect } from "@std/expect"
import { IcalDateKind, parseIcal, serializeIcal } from "./ical.ts"
import { newTodo, patchTodo } from "./ical-tasks.ts"
import {
  completeTask,
  editTask,
  keepMineText,
  rebaseEdit,
  type TaskEdit,
} from "./ical-tasks-edit.ts"
import type { Task } from "./ical-tasks-model.ts"
import { fixtureTask, task } from "./testdata/tasks/fixtures.ts"

const NOW = new Date(`2026-10-08T12:30:45.678Z`)
const WEEKLY = `FREQ=WEEKLY;INTERVAL=1`
const DUE = { kind: IcalDateKind.Date as const, date: `2026-10-12` }

const START_ONLY = fixtureTask(task(`r1`, `Water the plants`, [`DTSTART;VALUE=DATE:20261009`]))
const NO_DATES = fixtureTask(task(`r2`, `Water the plants`))
const REPEATING = fixtureTask(
  task(`r3`, `Water the plants`, [
    `DTSTART;VALUE=DATE:20261008`,
    `DUE;VALUE=DATE:20261009`,
    `RRULE:${WEEKLY}`,
  ]),
)
/** A task another app wrote: it repeats, has a start date and no due date. */
const ARRIVED = fixtureTask(
  task(`r4`, `Water the plants`, [`DTSTART;VALUE=DATE:20261009`, `RRULE:${WEEKLY}`]),
)

const NEEDS_DUE = `a repeat rule (${WEEKLY}) needs DUE on the todo; set DUE in the same patch`
const KEEPS_DUE =
  `a repeat rule (${WEEKLY}) needs DUE on the todo; to clear DUE, remove the rule in the same patch`

function edit(from: Task, change: TaskEdit): Task {
  const result = editTask(from, change, NOW)
  if (!result.success) throw new Error(result.error)
  return result.output.task
}

function refusal(from: Task, change: TaskEdit): string {
  const result = editTask(from, change, NOW)
  if (result.success) throw new Error(`the edit was not refused`)
  expect(result.output).toBeNull()
  return result.error
}

Deno.test(`editTask refuses a repeat rule on a task with no due date and names the rule`, () => {
  expect(refusal(START_ONLY, { repeatRule: WEEKLY })).toBe(NEEDS_DUE)
  expect(refusal(NO_DATES, { repeatRule: WEEKLY })).toBe(NEEDS_DUE)
})

Deno.test(`editTask refuses to clear the due date of a repeating task and names the rule`, () => {
  expect(refusal(REPEATING, { due: null })).toBe(KEEPS_DUE)
})

Deno.test(`editTask refuses a repeat rule in the edit that clears the due date`, () => {
  const dated = fixtureTask(task(`r5`, `Water the plants`, [`DUE;VALUE=DATE:20261009`]))
  expect(refusal(dated, { repeatRule: WEEKLY, due: null })).toBe(NEEDS_DUE)
})

Deno.test(`a repeat rule and a due date set in one edit are both written`, () => {
  for (const from of [START_ONLY, NO_DATES]) {
    const out = edit(from, { repeatRule: WEEKLY, due: DUE })
    expect(out.repeatRule).toBe(WEEKLY)
    expect(out.due).toEqual(DUE)
    expect(completeTask(out, NOW).success).toBe(true)
  }
})

Deno.test(`the due date and the repeat rule removed in one edit are both removed`, () => {
  // The fixture's reminder counts from the due date, so it goes in the same edit.
  const out = edit(REPEATING, { due: null, repeatRule: null, reminders: [] })
  expect(out.due).toBeUndefined()
  expect(out.repeatRule).toBeUndefined()
})

Deno.test(`a repeating task that keeps a due date can change its rule or its due date`, () => {
  expect(edit(REPEATING, { repeatRule: `FREQ=DAILY;INTERVAL=1` }).repeatRule)
    .toBe(`FREQ=DAILY;INTERVAL=1`)
  expect(edit(REPEATING, { due: DUE }).due).toEqual(DUE)
})

Deno.test(`a task that arrives repeating without a due date can still be edited`, () => {
  expect(edit(ARRIVED, { title: `Renamed` }).title).toBe(`Renamed`)
  expect(edit(ARRIVED, { start: null }).start).toBeUndefined()
  // A form sends every field back, the missing due date and the rule in its own spelling included.
  const form = edit(ARRIVED, { title: `Renamed`, due: null, repeatRule: `interval=1;freq=weekly` })
  expect(form.title).toBe(`Renamed`)
  expect(form.ics).toContain(`\r\nRRULE:${WEEKLY}\r\n`)
  // Either half of the repair is accepted.
  expect(edit(ARRIVED, { repeatRule: null }).repeatRule).toBeUndefined()
  expect(edit(ARRIVED, { due: DUE }).due).toEqual(DUE)
})

Deno.test(`a task that arrives repeating without a due date cannot be given another rule`, () => {
  expect(refusal(ARRIVED, { repeatRule: `FREQ=DAILY;INTERVAL=1` }))
    .toBe(`a repeat rule (FREQ=DAILY;INTERVAL=1) needs DUE on the todo; set DUE in the same patch`)
})

Deno.test(`patchTodo refuses a rule without DUE, and DUE cleared under a rule, and leaves the document unchanged`, () => {
  const cases = [
    { ics: START_ONLY.ics, patch: { rrule: WEEKLY }, message: NEEDS_DUE },
    { ics: REPEATING.ics, patch: { due: null }, message: KEEPS_DUE },
  ]
  for (const { ics, patch, message } of cases) {
    const parsed = parseIcal(ics)
    if (!parsed.success) throw new Error(parsed.error.message)
    const before = serializeIcal(parsed.output)
    const result = patchTodo(parsed.output, patch, { now: NOW })
    expect(result.success).toBe(false)
    expect(result.error?.message).toBe(message)
    expect(serializeIcal(parsed.output)).toBe(before)
  }
})

Deno.test(`newTodo refuses a repeat rule without a due date and writes one with it`, () => {
  const options = { uid: `n1`, now: NOW, prodid: `-//test//EN` }
  const start = { kind: IcalDateKind.Date as const, date: `2026-10-09` }
  const refused = newTodo({ summary: `Water the plants`, start, rrule: WEEKLY }, options)
  expect(refused.success).toBe(false)
  expect(refused.error?.message).toBe(NEEDS_DUE)
  expect(newTodo({ summary: `Water the plants`, due: DUE, rrule: WEEKLY }, options).success)
    .toBe(true)
})

Deno.test(`a due date I cleared is not cleared on a server copy that now repeats`, () => {
  const base = fixtureTask(task(`r6`, `Water the plants`, [`DUE;VALUE=DATE:20261009`]))
  const theirs = { ...edit(base, { repeatRule: WEEKLY }), etag: `"2"` }
  const result = rebaseEdit(base, { due: null }, theirs, NOW)
  expect(result.success).toBe(false)
  expect(result.error).toBe(KEEPS_DUE)
})

Deno.test(`keep mine renames a server copy that repeats without a due date`, () => {
  const mine = edit(START_ONLY, { title: `Renamed` })
  const result = keepMineText(START_ONLY.ics, mine.ics, { ...ARRIVED, etag: `"2"` }, NOW)
  if (!result.success) throw new Error(result.error.message)
  expect(result.output.task.title).toBe(`Renamed`)
  expect(result.output.task.repeatRule).toBe(WEEKLY)
  expect(result.output.task.due).toBeUndefined()
})
