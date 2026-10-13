// "Count the next date from completion": the choice lives in the task as the line
// `X-REPEAT-FROM:COMPLETION`. Reading it, completing by it, and setting and clearing it.

import { expect } from "@std/expect"
import { parseIcal, serializeIcal } from "./ical.ts"
import { CompleteTodoErrorCode, newTodo, patchTodo, readTodo } from "./ical-tasks.ts"
import {
  completeTask,
  editTask,
  keepMineText,
  rebaseEdit,
  RebaseKind,
  type TaskEdit,
} from "./ical-tasks-edit.ts"
import { RepeatFrom, type Task } from "./ical-tasks-model.ts"
import { fixtureTask, task } from "./testdata/tasks/fixtures.ts"

/** Wednesday 14 October 2026: 23:30 in Berlin, 17:30 in New York, 06:30 on the 15th in Tokyo. */
const NOW = new Date(`2026-10-14T21:30:00Z`)
const BERLIN = { timeZone: `Europe/Berlin` }
const LINE = `X-REPEAT-FROM:COMPLETION`

function water(rest: string[]): Task {
  return fixtureTask(task(`f1`, `Water the plants`, rest))
}

/** The lines of `ics` that start with one of `names`, in order. */
function lines(ics: string, ...names: string[]): string[] {
  return ics.split(`\r\n`).filter((line) => names.some((name) => line.startsWith(name)))
}

/** The text without the two stamps every write refreshes. */
function unstamped(ics: string): string[] {
  return ics.split(`\r\n`).filter((line) => !/^(DTSTAMP|LAST-MODIFIED):/.test(line))
}

function complete(from: Task, options?: { timeZone?: string }, now = NOW): string {
  const result = completeTask(from, now, options)
  if (!result.success) throw new Error(result.error.message)
  return result.output.ics
}

function edit(from: Task, change: TaskEdit): Task {
  const result = editTask(from, change, NOW)
  if (!result.success) throw new Error(result.error)
  return result.output.task
}

Deno.test("a task with X-REPEAT-FROM:COMPLETION reads as counted from completion", () => {
  const read = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`, LINE])
  expect(read.repeatFrom).toBe(RepeatFrom.Completion)
  expect(readTodo(parseIcal(read.ics).output!)!.repeatFrom).toBe(RepeatFrom.Completion)
})

Deno.test("the value is read whatever its case, and any other value is from the due date", () => {
  const rule = [`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`]
  expect(water([...rule, `X-REPEAT-FROM:completion`]).repeatFrom).toBe(RepeatFrom.Completion)
  expect(water([...rule, `X-REPEAT-FROM:DUE`]).repeatFrom).toBeUndefined()
  expect(water(rule).repeatFrom).toBeUndefined()
})

Deno.test("a task completed three days late moves a week on from the completion day", () => {
  const late = [`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`]
  expect(lines(complete(water([...late, LINE]), BERLIN), `DUE`)).toEqual([
    `DUE;VALUE=DATE:20261021`,
  ])
  // Without the line: one step from the date it was due, as before.
  expect(lines(complete(water(late), BERLIN), `DUE`)).toEqual([`DUE;VALUE=DATE:20261018`])
})

Deno.test("a date-only task completed at 23:30 counts from that day in the person's zone", () => {
  // 03:30 UTC on the 15th is 23:30 on the 14th in New York and 12:30 on the 15th in Tokyo.
  const night = new Date(`2026-10-15T03:30:00Z`)
  const daily = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=DAILY;INTERVAL=3`, LINE])
  expect(lines(complete(daily, { timeZone: `America/New_York` }, night), `DUE`)).toEqual([
    `DUE;VALUE=DATE:20261017`,
  ])
  expect(lines(complete(daily, { timeZone: `Asia/Tokyo` }, night), `DUE`)).toEqual([
    `DUE;VALUE=DATE:20261018`,
  ])
})

Deno.test("a due time with a zone keeps its time, on the completion day in that zone", () => {
  const timed = water([
    `DTSTART;TZID=Asia/Tokyo:20261010T090000`,
    `DUE;TZID=Asia/Tokyo:20261011T180000`,
    `RRULE:FREQ=DAILY;INTERVAL=2`,
    LINE,
  ])
  // In Tokyo it is already the 15th; the person's own zone is not asked.
  expect(lines(complete(timed, BERLIN), `DTSTART`, `DUE`)).toEqual([
    `DTSTART;TZID=Asia/Tokyo:20261016T090000`,
    `DUE;TZID=Asia/Tokyo:20261017T180000`,
  ])
  expect(lines(complete(timed), `DUE`)).toEqual([`DUE;TZID=Asia/Tokyo:20261017T180000`])
})

Deno.test("the start date moves by as much as the due date", () => {
  const span = water([
    `DTSTART;VALUE=DATE:20261009`,
    `DUE;VALUE=DATE:20261011`,
    `RRULE:FREQ=WEEKLY`,
    LINE,
  ])
  expect(lines(complete(span, BERLIN), `DTSTART`, `DUE`)).toEqual([
    `DTSTART;VALUE=DATE:20261019`,
    `DUE;VALUE=DATE:20261021`,
  ])
})

Deno.test("a floating due time keeps its time, on the completion day in the person's zone", () => {
  const floating = water([`DUE:20261011T090000`, `RRULE:FREQ=DAILY`, LINE])
  expect(lines(complete(floating, BERLIN), `DUE`)).toEqual([`DUE:20261015T090000`])
  expect(lines(complete(floating, { timeZone: `Asia/Tokyo` }), `DUE`)).toEqual([
    `DUE:20261016T090000`,
  ])
})

Deno.test("a UTC due time keeps the hour the person sees, on the day they completed it", () => {
  // 07:00 UTC is 09:00 in Berlin in October; in Tokyo it is 16:00, and there it is the 15th.
  const utc = water([`DUE:20261011T070000Z`, `RRULE:FREQ=DAILY;INTERVAL=2`, LINE])
  expect(lines(complete(utc, BERLIN), `DUE`)).toEqual([`DUE:20261016T070000Z`])
  expect(lines(complete(utc, { timeZone: `Asia/Tokyo` }), `DUE`)).toEqual([`DUE:20261017T070000Z`])
})

Deno.test("without a zone, a task counted from completion is refused and left as it was", () => {
  for (const due of [`DUE;VALUE=DATE:20261011`, `DUE:20261011T090000`, `DUE:20261011T070000Z`]) {
    const from = water([due, `RRULE:FREQ=DAILY`, LINE])
    for (const options of [undefined, { timeZone: `Mars/Olympus` }]) {
      const result = completeTask(from, NOW, options)
      expect(result.success).toBe(false)
      expect(result.error!.code).toBe(CompleteTodoErrorCode.UnusableDate)
    }
  }
})

Deno.test("COUNT is lowered by one however late the task was completed", () => {
  // Two occurrences of the rule have passed since the due date; one completion was made.
  const counted = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=DAILY;COUNT=3`, LINE])
  expect(lines(complete(counted, BERLIN), `DUE`, `RRULE`, `STATUS`)).toEqual([
    `DUE;VALUE=DATE:20261015`,
    `RRULE:FREQ=DAILY;COUNT=2`,
  ])
})

Deno.test("COUNT=1 ends the series: the task is completed where it stands", () => {
  const last = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=DAILY;COUNT=1`, LINE])
  expect(lines(complete(last, BERLIN), `DUE`, `RRULE`, `STATUS`, `X-REPEAT`)).toEqual([
    `DUE;VALUE=DATE:20261011`,
    `RRULE:FREQ=DAILY;COUNT=1`,
    LINE,
    `STATUS:COMPLETED`,
  ])
})

Deno.test("UNTIL ends the series when the next date from completion would pass it", () => {
  const ending = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY;UNTIL=20261020`, LINE])
  // From the due date the 18th would still fit; from the 14th the next is the 21st.
  expect(lines(complete(ending, BERLIN), `DUE`, `STATUS`)).toEqual([
    `DUE;VALUE=DATE:20261011`,
    `STATUS:COMPLETED`,
  ])
  const open = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY;UNTIL=20261021`, LINE])
  expect(lines(complete(open, BERLIN), `DUE`, `STATUS`)).toEqual([`DUE;VALUE=DATE:20261021`])
})

Deno.test("a weekly rule on fixed weekdays moves to the next listed weekday", () => {
  // Completed on a Wednesday: Friday the 16th is next, not Wednesday itself.
  const days = water([`DUE;VALUE=DATE:20261005`, `RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR`, LINE])
  expect(lines(complete(days, BERLIN), `DUE`, `RRULE`)).toEqual([
    `DUE;VALUE=DATE:20261016`,
    `RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR`,
  ])
})

Deno.test("a weekly rule on fixed weekdays skips INTERVAL - 1 weeks first", () => {
  // Tasks.org: a week after the completion Wednesday, then the next Monday, which is the 26th.
  // Counted as RFC 5545 weeks from the completion day, Monday the 26th would be in an off week.
  const days = water([`DUE;VALUE=DATE:20261005`, `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`, LINE])
  expect(lines(complete(days, BERLIN), `DUE`, `RRULE`)).toEqual([
    `DUE;VALUE=DATE:20261026`,
    `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO`,
  ])
  const three = water([`DUE;VALUE=DATE:20261005`, `RRULE:FREQ=WEEKLY;INTERVAL=3;BYDAY=FR`, LINE])
  expect(lines(complete(three, BERLIN), `DUE`)).toEqual([`DUE;VALUE=DATE:20261030`])
})

Deno.test("a monthly rule on a fixed day moves to that day after the completion day", () => {
  const monthly = water([`DUE;VALUE=DATE:20260901`, `RRULE:FREQ=MONTHLY;BYMONTHDAY=1`, LINE])
  expect(lines(complete(monthly, BERLIN), `DUE`)).toEqual([`DUE;VALUE=DATE:20261101`])
  const twenty = water([`DUE;VALUE=DATE:20260920`, `RRULE:FREQ=MONTHLY;BYMONTHDAY=20`, LINE])
  expect(lines(complete(twenty, BERLIN), `DUE`)).toEqual([`DUE;VALUE=DATE:20261020`])
})

Deno.test("a reminder at a fixed time moves as far as the due date did; a relative one stays", () => {
  const reminded = water([
    `DUE;VALUE=DATE:20261011`,
    `RRULE:FREQ=WEEKLY`,
    LINE,
    `BEGIN:VALARM`,
    `TRIGGER;VALUE=DATE-TIME:20261010T180000Z`,
    `ACTION:DISPLAY`,
    `DESCRIPTION:The evening before`,
    `END:VALARM`,
  ])
  // The due date moved ten days, from the 11th to the 21st.
  expect(lines(complete(reminded, BERLIN), `TRIGGER`)).toEqual([
    `TRIGGER;VALUE=DATE-TIME:20261020T180000Z`,
    `TRIGGER;RELATED=END:PT0S`,
  ])
})

Deno.test("FROM=COMPLETION inside the rule is refused with or without the line", () => {
  for (const rest of [[], [LINE]]) {
    const old = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=DAILY;FROM=COMPLETION`, ...rest])
    const result = completeTask(old, NOW, BERLIN)
    expect(result.success).toBe(false)
    expect(result.error!.code).toBe(CompleteTodoErrorCode.UnsupportedRule)
  }
})

Deno.test("a task with a rule and no due date gets one, counted from the completion day", () => {
  const open = water([`DTSTART;VALUE=DATE:20261001`, `RRULE:FREQ=DAILY;INTERVAL=2`, LINE])
  expect(lines(complete(open, BERLIN), `DTSTART`, `DUE`, `STATUS`, `TRIGGER`)).toEqual([
    `DTSTART;VALUE=DATE:20261001`,
    `DUE;VALUE=DATE:20261016`,
    `TRIGGER;RELATED=END:PT0S`,
  ])
})

Deno.test("a task with a rule and no due date is refused when DUE would not fit", () => {
  const refused = [
    // Counted from the due date: there is none.
    [`RRULE:FREQ=DAILY`],
    // A date-only DUE next to a DTSTART with a time.
    [`DTSTART:20261001T090000Z`, `RRULE:FREQ=DAILY`, LINE],
    // DUE next to DURATION.
    [`DTSTART;VALUE=DATE:20261001`, `DURATION:P1D`, `RRULE:FREQ=DAILY`, LINE],
  ]
  for (const rest of refused) {
    const result = completeTask(water(rest), NOW, BERLIN)
    expect(result.success).toBe(false)
    expect(result.error!.code).toBe(CompleteTodoErrorCode.NoDueDate)
  }
})

const REPEATING = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`, `X-OTHER;A=b:kept`])
const FROM_COMPLETION = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`, LINE])

Deno.test("editTask sets the choice by adding one line and changes nothing else", () => {
  const set = edit(REPEATING, { repeatFrom: RepeatFrom.Completion })
  expect(set.repeatFrom).toBe(RepeatFrom.Completion)
  const before = unstamped(REPEATING.ics)
  const added = unstamped(set.ics).filter((line) => !before.includes(line))
  expect(added).toEqual([LINE])
  expect(unstamped(set.ics).filter((line) => line !== LINE)).toEqual(before)
})

Deno.test("editTask clears the choice by removing the line and changes nothing else", () => {
  const cleared = edit(FROM_COMPLETION, { repeatFrom: RepeatFrom.DueDate })
  expect(cleared.repeatFrom).toBeUndefined()
  expect(unstamped(cleared.ics)).toEqual(
    unstamped(FROM_COMPLETION.ics).filter((line) => line !== LINE),
  )
})

Deno.test("sending the choice a task already has leaves the text byte for byte", () => {
  const lower = water([`DUE;VALUE=DATE:20261011`, `RRULE:FREQ=WEEKLY`, `X-REPEAT-FROM:completion`])
  expect(edit(lower, { repeatFrom: RepeatFrom.Completion }).ics).toBe(lower.ics)
  expect(edit(REPEATING, { repeatFrom: RepeatFrom.DueDate }).ics).toBe(REPEATING.ics)
})

Deno.test("removing the repeat rule removes the line", () => {
  const plain = edit(FROM_COMPLETION, { repeatRule: null })
  expect(lines(plain.ics, `RRULE`, `X-REPEAT`)).toEqual([])
  expect(plain.repeatFrom).toBeUndefined()
})

Deno.test("the choice is not written on a task that does not repeat", () => {
  const once = water([`DUE;VALUE=DATE:20261011`])
  expect(lines(edit(once, { repeatFrom: RepeatFrom.Completion }).ics, `X-REPEAT`)).toEqual([])
  const made = edit(once, { repeatRule: `FREQ=DAILY`, repeatFrom: RepeatFrom.Completion })
  expect(lines(made.ics, `RRULE`, `X-REPEAT`)).toEqual([`RRULE:FREQ=DAILY;INTERVAL=1`, LINE])
})

Deno.test("patchTodo refuses a repeatFrom that is neither choice", () => {
  const root = parseIcal(REPEATING.ics).output!
  const result = patchTodo(root, { repeatFrom: 3 as RepeatFrom }, { now: NOW })
  expect(result.success).toBe(false)
  expect(result.error!.message).toBe(`unknown repeatFrom 3`)
  expect(serializeIcal(root)).toBe(REPEATING.ics)
})

Deno.test("newTodo writes the choice of a new repeating task", () => {
  const made = newTodo({
    summary: `Water the plants`,
    due: FROM_COMPLETION.due,
    rrule: `FREQ=WEEKLY`,
    repeatFrom: RepeatFrom.Completion,
  }, { now: NOW, uid: `n1`, prodid: `-//test//EN` })
  expect(lines(serializeIcal(made.output!), `X-REPEAT`)).toEqual([LINE])
})

Deno.test("rebaseEdit carries the choice onto the server's copy", () => {
  const theirs = edit(REPEATING, { title: `Water the ferns` })
  const result = rebaseEdit(REPEATING, { repeatFrom: RepeatFrom.Completion }, theirs, NOW)
  expect(result.output!.kind).toBe(RebaseKind.Applied)
  const applied = result.output as { task: Task }
  expect(lines(applied.task.ics, `SUMMARY`, `X-REPEAT`)).toEqual([`SUMMARY:Water the ferns`, LINE])
})

Deno.test("a choice the editor sent back unchanged does not undo the server's", () => {
  const theirs = edit(REPEATING, { repeatFrom: RepeatFrom.Completion })
  const mine = { repeatFrom: RepeatFrom.DueDate, title: `Water the ferns` }
  const result = rebaseEdit(REPEATING, mine, theirs, NOW)
  expect(result.output!.kind).toBe(RebaseKind.Applied)
  const applied = result.output as { task: Task }
  expect(lines(applied.task.ics, `SUMMARY`, `X-REPEAT`)).toEqual([`SUMMARY:Water the ferns`, LINE])
})

Deno.test("keepMineText carries a choice I set, and one I cleared, onto the server's copy", () => {
  const theirs = edit(REPEATING, { title: `Water the ferns` })
  const mine = edit(REPEATING, { repeatFrom: RepeatFrom.Completion })
  const set = keepMineText(REPEATING.ics, mine.ics, theirs, NOW, BERLIN)
  expect(lines(set.output!.ics, `SUMMARY`, `X-REPEAT`, `X-OTHER`)).toEqual([
    `SUMMARY:Water the ferns`,
    `X-OTHER;A=b:kept`,
    LINE,
  ])
  const renamed = edit(FROM_COMPLETION, { title: `Water the ferns` })
  const off = edit(FROM_COMPLETION, { repeatFrom: RepeatFrom.DueDate })
  const cleared = keepMineText(FROM_COMPLETION.ics, off.ics, renamed, NOW, BERLIN)
  expect(lines(cleared.output!.ics, `SUMMARY`, `X-REPEAT`)).toEqual([`SUMMARY:Water the ferns`])
})

Deno.test("keepMineText makes my completion again from the day it is replayed", () => {
  const theirs = edit(FROM_COMPLETION, { title: `Water the ferns` })
  const mine = fixtureTask(complete(FROM_COMPLETION, BERLIN))
  const kept = keepMineText(FROM_COMPLETION.ics, mine.ics, theirs, NOW, BERLIN)
  expect(lines(kept.output!.ics, `SUMMARY`, `DUE`)).toEqual([
    `SUMMARY:Water the ferns`,
    `DUE;VALUE=DATE:20261021`,
  ])
})

Deno.test("keepMineText replayed on a later day keeps the dates my completion gave", () => {
  const theirs = edit(FROM_COMPLETION, { title: `Water the ferns` })
  const mine = fixtureTask(complete(FROM_COMPLETION, BERLIN))
  const later = new Date(`2026-10-16T10:00:00Z`)
  const kept = keepMineText(FROM_COMPLETION.ics, mine.ics, theirs, later, BERLIN)
  expect(lines(kept.output!.ics, `SUMMARY`, `DUE`, `STATUS`)).toEqual([
    `SUMMARY:Water the ferns`,
    `DUE;VALUE=DATE:20261021`,
  ])
})
