// A patch must not remove the date a remaining relative reminder counts from (#451). Hand-written
// documents, one per case; the clock is passed in.

import { assert, assertEquals } from "@std/assert"
import { IcalComponent, IcalDateKind, IcalErrorCode, parseIcal, serializeIcal } from "./ical.ts"
import {
  AlarmInput,
  AlarmRelated,
  AlarmTriggerKind,
  EventPatch,
  patchEvent,
  patchTodo,
  TodoPatch,
} from "./ical-tasks.ts"
import { editTask } from "./ical-tasks-edit.ts"
import { parseTask } from "./ical-tasks-model.ts"

const NOW = new Date("2026-10-08T12:30:45.678Z")

function parse(text: string): IcalComponent {
  const result = parseIcal(text)
  if (!result.success) throw new Error(`parse failed: ${result.error.message}`)
  return result.output
}

function alarm(trigger: string): string {
  return `BEGIN:VALARM\r\nACTION:DISPLAY\r\n${trigger}\r\nDESCRIPTION:Ring\r\nEND:VALARM\r\n`
}

function todo(dates: string[], trigger: string): string {
  const lines = dates.map((line) => `${line}\r\n`).join("")
  return `BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t1\r\nSUMMARY:Pay rent\r\n${lines}${
    alarm(trigger)
  }END:VTODO\r\nEND:VCALENDAR\r\n`
}

function event(dates: string[], trigger: string): string {
  const lines = dates.map((line) => `${line}\r\n`).join("")
  return `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\nSUMMARY:Standup\r\n${lines}${
    alarm(trigger)
  }END:VEVENT\r\nEND:VCALENDAR\r\n`
}

const START = "DTSTART:20261010T100000Z"
const DUE = "DUE:20261011T100000Z"
const DTEND = "DTEND:20261010T110000Z"
const DURATION = "DURATION:PT1H"
const FROM_END = "TRIGGER;RELATED=END:-PT1H"
const FROM_START = "TRIGGER;RELATED=START:-PT15M"
const FROM_DEFAULT = "TRIGGER:-PT15M"
const ABSOLUTE = "TRIGGER;VALUE=DATE-TIME:20261009T080000Z"

const ABSOLUTE_INPUT: AlarmInput = {
  trigger: {
    kind: AlarmTriggerKind.Absolute,
    at: { kind: IcalDateKind.Utc, date: "2026-10-09", time: "08:00:00" },
  },
}

/** Patch `text` and expect a refusal that names every word of `names` and leaves it unchanged. */
function refusesTodo(text: string, patch: TodoPatch, names: string[]) {
  const root = parse(text)
  const before = serializeIcal(root)
  const result = patchTodo(root, patch, { now: NOW })
  assertEquals(result.error?.code, IcalErrorCode.InvalidValue)
  for (const name of names) assert(result.error!.message.includes(name), result.error!.message)
  assertEquals(serializeIcal(root), before)
}

function refusesEvent(text: string, patch: EventPatch, names: string[]) {
  const root = parse(text)
  const before = serializeIcal(root)
  const result = patchEvent(root, patch, { now: NOW })
  assertEquals(result.error?.code, IcalErrorCode.InvalidValue)
  for (const name of names) assert(result.error!.message.includes(name), result.error!.message)
  assertEquals(serializeIcal(root), before)
}

function patchedTodo(text: string, patch: TodoPatch): string {
  const root = parse(text)
  const result = patchTodo(root, patch, { now: NOW })
  if (!result.success) throw new Error(`patch refused: ${result.error.message}`)
  return serializeIcal(root)
}

function patchedEvent(text: string, patch: EventPatch): string {
  const root = parse(text)
  const result = patchEvent(root, patch, { now: NOW })
  if (!result.success) throw new Error(`patch refused: ${result.error.message}`)
  return serializeIcal(root)
}

Deno.test("clearing the due date of a task with a reminder counted from the end is refused and changes nothing", () => {
  refusesTodo(todo([START, DUE], FROM_END), { due: null }, ["DUE", "-PT1H", "end"])
})

Deno.test("sending the same end reminder back while clearing the due date is still refused", () => {
  const same: AlarmInput = {
    trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H", related: AlarmRelated.End },
  }
  refusesTodo(todo([DUE], FROM_END), { due: null, alarms: [same] }, ["DUE", "-PT1H"])
})

Deno.test("clearing the due date succeeds when the same patch removes the reminders or leaves one that needs no due date", () => {
  const text = todo([START, DUE], FROM_END)
  const cleared = patchedTodo(text, { due: null, alarms: null })
  assert(!cleared.includes("DUE:") && !cleared.includes("VALARM"))
  const absolute = patchedTodo(text, { due: null, alarms: [ABSOLUTE_INPUT] })
  assert(!absolute.includes("DUE:") && !absolute.includes("RELATED=END"))
  assert(absolute.includes("TRIGGER;VALUE=DATE-TIME:20261009T080000Z"))
  const fromStart = patchedTodo(text, {
    due: null,
    alarms: [{ trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT5M" } }],
  })
  assert(!fromStart.includes("DUE:") && fromStart.includes("TRIGGER:-PT5M"))
})

Deno.test("clearing the start of a task with a reminder counted from the start is refused, with RELATED=START or without RELATED", () => {
  refusesTodo(todo([START, DUE], FROM_START), { start: null }, ["DTSTART", "-PT15M", "start"])
  refusesTodo(todo([START, DUE], FROM_DEFAULT), { start: null }, ["DTSTART", "-PT15M", "start"])
  assert(
    !patchedTodo(todo([START, DUE], FROM_DEFAULT), { start: null, alarms: null }).includes(
      "DTSTART",
    ),
  )
})

Deno.test("clearing the start of a task whose end is its start plus a duration is refused for an end reminder", () => {
  refusesTodo(todo([START, DURATION], FROM_END), { start: null }, ["DTSTART", "-PT1H", "end"])
})

Deno.test("clearing a date the reminder does not count from is not refused", () => {
  assert(!patchedTodo(todo([START, DUE], FROM_END), { start: null }).includes("DTSTART"))
  assert(!patchedTodo(todo([START, DUE], FROM_DEFAULT), { due: null }).includes("DUE:"))
})

Deno.test("an absolute reminder does not stop a task or an event from losing its dates", () => {
  const task = patchedTodo(todo([START, DUE], ABSOLUTE), { start: null, due: null })
  assert(!task.includes("DTSTART") && !task.includes("DUE:") && task.includes(ABSOLUTE))
  const meeting = patchedEvent(event([START, DTEND], ABSOLUTE), { start: null, end: null })
  assert(!meeting.includes("DTSTART") && !meeting.includes("DTEND") && meeting.includes(ABSOLUTE))
})

Deno.test("a reminder that had no date before the patch does not block an unrelated change", () => {
  const renamed = patchedTodo(todo([START], FROM_END), { summary: "Pay the rent" })
  assert(renamed.includes("SUMMARY:Pay the rent") && renamed.includes(FROM_END))
})

Deno.test("clearing the start of an event with a reminder counted from the start is refused", () => {
  refusesEvent(event([START, DTEND], FROM_DEFAULT), { start: null }, ["DTSTART", "-PT15M"])
  refusesEvent(event([START, DTEND], FROM_START), { start: null }, ["DTSTART", "-PT15M"])
})

Deno.test("clearing the end of an event with a reminder counted from the end is refused", () => {
  refusesEvent(event([START, DTEND], FROM_END), { end: null }, ["DTEND", "-PT1H", "end"])
  const cleared = patchedEvent(event([START, DTEND], FROM_END), { end: null, alarms: null })
  assert(!cleared.includes("DTEND") && !cleared.includes("VALARM"))
})

Deno.test("clearing the duration of an event with a reminder counted from the end is refused", () => {
  refusesEvent(event([START, DURATION], FROM_END), { duration: null }, ["DURATION", "-PT1H"])
  const kept = patchedEvent(event([START, DURATION], FROM_END), {
    duration: null,
    alarms: [ABSOLUTE_INPUT],
  })
  assert(!kept.includes("DURATION") && kept.includes("TRIGGER;VALUE=DATE-TIME"))
})

Deno.test("clearing the start of an event whose end is its start plus a duration is refused for an end reminder", () => {
  refusesEvent(event([START, DURATION], FROM_END), { start: null }, ["DTSTART", "-PT1H", "end"])
})

Deno.test("an end reminder stays when an event's end is replaced by a duration", () => {
  const swapped = patchedEvent(event([START, DTEND], FROM_END), { duration: "PT2H" })
  assert(!swapped.includes("DTEND") && swapped.includes("DURATION:PT2H"))
  assert(swapped.includes(FROM_END))
})

Deno.test("an end reminder stays when an event's duration is replaced by an end", () => {
  const swapped = patchedEvent(event([START, DURATION], FROM_END), {
    end: { kind: IcalDateKind.Utc, date: "2026-10-10", time: "12:00:00" },
  })
  assert(!swapped.includes("DURATION") && swapped.includes("DTEND:20261010T120000Z"))
  assert(swapped.includes(FROM_END))
})

Deno.test("an end reminder stays when an event with both an end and a duration loses either one", () => {
  const both = event([START, DTEND, DURATION], FROM_END)
  const noEnd = patchedEvent(both, { end: null })
  assert(!noEnd.includes("DTEND") && noEnd.includes(DURATION) && noEnd.includes(FROM_END))
  const noDuration = patchedEvent(both, { duration: null })
  assert(!noDuration.includes("DURATION") && noDuration.includes(DTEND))
  assert(noDuration.includes(FROM_END))
})

Deno.test("editTask refuses to clear the due date under an end reminder and passes the message on", () => {
  const read = parseTask({
    href: "/cal/t1.ics",
    etag: `"1"`,
    listHref: "/cal/",
    ics: todo([DUE], FROM_END),
  })
  if (!read.success) throw new Error(read.error)
  const result = editTask(read.output, { due: null }, NOW)
  assertEquals(result.success, false)
  assert(result.error!.includes("DUE") && result.error!.includes("-PT1H"), result.error!)
  assert(editTask(read.output, { due: null, reminders: [] }, NOW).success)
})
