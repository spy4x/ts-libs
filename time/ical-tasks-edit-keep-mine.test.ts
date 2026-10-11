import { expect } from "@std/expect"
import { IcalDateKind } from "./ical.ts"
import {
  completeTask,
  editTask,
  KeepMineStep,
  keepMineText,
  reopenTask,
  type TaskEdit,
} from "./ical-tasks-edit.ts"
import { AlarmRelated, AlarmTriggerKind, CompleteTodoErrorCode } from "./ical-tasks.ts"
import { type Task, TaskStatus } from "./ical-tasks-model.ts"
import { COMPLETED, fixtureTask, RECURRING, task, vtodo } from "./testdata/tasks/fixtures.ts"

const NOW = new Date(`2026-10-08T12:30:45.678Z`)
const ELSEWHERE = new Date(`2026-10-08T12:45:00.000Z`)
const LATER = new Date(`2026-10-08T13:00:00.000Z`)

const BASE = fixtureTask(task(`1`, `Original`, [
  `DESCRIPTION:Original notes`,
  `DTSTART;VALUE=DATE:20261008`,
  `DUE;VALUE=DATE:20261009`,
  `PRIORITY:1`,
  `CATEGORIES:a`,
  `X-APPLE-SORT-ORDER:100`,
  `X-VENDOR:keep me`,
]))
const REPEATING = fixtureTask(RECURRING)
const DONE = fixtureTask(COMPLETED)

function edited(from: Task, edit: TaskEdit, at = NOW): Task {
  const result = editTask(from, edit, at)
  if (!result.success) throw new Error(result.error)
  return result.output.task
}

function completed(from: Task, at = NOW): Task {
  const result = completeTask(from, at)
  if (!result.success) throw new Error(result.error.message)
  return result.output.task
}

/** The copy the server holds after someone else changed `from`. */
function server(from: Task): Task {
  return { ...from, etag: `"2"` }
}

function kept(base: Task, mine: Task, theirs: Task) {
  const result = keepMineText(base.ics, mine.ics, theirs, LATER)
  if (!result.success) throw new Error(result.error.message)
  return result.output
}

const day = (date: string) => ({ kind: IcalDateKind.Date as const, date })
const morning = (date: string, time = `07:00:00`) => ({
  kind: IcalDateKind.Zoned as const,
  date,
  time,
  tzid: `Asia/Ho_Chi_Minh`,
})

/** One row per field a task text carries: what I changed it to, and how the result reads it. */
const FIELDS: { name: string; mine: TaskEdit; read: (task: Task) => unknown; want: unknown }[] = [
  { name: `title`, mine: { title: `Mine` }, read: (t) => t.title, want: `Mine` },
  { name: `notes`, mine: { notes: `My notes` }, read: (t) => t.notes, want: `My notes` },
  {
    name: `due date`,
    mine: { due: day(`2026-10-20`) },
    read: (t) => t.due,
    want: day(`2026-10-20`),
  },
  {
    name: `start date`,
    mine: { start: day(`2026-10-05`) },
    read: (t) => t.start,
    want: day(`2026-10-05`),
  },
  { name: `priority`, mine: { priority: 5 }, read: (t) => t.priority, want: 5 },
  { name: `tags`, mine: { tags: [`a`, `b`] }, read: (t) => t.tags, want: [`a`, `b`] },
  { name: `sort order`, mine: { sortOrder: 42 }, read: (t) => t.sortOrder, want: 42 },
  {
    name: `repeat rule`,
    mine: { repeatRule: `FREQ=WEEKLY;INTERVAL=1` },
    read: (t) => t.repeatRule,
    want: `FREQ=WEEKLY;INTERVAL=1`,
  },
  {
    name: `reminders`,
    mine: {
      reminders: [{
        trigger: { kind: AlarmTriggerKind.Relative, duration: `-PT1H`, related: AlarmRelated.End },
      }],
    },
    read: (t) => t.reminders.map((reminder) => reminder.trigger),
    want: [`-PT1H`],
  },
]

for (const field of FIELDS) {
  Deno.test(`the ${field.name} I changed is written on the server's copy`, () => {
    const other: TaskEdit = field.name === `title` ? { notes: `Theirs` } : { title: `Theirs` }
    const theirs = server(edited(BASE, other, ELSEWHERE))
    const output = kept(BASE, edited(BASE, field.mine), theirs)
    expect(field.read(output.task)).toEqual(field.want)
    // My text still has the old title or notes; the server's stay.
    expect(output.task.title).toBe(field.name === `title` ? `Mine` : `Theirs`)
    expect(output.task.notes).toBe(
      field.name === `title` ? `Theirs` : field.name === `notes` ? `My notes` : `Original notes`,
    )
    expect(output.task.etag).toBe(`"2"`)
    expect(output.ics).toBe(output.task.ics)
  })
}

/** One row per field a text can lose. */
const CLEARED: { name: string; mine: TaskEdit; read: (task: Task) => unknown }[] = [
  { name: `due date`, mine: { due: null }, read: (t) => t.due },
  { name: `start date`, mine: { start: null }, read: (t) => t.start },
  { name: `sort order`, mine: { sortOrder: null }, read: (t) => t.sortOrder },
  { name: `repeat rule`, mine: { repeatRule: null }, read: (t) => t.repeatRule },
]

for (const field of CLEARED) {
  Deno.test(`the ${field.name} I removed is removed from the server's copy`, () => {
    const base = edited(BASE, { repeatRule: `FREQ=WEEKLY;INTERVAL=1` })
    const theirs = server(edited(base, { title: `Theirs` }, ELSEWHERE))
    expect(field.read(theirs)).toBeDefined()
    const output = kept(base, edited(base, field.mine), theirs)
    expect(field.read(output.task)).toBeUndefined()
    expect(output.task.title).toBe(`Theirs`)
  })
}

Deno.test(`the server's text is returned as it is when my text changed nothing`, () => {
  const theirs = server(edited(BASE, { title: `Theirs` }, ELSEWHERE))
  expect(kept(BASE, BASE, theirs).ics).toBe(theirs.ics)
})

Deno.test(`lines the model does not read stay as the server has them`, () => {
  const theirs = server(fixtureTask(
    edited(BASE, { notes: `Theirs` }, ELSEWHERE).ics.replace(
      `X-VENDOR:keep me`,
      `X-VENDOR:changed there\r\nX-OTHER:added there`,
    ),
  ))
  const output = kept(BASE, edited(BASE, { title: `Mine` }), theirs)
  const lines = (ics: string) =>
    ics.split(`\r\n`).filter((line) => !/^(SUMMARY|LAST-MODIFIED|DTSTAMP|SEQUENCE)/.test(line))
  expect(output.ics).toContain(`SUMMARY:Mine`)
  expect(lines(output.ics)).toEqual(lines(theirs.ics))
  expect(output.ics).toContain(`X-VENDOR:changed there`)
  expect(output.ics).toContain(`X-OTHER:added there`)
})

Deno.test(`a task I completed is completed on the server's copy`, () => {
  const theirs = server(edited(BASE, { title: `Theirs` }, ELSEWHERE))
  const output = kept(BASE, completed(BASE), theirs)
  expect(output.task.status).toBe(TaskStatus.Completed)
  expect(output.task.title).toBe(`Theirs`)
  expect(output.task.due).toEqual(day(`2026-10-09`))
})

Deno.test(`a task I reopened is reopened on the server's copy`, () => {
  const theirs = server(edited(DONE, { title: `Theirs` }, ELSEWHERE))
  const reopened = reopenTask(DONE, NOW)
  if (!reopened.success) throw new Error(reopened.error.message)
  const output = kept(DONE, reopened.output.task, theirs)
  expect(output.task.status).toBe(TaskStatus.NeedsAction)
  expect(output.task.title).toBe(`Theirs`)
  expect(output.ics).not.toContain(`COMPLETED:`)
})

Deno.test(`a task both sides completed keeps the server's completion`, () => {
  const theirs = server(completed(BASE, ELSEWHERE))
  expect(kept(BASE, completed(BASE), theirs).ics).toBe(theirs.ics)
})

Deno.test(`a task I reopened that the server's copy has open already stays as it is`, () => {
  const reopened = reopenTask(DONE, NOW)
  if (!reopened.success) throw new Error(reopened.error.message)
  const there = reopenTask(DONE, ELSEWHERE)
  if (!there.success) throw new Error(there.error.message)
  const theirs = server(there.output.task)
  expect(kept(DONE, reopened.output.task, theirs).ics).toBe(theirs.ics)
})

Deno.test(`a repeating task I completed moves on from the server's dates and stays open`, () => {
  const theirs = server(
    edited(REPEATING, { due: morning(`2026-10-12`, `09:00:00`), notes: `Theirs` }, ELSEWHERE),
  )
  const mine = edited(completed(REPEATING), { title: `Mine` })
  expect(mine.due).toEqual(morning(`2026-10-09`))
  const output = kept(REPEATING, mine, theirs)
  expect(output.task.status).toBe(TaskStatus.NeedsAction)
  expect(output.task.due).toEqual(morning(`2026-10-13`, `09:00:00`))
  expect(output.task.repeatRule).toBe(REPEATING.repeatRule)
  expect(output.task.title).toBe(`Mine`)
  expect(output.task.notes).toBe(`Theirs`)
})

Deno.test(`a repeating task both sides completed moves on once`, () => {
  const theirs = server(edited(completed(REPEATING, ELSEWHERE), { title: `Theirs` }, ELSEWHERE))
  const output = kept(REPEATING, completed(REPEATING), theirs)
  expect(output.task.due).toEqual(morning(`2026-10-09`))
  expect(output.ics).toBe(theirs.ics)
})

Deno.test(`a repeating task I completed twice moves on twice`, () => {
  const theirs = server(
    edited(REPEATING, { due: morning(`2026-10-12`, `09:00:00`) }, ELSEWHERE),
  )
  const output = kept(REPEATING, completed(completed(REPEATING)), theirs)
  expect(output.task.due).toEqual(morning(`2026-10-14`, `09:00:00`))
  expect(output.task.status).toBe(TaskStatus.NeedsAction)
})

Deno.test(`a repeating task I completed twice moves a server copy completed once on by one`, () => {
  const theirs = server(completed(REPEATING, ELSEWHERE))
  const output = kept(REPEATING, completed(completed(REPEATING)), theirs)
  expect(output.task.due).toEqual(morning(`2026-10-10`))
})

Deno.test(`refuses when the server's copy cannot take the completion I made`, () => {
  const base = fixtureTask(task(`2`, `Plain`, [`DTSTART;VALUE=DATE:20261009`]))
  const theirs = server(
    edited(base, { title: `Theirs`, repeatRule: `FREQ=WEEKLY;INTERVAL=1` }, ELSEWHERE),
  )
  expect(keepMineText(base.ics, completed(base).ics, theirs, LATER)).toEqual({
    success: false,
    output: null,
    error: {
      step: KeepMineStep.Complete,
      code: CompleteTodoErrorCode.NoDueDate,
      message: `a repeating task needs a DUE date`,
    },
  })
})

Deno.test(`refuses when the server's copy cannot take a field I changed`, () => {
  const zone = [
    `BEGIN:VTIMEZONE`,
    `TZID:Asia/Ho_Chi_Minh`,
    `BEGIN:STANDARD`,
    `TZOFFSETFROM:+0700`,
    `TZOFFSETTO:+0700`,
    `DTSTART:19700101T000000`,
    `END:STANDARD`,
    `END:VTIMEZONE`,
  ]
  const lines = [`DTSTAMP:20261001T080000Z`, `UID:3`, `SUMMARY:Plain`]
  const base = fixtureTask(vtodo(lines))
  // My text carries the zone it names; the server's copy has no such VTIMEZONE.
  const mine = fixtureTask(vtodo([...lines, `DUE;TZID=Asia/Ho_Chi_Minh:20261009T070000`], zone))
  const result = keepMineText(base.ics, mine.ics, server(base), LATER)
  expect(result.success).toBe(false)
  expect(result.error?.step).toBe(KeepMineStep.Edit)
  expect(result.error?.code).toBeUndefined()
  expect(result.error?.message).toContain(`VTIMEZONE`)
})

Deno.test(`refuses a base text or a text of mine that does not read as a task`, () => {
  const theirs = server(BASE)
  const broken = `BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n`
  expect(keepMineText(broken, BASE.ics, theirs, LATER).error).toMatchObject({
    step: KeepMineStep.Read,
    message: expect.stringContaining(`the base text`),
  })
  expect(keepMineText(BASE.ics, broken, theirs, LATER).error).toMatchObject({
    step: KeepMineStep.Read,
    message: expect.stringContaining(`my text`),
  })
})

Deno.test(`a server copy already at a later occurrence than mine does not move on`, () => {
  const theirs = server(edited(REPEATING, { due: morning(`2026-10-12`) }, ELSEWHERE))
  expect(kept(REPEATING, completed(REPEATING), theirs).ics).toBe(theirs.ics)
})
