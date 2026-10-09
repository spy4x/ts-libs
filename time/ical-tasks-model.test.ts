import { expect } from "@std/expect"
import { IcalDateKind } from "./ical.ts"
import { AlarmRelated, AlarmTriggerKind } from "./ical-tasks.ts"
import {
  dateDay,
  dateInstant,
  isOpen,
  parseTask,
  PriorityBand,
  priorityBand,
  TaskStatus,
} from "./ical-tasks-model.ts"
import {
  COMPLETED,
  DUE_KINDS,
  ERRANDS,
  fixtureTask,
  LIST_HREF,
  RECURRING,
  STAMP_ONLY,
  task,
} from "./testdata/tasks/fixtures.ts"
Deno.test("reads every field of a repeating Tasks.org task", () => {
  const read = fixtureTask(RECURRING)
  expect(read.uid).toBe(`100200320`)
  expect(read.title).toBe(`Stretch before breakfast`)
  expect(read.notes).toBe(`Ten minutes, no phone`)
  expect(read.priority).toBe(1)
  expect(read.tags).toEqual([`health`, `morning`])
  expect(read.repeatRule).toBe(`FREQ=DAILY;INTERVAL=1`)
  expect(read.sortOrder).toBe(783013311)
  expect(read.due).toEqual({
    kind: IcalDateKind.Zoned,
    date: `2026-10-08`,
    time: `07:00:00`,
    tzid: `Asia/Ho_Chi_Minh`,
  })
  expect(read.reminders).toEqual([{
    trigger: `PT0S`,
    alarm: { kind: AlarmTriggerKind.Relative, duration: `PT0S`, related: AlarmRelated.End },
  }])
  expect(read.status).toBe(TaskStatus.NeedsAction)
})

Deno.test("keeps the href, etag, list and raw text it was given", () => {
  const result = parseTask({ href: `/a.ics`, etag: `"e7"`, listHref: LIST_HREF, ics: RECURRING })
  if (!result.success) throw new Error(result.error)
  expect(result.output.href).toBe(`/a.ics`)
  expect(result.output.etag).toBe(`"e7"`)
  expect(result.output.listHref).toBe(LIST_HREF)
  expect(result.output.ics).toBe(RECURRING)
})

Deno.test("a RELATED-TO with no RELTYPE makes the task a subtask", () => {
  expect(fixtureTask(ERRANDS[`100200301`]).parentUid).toBe(`100200300`)
})

Deno.test("a RELATED-TO of type CHILD or SIBLING does not name a parent", () => {
  const child = fixtureTask(task(`1`, `Parent`, [`RELATED-TO;RELTYPE=CHILD:2`]))
  const sibling = fixtureTask(task(`3`, `Next`, [`RELATED-TO;RELTYPE=SIBLING:2`]))
  expect(child.parentUid).toBeUndefined()
  expect(sibling.parentUid).toBeUndefined()
})

Deno.test("a task with no STATUS needs action, and a completed one is not open", () => {
  expect(fixtureTask(ERRANDS[`100200303`]).status).toBe(TaskStatus.NeedsAction)
  const done = fixtureTask(COMPLETED)
  expect(done.status).toBe(TaskStatus.Completed)
  expect(isOpen(done)).toBe(false)
  expect(isOpen(fixtureTask(ERRANDS[`100200303`]))).toBe(true)
})

Deno.test("a task in process is open and a cancelled one is not", () => {
  expect(isOpen(fixtureTask(task(`1`, `Going`, [`STATUS:IN-PROCESS`])))).toBe(true)
  expect(isOpen(fixtureTask(task(`2`, `Dropped`, [`STATUS:CANCELLED`])))).toBe(false)
})

Deno.test("a resource with no VTODO is a failure, not a throw", () => {
  const result = parseTask({
    href: `/x.ics`,
    etag: `"1"`,
    listHref: LIST_HREF,
    ics: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n`,
  })
  expect(result.success).toBe(false)
})

Deno.test("a task with no UID is a failure, not a throw", () => {
  const ics = task(`1`, `Nameless`).replace(`UID:1\r\n`, ``)
  const result = parseTask({ href: `/x.ics`, etag: `"1"`, listHref: LIST_HREF, ics })
  expect(result.success).toBe(false)
})

Deno.test("text that is not iCalendar is a failure, not a throw", () => {
  const result = parseTask({ href: `/x.ics`, etag: `"1"`, listHref: LIST_HREF, ics: `hello` })
  expect(result.success).toBe(false)
})

Deno.test("priorities 1 to 4 are high, 5 medium, 6 to 9 low and 0 none", () => {
  const bands = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(priorityBand)
  expect(bands).toEqual([
    PriorityBand.None,
    PriorityBand.High,
    PriorityBand.High,
    PriorityBand.High,
    PriorityBand.High,
    PriorityBand.Medium,
    PriorityBand.Low,
    PriorityBand.Low,
    PriorityBand.Low,
    PriorityBand.Low,
  ])
})

const UTC = `UTC`
const HO_CHI_MINH = `Asia/Ho_Chi_Minh`
const LOS_ANGELES = `America/Los_Angeles`

Deno.test("a date-only due falls on the day it is written, in any zone", () => {
  const due = fixtureTask(DUE_KINDS.date).due!
  expect(dateDay(due, UTC)).toBe(`2026-10-08`)
  expect(dateDay(due, HO_CHI_MINH)).toBe(`2026-10-08`)
  expect(dateDay(due, LOS_ANGELES)).toBe(`2026-10-08`)
})

Deno.test("a floating due falls on the day its wall clock is written, in any zone", () => {
  // 23:30 on the 8th; converting it from UTC would move it to the 9th in Ho Chi Minh.
  const due = fixtureTask(DUE_KINDS.floating).due!
  expect(dateDay(due, UTC)).toBe(`2026-10-08`)
  expect(dateDay(due, HO_CHI_MINH)).toBe(`2026-10-08`)
  expect(dateDay(due, LOS_ANGELES)).toBe(`2026-10-08`)
})

Deno.test("a UTC due is shifted into the viewer's day", () => {
  const due = fixtureTask(DUE_KINDS.utc).due! // 23:30Z on the 8th
  expect(dateDay(due, UTC)).toBe(`2026-10-08`)
  expect(dateDay(due, HO_CHI_MINH)).toBe(`2026-10-09`)
  expect(dateDay(due, LOS_ANGELES)).toBe(`2026-10-08`)
})

Deno.test("a zoned due keeps its instant and lands on the viewer's day", () => {
  // 03:00 on the 9th in Ho Chi Minh is 20:00 on the 8th in UTC.
  const parsed = fixtureTask(
    task(`1`, `Early`, [`DUE;TZID=Asia/Ho_Chi_Minh:20261009T030000`]).replace(
      `END:VCALENDAR`,
      `BEGIN:VTIMEZONE\r\nTZID:Asia/Ho_Chi_Minh\r\nEND:VTIMEZONE\r\nEND:VCALENDAR`,
    ),
  )
  expect(dateDay(parsed.due!, UTC)).toBe(`2026-10-08`)
  expect(dateDay(parsed.due!, HO_CHI_MINH)).toBe(`2026-10-09`)
  expect(dateDay(parsed.due!, LOS_ANGELES)).toBe(`2026-10-08`)
})

Deno.test("a zoned value with a zone name the runtime does not know is read in the viewer's zone", () => {
  const due = {
    kind: IcalDateKind.Zoned,
    date: `2026-10-08`,
    time: `10:00:00`,
    tzid: `W. Europe Standard Time`,
  }
  expect(dateDay(due, UTC)).toBe(`2026-10-08`)
  expect(dateInstant(due, UTC).toISOString()).toBe(`2026-10-08T10:00:00.000Z`)
  expect(dateInstant(due, HO_CHI_MINH).toISOString()).toBe(`2026-10-08T03:00:00.000Z`)
})

Deno.test("a task with no CREATED is created at its DTSTAMP", () => {
  const stamped = fixtureTask(STAMP_ONLY)
  expect(stamped.created).toEqual({
    kind: IcalDateKind.Utc,
    date: `2026-10-01`,
    time: `08:00:00`,
  })
})

Deno.test("a date and a floating time stay on the day they are written, even on a day the zone skipped", () => {
  // Samoa went from 2011-12-29 straight to 2011-12-31, so no instant on the 30th exists there.
  const skipped = `Pacific/Apia`
  const date = { kind: IcalDateKind.Date, date: `2011-12-30` }
  const floating = { kind: IcalDateKind.Floating, date: `2011-12-30`, time: `12:00:00` }
  expect(dateDay(date, skipped)).toBe(`2011-12-30`)
  expect(dateDay(floating, skipped)).toBe(`2011-12-30`)
})
