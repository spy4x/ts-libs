// Behaviour tests for the task and event helpers. They run on the recorded and hand-written
// fixtures in `testdata/ical/` (Tasks.org via Stalwart and Radicale, Nextcloud, Thunderbird,
// Apple, Outlook). Deterministic: the clock, UID and PRODID are passed in.

import { assert, assertEquals } from "@std/assert"
import {
  getProperties,
  getProperty,
  IcalComponent,
  IcalDateKind,
  IcalDateValue,
  IcalErrorCode,
  parseIcal,
  serializeIcal,
} from "./ical.ts"
import {
  AlarmInput,
  AlarmRelated,
  AlarmTriggerKind,
  EventStatus,
  newEvent,
  newTodo,
  patchEvent,
  patchTodo,
  readEvent,
  readTodo,
  TodoStatus,
} from "./ical-tasks.ts"

const FIXTURES = new URL("./testdata/ical/", import.meta.url)
const NOW = new Date("2026-10-08T12:30:45.678Z")
const NOW_STAMP = "20261008T123045Z"
const TODO_FIXTURES = [
  "nextcloud-sample.ics",
  "radicale-tasksorg-subtask.ics",
  "stalwart-tasksorg-date-due.ics",
  "stalwart-tasksorg-folded.ics",
  "stalwart-tasksorg-recurring.ics",
  "tasksorg-sample.ics",
  "thunderbird-sample.ics",
]

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES))
}

function parse(text: string): IcalComponent {
  const result = parseIcal(text)
  if (!result.success) throw new Error(`parse failed: ${result.error.message}`)
  return result.output
}

/** Logical lines of a CRLF document: each entry holds a line and its continuation lines. */
function logicalLines(text: string): string[] {
  const out: string[] = []
  for (const line of text.split("\r\n").slice(0, -1)) {
    if (line.startsWith(" ") || line.startsWith("\t")) out[out.length - 1] += `\r\n${line}`
    else out.push(line)
  }
  return out
}

/** The distinct property names of the lines that exists in only one of the two documents. */
function changedNames(before: string, after: string): string[] {
  const left = logicalLines(before)
  const right = logicalLines(after)
  const names: string[] = []
  for (const [from, to] of [[left, right], [right, left]] as const) {
    const pool = [...to]
    for (const line of from) {
      const at = pool.indexOf(line)
      if (at >= 0) pool.splice(at, 1)
      else names.push(line.split(/[;:]/, 1)[0]!)
    }
  }
  return [...new Set(names)].sort()
}

function utc(date: string, time: string): IcalDateValue {
  return { kind: IcalDateKind.Utc, date, time }
}

function mustPatch(
  root: IcalComponent,
  patch: Parameters<typeof patchTodo>[1],
  completeSeries = false,
) {
  const result = patchTodo(root, patch, { now: NOW, completeSeries })
  if (!result.success) throw new Error(`patch failed: ${result.error.message}`)
  return result.output
}

Deno.test("readTodo reads a Tasks.org repeating task with its zone, sort order and reminder", async () => {
  const todo = readTodo(parse(await fixture("stalwart-tasksorg-recurring.ics")))!
  assertEquals(todo.uid, "f3d88f01-4127-46fb-9aca-04729289ea24")
  assertEquals(todo.status, TodoStatus.NeedsAction)
  assertEquals(todo.priority, 1)
  assertEquals(todo.repeats, true)
  assertEquals(todo.rrule, "FREQ=DAILY;INTERVAL=1")
  assertEquals(todo.categories, ["one"])
  assertEquals(todo.sortOrder, 783013311)
  assertEquals(todo.due, {
    kind: IcalDateKind.Zoned,
    date: "2026-08-14",
    time: "11:00:01",
    tzid: "Asia/Ho_Chi_Minh",
  })
  assertEquals(todo.created, utc("2026-06-22", "09:18:45"))
  assertEquals(todo.hasAlarms, true)
  assertEquals(todo.alarms, [{
    action: "DISPLAY",
    trigger: { kind: AlarmTriggerKind.Relative, duration: "PT0S", related: AlarmRelated.End },
  }])
})

Deno.test("readTodo reads RELATED-TO without RELTYPE as PARENT and keeps an explicit type", async () => {
  const plain = readTodo(parse(await fixture("radicale-tasksorg-subtask.ics")))!
  assertEquals(plain.relatedTo, [{ uid: "9071723460158", type: "PARENT" }])
  assertEquals(plain.sortOrder, 792512400)
  const typed = readTodo(parse(await fixture("nextcloud-sample.ics")))!
  assertEquals(typed.relatedTo, [{ uid: "nc-parent-0001", type: "PARENT" }])
  const sibling = parse(
    "BEGIN:VTODO\r\nRELATED-TO;RELTYPE=sibling:x\r\nRELATED-TO;RELTYPE=CHILD:y\r\nEND:VTODO\r\n",
  )
  assertEquals(readTodo(sibling)!.relatedTo, [
    { uid: "x", type: "SIBLING" },
    { uid: "y", type: "CHILD" },
  ])
})

Deno.test("readTodo keeps a date-only DUE a date and reports no alarms when there are none", async () => {
  const todo = readTodo(parse(await fixture("stalwart-tasksorg-date-due.ics")))!
  assertEquals(todo.due, { kind: IcalDateKind.Date, date: "2026-10-09" })
  assertEquals("rrule" in todo, false)
  assertEquals(todo.repeats, false)
  assertEquals(readTodo(parse("BEGIN:VTODO\r\nEND:VTODO\r\n"))!.hasAlarms, false)
})

Deno.test("readTodo reads a relative and an absolute reminder trigger with what they relate to", () => {
  const absolute = parse(
    "BEGIN:VTODO\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER;VALUE=DATE-TIME:20261009T080000Z\r\n" +
      "END:VALARM\r\nBEGIN:VALARM\r\nTRIGGER;RELATED=START:-PT15M\r\nEND:VALARM\r\nEND:VTODO\r\n",
  )
  assertEquals(readTodo(absolute)!.alarms, [
    {
      action: "AUDIO",
      trigger: { kind: AlarmTriggerKind.Absolute, at: utc("2026-10-09", "08:00:00") },
    },
    {
      trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT15M", related: AlarmRelated.Start },
    },
  ])
})

Deno.test("readTodo skips a recurrence override and returns undefined without a VTODO", () => {
  const root = parse(
    "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nRECURRENCE-ID:20261001T000000Z\r\nSUMMARY:override\r\n" +
      "END:VTODO\r\nBEGIN:VTODO\r\nSUMMARY:master\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
  )
  assertEquals(readTodo(root)!.summary, "master")
  assertEquals(readTodo(parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")), undefined)
})

Deno.test("patching a task title and priority changes only those lines plus DTSTAMP and LAST-MODIFIED, not SEQUENCE", async () => {
  for (const name of TODO_FIXTURES) {
    const text = await fixture(name)
    const root = parse(text)
    const before = getProperty(root.components.find((c) => c.name === "VTODO")!, "SEQUENCE")
    mustPatch(root, { summary: "Renamed, with; punctuation", priority: 3 })
    const after = serializeIcal(root)
    const names = changedNames(text, after)
    const allowed = new Set(["SUMMARY", "PRIORITY", "DTSTAMP", "LAST-MODIFIED"])
    for (const changed of names) assert(allowed.has(changed), `${name}: ${changed} changed`)
    for (const required of ["SUMMARY", "DTSTAMP", "LAST-MODIFIED"]) {
      assert(names.includes(required), `${name}: ${required} not written`)
    }
    const todo = root.components.find((c) => c.name === "VTODO")!
    assertEquals(getProperty(todo, "SEQUENCE")?.value, before?.value, name)
    assertEquals(getProperty(todo, "DTSTAMP")!.value, NOW_STAMP, name)
    assertEquals(getProperty(todo, "LAST-MODIFIED")!.value, NOW_STAMP, name)
  }
})

Deno.test("a task patch of the start, due, rrule or status raises SEQUENCE by one", () => {
  const patches: Parameters<typeof patchTodo>[1][] = [
    { start: utc("2026-10-10", "08:00:00") },
    { due: utc("2026-10-10", "08:00:00") },
    { rrule: "FREQ=DAILY" },
    { status: TodoStatus.InProcess },
  ]
  for (const patch of patches) {
    const root = parse("BEGIN:VTODO\r\nSEQUENCE:4\r\nSUMMARY:a\r\nEND:VTODO\r\n")
    mustPatch(root, patch)
    assertEquals(getProperty(root, "SEQUENCE")!.value, "5", JSON.stringify(patch))
  }
  const none = parse("BEGIN:VTODO\r\nSUMMARY:a\r\nEND:VTODO\r\n")
  mustPatch(none, { due: null })
  assertEquals(getProperty(none, "SEQUENCE")!.value, "1")
})

Deno.test("a task patch leaves reminders, X- properties, zones and the folded summary byte for byte", async () => {
  const text = await fixture("stalwart-tasksorg-recurring.ics")
  const root = parse(text)
  mustPatch(root, { priority: 9 })
  const out = serializeIcal(root)
  for (
    const kept of [
      "BEGIN:VALARM\r\nTRIGGER;RELATED=END:PT0S\r\nACTION:DISPLAY\r\nDESCRIPTION:Default Tasks.org description\r\nEND:VALARM\r\n",
      "X-MOZ-LASTACK:20260818T190429Z\r\nX-MOZ-SNOOZE-TIME:20260818T191929Z\r\n",
      "X-APPLE-SORT-ORDER:783013311\r\n",
      "DUE;TZID=Asia/Ho_Chi_Minh:20260814T110001\r\n",
      "CREATED:20260622T091845Z\r\n",
      "BEGIN:VTIMEZONE\r\nTZID:Asia/Ho_Chi_Minh\r\n",
      "RRULE:FREQ=DAILY;INTERVAL=1\r\n",
    ]
  ) assert(out.includes(kept), `lost: ${kept}`)
  const folded = logicalLines(text).find((line) => line.startsWith("SUMMARY"))!
  assert(logicalLines(out).includes(folded))
})

Deno.test("a patch never rewrites CREATED", async () => {
  const root = parse(await fixture("stalwart-tasksorg-recurring.ics"))
  mustPatch(root, { status: TodoStatus.Completed, summary: "x" }, true)
  const todo = root.components.find((c) => c.name === "VTODO")!
  assertEquals(getProperties(todo, "CREATED").map((p) => p.value), ["20260622T091845Z"])
})

Deno.test("completing sets STATUS, COMPLETED in UTC and PERCENT-COMPLETE 100 together", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  const todo = mustPatch(root, { status: TodoStatus.Completed })
  assertEquals(todo.status, TodoStatus.Completed)
  assertEquals(todo.completed, utc("2026-10-08", "12:30:45"))
  assertEquals(todo.percentComplete, 100)
  const out = serializeIcal(root)
  assert(out.includes("STATUS:COMPLETED\r\n"))
  assert(out.includes("COMPLETED:20261008T123045Z\r\n"))
  assert(out.includes("PERCENT-COMPLETE:100\r\n"))
})

Deno.test("completing with a given completion time uses it, and a percent below 100 is refused", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  const todo = mustPatch(root, {
    status: TodoStatus.Completed,
    completed: utc("2026-10-07", "09:00:00"),
  })
  assertEquals(todo.completed, utc("2026-10-07", "09:00:00"))
  const other = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  const refused = patchTodo(other, { status: TodoStatus.Completed, percentComplete: 50 }, {
    now: NOW,
  })
  assertEquals(refused.error?.code, IcalErrorCode.InvalidValue)
  const lone = patchTodo(other, { completed: utc("2026-10-07", "09:00:00") }, { now: NOW })
  assertEquals(lone.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("reopening clears COMPLETED and a PERCENT-COMPLETE of 100 and keeps a lower percent", () => {
  const text = "BEGIN:VTODO\r\nUID:1\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261001T000000Z\r\n" +
    "PERCENT-COMPLETE:100\r\nEND:VTODO\r\n"
  const root = parse(text)
  const todo = mustPatch(root, { status: TodoStatus.NeedsAction })
  assertEquals(todo.status, TodoStatus.NeedsAction)
  assertEquals("completed" in todo, false)
  assertEquals("percentComplete" in todo, false)
  const half = parse(
    "BEGIN:VTODO\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261001T000000Z\r\nPERCENT-COMPLETE:100\r\nEND:VTODO\r\n",
  )
  mustPatch(half, { status: TodoStatus.InProcess, percentComplete: 40 })
  assertEquals(readTodo(half)!.percentComplete, 40)
  assertEquals(readTodo(half)!.status, TodoStatus.InProcess)
  assertEquals(getProperty(half, "COMPLETED"), undefined)
})

Deno.test("completing a repeating task is refused unless completeSeries is set", async () => {
  const text = await fixture("stalwart-tasksorg-recurring.ics")
  const root = parse(text)
  const refused = patchTodo(root, { status: TodoStatus.Completed }, { now: NOW })
  assertEquals(refused.error?.code, IcalErrorCode.InvalidValue)
  assertEquals(serializeIcal(root), text)
  const plain = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  assert(patchTodo(plain, { status: TodoStatus.Completed }, { now: NOW }).success)
  const ending = parse(text)
  const ended = patchTodo(ending, { status: TodoStatus.Completed, rrule: null }, { now: NOW })
  assert(ended.success, "a patch that removes the RRULE may complete")
  const created = newTodo({ status: TodoStatus.Completed, rrule: "FREQ=DAILY" }, {
    uid: "u",
    now: NOW,
    prodid: "p",
  })
  assertEquals(created.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("an ended series that resends status Completed can still be saved", async () => {
  const done = parse(
    (await fixture("stalwart-tasksorg-recurring.ics")).replace(
      "STATUS:NEEDS-ACTION\r\n",
      "STATUS:COMPLETED\r\nCOMPLETED:20250101T000000Z\r\n",
    ),
  )
  const todo = () => done.components.find((c) => c.name === "VTODO")!
  const before = getProperty(todo(), "COMPLETED")!.source
  const saved = patchTodo(done, { status: TodoStatus.Completed, summary: "renamed" }, { now: NOW })
  assert(saved.success, saved.error?.message)
  assertEquals(getProperty(todo(), "COMPLETED")!.source, before)
})

Deno.test("a repeating task keeps its RRULE, reports repeats and is not advanced when completed", async () => {
  const text = await fixture("stalwart-tasksorg-recurring.ics")
  const root = parse(text)
  const todo = mustPatch(root, { status: TodoStatus.Completed }, true)
  assertEquals(todo.repeats, true)
  assertEquals(todo.rrule, "FREQ=DAILY;INTERVAL=1")
  assertEquals(todo.due!.date, "2026-08-14")
  assertEquals(
    changedNames(text, serializeIcal(root)),
    [
      "COMPLETED",
      "DTSTAMP",
      "LAST-MODIFIED",
      "PERCENT-COMPLETE",
      "SEQUENCE",
      "STATUS",
    ],
  )
})

Deno.test("null clears a field and a field left out stays", async () => {
  const root = parse(await fixture("stalwart-tasksorg-recurring.ics"))
  const todo = mustPatch(root, { priority: null, categories: null, rrule: null, sortOrder: null })
  for (const key of ["priority", "categories", "rrule", "sortOrder"] as const) {
    assert(!(key in todo) || (key === "categories" && todo.categories.length === 0), key)
  }
  assertEquals(todo.repeats, false)
  assertEquals(todo.due?.tzid, "Asia/Ho_Chi_Minh")
  assertEquals(todo.status, TodoStatus.NeedsAction)
  const out = serializeIcal(root)
  assertEquals(out.includes("X-APPLE-SORT-ORDER"), false)
  assertEquals(out.includes("X-MOZ-LASTACK:"), true)
})

Deno.test("null clears the summary and description lines and nothing else of the text", async () => {
  const text = await fixture("radicale-tasksorg-subtask.ics")
  const root = parse(text)
  const todo = mustPatch(root, { summary: null, description: null })
  assertEquals("summary" in todo, false)
  assertEquals(changedNames(text, serializeIcal(root)), [
    "DTSTAMP",
    "LAST-MODIFIED",
    "SUMMARY",
  ])
  const fresh = parse("BEGIN:VTODO\r\nSUMMARY:a\r\nDESCRIPTION:b\r\nEND:VTODO\r\n")
  assertEquals(mustPatch(fresh, { description: null }).summary, "a")
  assertEquals(getProperty(fresh, "DESCRIPTION"), undefined)
})

Deno.test("X-APPLE-SORT-ORDER is set as a number and replaces the old line in place", async () => {
  const text = await fixture("radicale-tasksorg-subtask.ics")
  const root = parse(text)
  const todo = mustPatch(root, { sortOrder: 5 })
  assertEquals(todo.sortOrder, 5)
  assert(serializeIcal(root).includes("END:VALARM\r\nX-APPLE-SORT-ORDER:5\r\n"))
  const bad = patchTodo(root, { sortOrder: 1.5 }, { now: NOW })
  assertEquals(bad.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("a patch that would make DUE and DTSTART differ in type is refused and changes nothing", async () => {
  const text = await fixture("stalwart-tasksorg-date-due.ics")
  const root = parse(text)
  const withStart = patchTodo(root, { start: { kind: IcalDateKind.Date, date: "2026-10-01" } }, {
    now: NOW,
  })
  assert(withStart.success)
  const mixed = serializeIcal(root)
  const refused = patchTodo(root, {
    summary: "changed first",
    due: utc("2026-10-12", "10:00:00"),
  }, { now: NOW })
  assertEquals(refused.error?.code, IcalErrorCode.ValueTypeMismatch)
  assertEquals(serializeIcal(root), mixed)
})

Deno.test("patching DUE and DTSTART together can switch both from dates to times", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  assert(
    patchTodo(root, { start: { kind: IcalDateKind.Date, date: "2026-10-01" } }, { now: NOW })
      .success,
  )
  const todo = mustPatch(root, {
    start: utc("2026-10-01", "08:00:00"),
    due: utc("2026-10-09", "08:00:00"),
  })
  assertEquals(todo.start, utc("2026-10-01", "08:00:00"))
  assertEquals(todo.due, utc("2026-10-09", "08:00:00"))
})

Deno.test("a refused patch leaves the document byte for byte as it was, even after earlier fields applied", async () => {
  const text = await fixture("stalwart-tasksorg-folded.ics")
  const root = parse(text)
  const refused = patchTodo(root, { summary: "new", priority: 12 }, { now: NOW })
  assertEquals(refused.error?.code, IcalErrorCode.InvalidValue)
  assertEquals(serializeIcal(root), text)
  const zone = patchTodo(root, {
    summary: "new",
    due: { kind: IcalDateKind.Zoned, date: "2026-10-10", time: "10:00:00", tzid: "Europe/Berlin" },
  }, { now: NOW })
  assertEquals(zone.error?.code, IcalErrorCode.UnknownTzid)
  assertEquals(serializeIcal(root), text)
})

Deno.test("a patch with no fields is a no-op that stamps nothing", async () => {
  const text = await fixture("tasksorg-sample.ics")
  const root = parse(text)
  assert(patchTodo(root, {}, { now: NOW }).success)
  assert(patchTodo(root, { summary: undefined }, { now: NOW }).success)
  assertEquals(serializeIcal(root), text)
})

Deno.test("patchTodo refuses a document without a VTODO and an invalid clock", () => {
  const empty = parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
  assertEquals(
    patchTodo(empty, { summary: "x" }, { now: NOW }).error?.code,
    IcalErrorCode.Malformed,
  )
  const todo = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  assertEquals(
    patchTodo(todo, { summary: "x" }, { now: new Date(NaN) }).error?.code,
    IcalErrorCode.InvalidValue,
  )
})

Deno.test("categories are replaced as one line and RELATED-TO keeps the lines that did not change", async () => {
  const text = await fixture("nextcloud-sample.ics")
  const root = parse(text)
  const todo = mustPatch(root, {
    categories: ["a, b", "c"],
    relatedTo: [{ uid: "nc-parent-0001", type: "parent" }, { uid: "other", type: "DEPENDS-ON" }],
  })
  assertEquals(todo.categories, ["a, b", "c"])
  assertEquals(todo.relatedTo, [
    { uid: "nc-parent-0001", type: "PARENT" },
    { uid: "other", type: "DEPENDS-ON" },
  ])
  const out = serializeIcal(root)
  assert(out.includes("RELATED-TO;RELTYPE=PARENT:nc-parent-0001\r\n"))
  assert(out.includes("RELATED-TO;RELTYPE=DEPENDS-ON:other\r\n"))
  assert(out.includes("CATEGORIES:a\\, b,c\r\n"))
  const cleared = mustPatch(root, { relatedTo: null })
  assertEquals(cleared.relatedTo, [])
})

Deno.test("a RELATED-TO without RELTYPE survives a patch that does not name it", async () => {
  const text = await fixture("radicale-tasksorg-subtask.ics")
  const root = parse(text)
  mustPatch(root, { priority: 2 })
  assert(serializeIcal(root).includes("RELATED-TO:9071723460158\r\n"))
  mustPatch(root, { relatedTo: [{ uid: "9071723460158" }] })
  assert(serializeIcal(root).includes("RELATED-TO:9071723460158\r\n"))
})

Deno.test("a zoned date is written when its VTIMEZONE is in the document and keeps its zone", async () => {
  const text = await fixture("stalwart-tasksorg-recurring.ics")
  const root = parse(text)
  const todo = mustPatch(root, {
    due: {
      kind: IcalDateKind.Zoned,
      date: "2026-08-20",
      time: "09:30:00",
      tzid: "Asia/Ho_Chi_Minh",
    },
  })
  assertEquals(todo.due!.tzid, "Asia/Ho_Chi_Minh")
  assert(serializeIcal(root).includes("DUE;TZID=Asia/Ho_Chi_Minh:20260820T093000\r\n"))
})

Deno.test("newTodo builds a document from the caller's uid, clock and PRODID and reads back", () => {
  const made = newTodo({
    summary: "Buy milk",
    due: { kind: IcalDateKind.Date, date: "2026-10-09" },
    priority: 5,
    categories: ["Home"],
    relatedTo: [{ uid: "parent-1" }],
    sortOrder: 42,
    rrule: "FREQ=WEEKLY",
  }, { uid: "uid-1@example.com", now: NOW, prodid: "-//Example//Tasks 1.0//EN" })
  assert(made.success, made.error?.message)
  const text = serializeIcal(made.output)
  assert(text.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Example//Tasks 1.0//EN\r\n"))
  assert(text.includes("UID:uid-1@example.com\r\n"))
  assert(text.includes(`CREATED:${NOW_STAMP}\r\n`))
  assert(text.includes(`DTSTAMP:${NOW_STAMP}\r\n`))
  assert(text.includes("DUE;VALUE=DATE:20261009\r\n"))
  assertEquals(text.includes("SEQUENCE"), false)
  const todo = readTodo(parse(text))!
  assertEquals(todo.summary, "Buy milk")
  assertEquals(todo.sortOrder, 42)
  assertEquals(todo.relatedTo, [{ uid: "parent-1", type: "PARENT" }])
  assertEquals(todo.repeats, true)
  assertEquals(
    serializeIcal(
      newTodo({ summary: "Buy milk" }, {
        uid: "u",
        now: NOW,
        prodid: "p",
      }).output!,
    ),
    serializeIcal(newTodo({ summary: "Buy milk" }, { uid: "u", now: NOW, prodid: "p" }).output!),
  )
})

Deno.test("newTodo can create a completed task, and refuses a bad uid or a zoned date", () => {
  const options = { uid: "u1", now: NOW, prodid: "-//Example//EN" }
  const done = newTodo({ summary: "x", status: TodoStatus.Completed }, options)
  const todo = readTodo(done.output!)!
  assertEquals(todo.completed, utc("2026-10-08", "12:30:45"))
  assertEquals(todo.percentComplete, 100)
  assertEquals(newTodo({}, { ...options, uid: "a\r\nb" }).error?.code, IcalErrorCode.InvalidValue)
  assertEquals(newTodo({}, { ...options, uid: "" }).error?.code, IcalErrorCode.InvalidValue)
  const zoned = newTodo({
    due: { kind: IcalDateKind.Zoned, date: "2026-10-10", time: "10:00:00", tzid: "Europe/Berlin" },
  }, options)
  assertEquals(zoned.error?.code, IcalErrorCode.UnknownTzid)
})

Deno.test("readEvent reads an event with its zone, status and reminder", async () => {
  const event = readEvent(parse(await fixture("stalwart-event-alarm.ics")))!
  assertEquals(event.status, EventStatus.Confirmed)
  assertEquals(event.start, {
    kind: IcalDateKind.Zoned,
    date: "2026-07-10",
    time: "14:00:00",
    tzid: "Asia/Saigon",
  })
  assertEquals(event.end!.time, "16:15:00")
  assertEquals(event.alarms[0]!.trigger, {
    kind: AlarmTriggerKind.Relative,
    duration: "-PT10M",
    related: AlarmRelated.Start,
  })
})

Deno.test("patchEvent bumps SEQUENCE, leaves a recurrence override untouched and keeps the series", async () => {
  const text = await fixture("radicale-event-overrides.ics")
  const root = parse(text)
  const result = patchEvent(root, { summary: "Weekly sync (renamed)", location: "Room 4" }, {
    now: NOW,
  })
  assert(result.success)
  assertEquals(result.output.repeats, true)
  assertEquals(result.output.sequence, 3)
  const out = serializeIcal(root)
  assert(out.includes("SEQUENCE:3\r\nSUMMARY:Weekly sync (renamed)\r\n"))
  assert(out.includes("EXDATE;TZID=Europe/Berlin:20261019T100000\r\n"))
  assertEquals(
    changedNames(text, out),
    [
      "DTSTAMP",
      "DTSTAMP",
      "LAST-MODIFIED",
      "LOCATION",
      "SEQUENCE",
      "SEQUENCE",
      "SUMMARY",
      "SUMMARY",
    ].filter((_, i, all) => all.indexOf(_) === i || _ === "DTSTAMP" && false).sort(),
  )
  const override = out.slice(out.indexOf("RECURRENCE-ID"))
  assert(override.includes("SEQUENCE:3\r\nSUMMARY:Weekly sync (moved)\r\n"))
  assert(override.includes("DTSTAMP:20261001T080000Z\r\n"))
})

Deno.test("patchEvent setting an end replaces DURATION and refuses an end of a different type than the start", () => {
  const root = parse(
    "BEGIN:VEVENT\r\nUID:1\r\nDTSTART;VALUE=DATE:20261009\r\nDURATION:P1D\r\nEND:VEVENT\r\n",
  )
  const refused = patchEvent(root, { end: utc("2026-10-10", "10:00:00") }, { now: NOW })
  assertEquals(refused.error?.code, IcalErrorCode.ValueTypeMismatch)
  const ok = patchEvent(root, { end: { kind: IcalDateKind.Date, date: "2026-10-11" } }, {
    now: NOW,
  })
  assert(ok.success)
  assertEquals(getProperty(root, "DURATION"), undefined)
  assertEquals(ok.output.end, { kind: IcalDateKind.Date, date: "2026-10-11" })
  const back = patchEvent(root, { duration: "P2D" }, { now: NOW })
  assert(back.success)
  assertEquals(getProperty(root, "DTEND"), undefined)
  assertEquals(back.output.duration, "P2D")
  const both = patchEvent(root, { duration: "PT1H", end: utc("2026-10-10", "10:00:00") }, {
    now: NOW,
  })
  assertEquals(both.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("newEvent builds an event that reads back and has no SEQUENCE yet", () => {
  const made = newEvent({
    summary: "Dinner",
    start: utc("2026-10-10", "18:00:00"),
    end: utc("2026-10-10", "20:00:00"),
    status: EventStatus.Tentative,
    location: "Home",
  }, { uid: "e1@example.com", now: NOW, prodid: "-//Example//EN" })
  assert(made.success, made.error?.message)
  const text = serializeIcal(made.output)
  assert(text.includes("STATUS:TENTATIVE\r\n"))
  assertEquals(text.includes("SEQUENCE"), false)
  const event = readEvent(parse(text))!
  assertEquals(event.summary, "Dinner")
  assertEquals(event.location, "Home")
  assertEquals(event.end, utc("2026-10-10", "20:00:00"))
})

Deno.test("time/ical-tasks has no hidden clock or random source", async () => {
  const code = (await Deno.readTextFile(new URL("./ical-tasks.ts", import.meta.url)))
    .replace(/\/\*[\s\S]*?\*\//g, "")
  assertEquals(/Date\.now|new Date\(\)|Math\.random|crypto\./.test(code), false)
})

Deno.test("completing an already completed task keeps its COMPLETED line byte for byte", () => {
  const text = "BEGIN:VTODO\r\nUID:1\r\nSTATUS:COMPLETED\r\nCOMPLETED;X-A=1:20261001T000000Z\r\n" +
    "PERCENT-COMPLETE:100\r\nEND:VTODO\r\n"
  const root = parse(text)
  const todo = mustPatch(root, { status: TodoStatus.Completed, summary: "y" })
  assertEquals(todo.completed, utc("2026-10-01", "00:00:00"))
  assert(serializeIcal(root).includes("COMPLETED;X-A=1:20261001T000000Z\r\n"))
  const later = mustPatch(root, {
    status: TodoStatus.Completed,
    completed: utc("2026-10-05", "01:02:03"),
  })
  assertEquals(later.completed, utc("2026-10-05", "01:02:03"))
})

Deno.test("an existing RELATED-TO line with extra parameters comes back in place, and an empty type means PARENT", () => {
  const text = "BEGIN:VTODO\r\nRELATED-TO;RELTYPE=PARENT;X-FOO=1:p\r\nSUMMARY:a\r\nEND:VTODO\r\n"
  const root = parse(text)
  mustPatch(root, { relatedTo: [{ uid: "p", type: "" }, { uid: "q", type: "child" }] })
  const out = serializeIcal(root)
  assert(out.startsWith("BEGIN:VTODO\r\nRELATED-TO;RELTYPE=PARENT;X-FOO=1:p\r\nSUMMARY:a\r\n"))
  assert(out.includes("RELATED-TO;RELTYPE=CHILD:q\r\n"))
  const fresh = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  mustPatch(fresh, { relatedTo: [{ uid: "z", type: "" }] })
  assert(serializeIcal(fresh).includes("RELATED-TO:z\r\n"))
})

Deno.test("an RRULE outside the RFC 5545 shape is refused", () => {
  for (
    const bad of [
      "FREQ=HOURLYISH",
      "FREQ=DAILY;;COUNT=2",
      "FREQ=DAILY;COUNT",
      "FREQ=DAILY;COUNT=2;COUNT=3",
      "COUNT=2",
      "FREQ=DAILY;",
      "",
    ]
  ) {
    const root = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
    assertEquals(
      patchTodo(root, { rrule: bad }, { now: NOW }).error?.code,
      IcalErrorCode.InvalidValue,
      bad,
    )
    assertEquals(getProperty(root, "RRULE"), undefined)
  }
  const root = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  for (const good of ["FREQ=WEEKLY;BYDAY=MO,WE;COUNT=3", "INTERVAL=2;FREQ=YEARLY", "freq=daily"]) {
    assert(patchTodo(root, { rrule: good }, { now: NOW }).success, good)
  }
})

Deno.test("completed alone is refused, null included, and the document stays as it was", async () => {
  const text = await fixture("tasksorg-sample.ics")
  const root = parse(text)
  for (const completed of [null, utc("2026-10-01", "00:00:00")]) {
    assertEquals(
      patchTodo(root, { completed }, { now: NOW }).error?.code,
      IcalErrorCode.InvalidValue,
    )
  }
  assertEquals(serializeIcal(root), text)
})

Deno.test("a status other than Completed with percentComplete 100 is refused", () => {
  const root = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  const result = patchTodo(root, { status: TodoStatus.NeedsAction, percentComplete: 100 }, {
    now: NOW,
  })
  assertEquals(result.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("changing the percent of a completed task without reopening it is refused", () => {
  const root = parse(
    "BEGIN:VTODO\r\nSTATUS:COMPLETED\r\nCOMPLETED:20261001T000000Z\r\nPERCENT-COMPLETE:100\r\nEND:VTODO\r\n",
  )
  assertEquals(
    patchTodo(root, { percentComplete: 50 }, { now: NOW }).error?.code,
    IcalErrorCode.InvalidValue,
  )
  assertEquals(
    patchTodo(root, { percentComplete: null }, { now: NOW }).error?.code,
    IcalErrorCode.InvalidValue,
  )
  assert(patchTodo(root, { percentComplete: 100 }, { now: NOW }).success)
  const todo = mustPatch(root, { status: TodoStatus.InProcess, percentComplete: 50 })
  assertEquals(todo.percentComplete, 50)
})

Deno.test("status null clears an event's STATUS", () => {
  const root = parse("BEGIN:VEVENT\r\nUID:1\r\nSTATUS:CONFIRMED\r\nEND:VEVENT\r\n")
  const result = patchEvent(root, { status: null }, { now: NOW })
  assert(result.success)
  assertEquals("status" in result.output, false)
  assertEquals(getProperty(root, "STATUS"), undefined)
})

Deno.test("values of the wrong type give a failed result, not a thrown error", () => {
  const text = "BEGIN:VTODO\r\nSUMMARY:a\r\nEND:VTODO\r\n"
  const root = parse(text)
  const bad = [
    { summary: 5 },
    { description: {} },
    { categories: [1] },
    { relatedTo: [null] },
    { relatedTo: [{ uid: 3 }] },
    { relatedTo: "x" },
  ] as unknown as Parameters<typeof patchTodo>[1][]
  for (const patch of bad) {
    assertEquals(patchTodo(root, patch, { now: NOW }).error?.code, IcalErrorCode.InvalidValue)
  }
  const event = patchEvent(
    parse("BEGIN:VEVENT\r\nEND:VEVENT\r\n"),
    {
      location: 4,
    } as unknown as Parameters<typeof patchEvent>[1],
    { now: NOW },
  )
  assertEquals(event.error?.code, IcalErrorCode.InvalidValue)
  assertEquals(serializeIcal(root), text)
})

// ---------------------------------------------------------------------------------------------
// Writing reminders

const TASK_WITH_ALARMS = "BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:t1\r\nSUMMARY:Pay rent\r\n" +
  "X-KEEP:1\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:old\r\n" +
  "X-MOZ-LASTACK:20260101T000000Z\r\nEND:VALARM\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\n" +
  "TRIGGER;RELATED=END:PT0S\r\nEND:VALARM\r\nSTATUS:NEEDS-ACTION\r\nEND:VTODO\r\n" +
  "END:VCALENDAR\r\n"

const HOUR_BEFORE: AlarmInput = {
  action: "DISPLAY",
  trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H" },
}

Deno.test("an alarm written to a task reads back the same and gets the summary as DESCRIPTION", () => {
  const root = parse("BEGIN:VTODO\r\nSUMMARY:Pay rent\r\nEND:VTODO\r\n")
  const todo = mustPatch(root, { alarms: [HOUR_BEFORE] })
  assertEquals(todo.alarms, [{
    action: "DISPLAY",
    trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H", related: AlarmRelated.Start },
  }])
  assert(
    serializeIcal(root).includes(
      "BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT1H\r\nDESCRIPTION:Pay rent\r\nEND:VALARM\r\n",
    ),
  )
})

Deno.test("an alarm written to an event reads back the same, with RELATED=END and a plain default text", () => {
  const root = parse("BEGIN:VEVENT\r\nDTSTART:20261010T100000Z\r\nEND:VEVENT\r\n")
  const result = patchEvent(root, {
    alarms: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: "PT5M", related: AlarmRelated.End },
    }],
  }, { now: NOW })
  assert(result.success)
  assertEquals(result.output.alarms, [{
    action: "DISPLAY",
    trigger: { kind: AlarmTriggerKind.Relative, duration: "PT5M", related: AlarmRelated.End },
  }])
  const out = serializeIcal(root)
  assert(out.includes("TRIGGER;RELATED=END:PT5M\r\nDESCRIPTION:Reminder\r\n"))
})

Deno.test("an absolute alarm is written as a UTC DATE-TIME and read back as one", () => {
  const root = parse("BEGIN:VTODO\r\nSUMMARY:a\r\nEND:VTODO\r\n")
  const at = utc("2026-10-09", "08:00:00")
  const todo = mustPatch(root, { alarms: [{ trigger: { kind: AlarmTriggerKind.Absolute, at } }] })
  assertEquals(todo.alarms[0]!.trigger, { kind: AlarmTriggerKind.Absolute, at })
  assert(serializeIcal(root).includes("TRIGGER;VALUE=DATE-TIME:20261009T080000Z\r\n"))
})

Deno.test("alarms: null removes every VALARM and nothing else of the task", () => {
  const root = parse(TASK_WITH_ALARMS)
  const todo = mustPatch(root, { alarms: null })
  assertEquals(todo.alarms, [])
  assertEquals(todo.hasAlarms, false)
  const out = serializeIcal(root)
  assertEquals(out.includes("VALARM"), false)
  assertEquals(changedNames(TASK_WITH_ALARMS, out), [
    "ACTION",
    "BEGIN",
    "DESCRIPTION",
    "DTSTAMP",
    "END",
    "LAST-MODIFIED",
    "TRIGGER",
    "X-MOZ-LASTACK",
  ])
  assert(out.includes("X-KEEP:1\r\n") && out.includes("STATUS:NEEDS-ACTION\r\n"))
})

Deno.test("alarms: null on an event removes every VALARM and keeps the rest", async () => {
  const text = await fixture("stalwart-event-alarm.ics")
  const root = parse(text)
  const result = patchEvent(root, { alarms: null }, { now: NOW })
  assert(result.success)
  assertEquals(result.output.alarms, [])
  const out = serializeIcal(root)
  assertEquals(out.includes("VALARM"), false)
  assert(out.includes("LOCATION") === text.includes("LOCATION"))
})

Deno.test("a patch without alarms leaves existing VALARM blocks byte for byte, on a task and an event", async () => {
  const block = (text: string) =>
    text.slice(text.indexOf("BEGIN:VALARM"), text.lastIndexOf("END:VALARM"))
  const task = parse(TASK_WITH_ALARMS)
  mustPatch(task, { summary: "Renamed", due: utc("2026-10-10", "08:00:00") })
  assertEquals(block(serializeIcal(task)), block(TASK_WITH_ALARMS))
  const text = await fixture("stalwart-event-alarm.ics").then((t) => t.replaceAll("\r\n", "\n"))
  const event = parse(text)
  assert(patchEvent(event, { summary: "Renamed", location: "Room" }, { now: NOW }).success)
  assertEquals(block(serializeIcal(event)), block(text.replaceAll("\n", "\r\n")))
})

Deno.test("replacing alarms keeps an existing VALARM with the same action and trigger, with its X- lines", () => {
  const root = parse(TASK_WITH_ALARMS)
  const todo = mustPatch(root, {
    alarms: [
      { trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT15M" } },
      HOUR_BEFORE,
    ],
  })
  assertEquals(todo.alarms.map((a) => a.action), ["DISPLAY", "DISPLAY"])
  const out = serializeIcal(root)
  assert(out.includes("DESCRIPTION:old\r\nX-MOZ-LASTACK:20260101T000000Z\r\nEND:VALARM\r\n"))
  assertEquals(out.includes("ACTION:AUDIO"), false)
  assertEquals((out.match(/BEGIN:VALARM/g) ?? []).length, 2)
  assert(out.includes("TRIGGER:-PT1H\r\nDESCRIPTION:Pay rent\r\n"))
})

Deno.test("replacing alarms writes a new VALARM when the description differs from the kept one", () => {
  const root = parse(TASK_WITH_ALARMS)
  mustPatch(root, {
    alarms: [{
      trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT15M" },
      description: "new text",
    }],
  })
  const out = serializeIcal(root)
  assertEquals(out.includes("X-MOZ-LASTACK"), false)
  assert(out.includes("DESCRIPTION:new text\r\n"))
})

Deno.test("an alarm patch alone stamps DTSTAMP and LAST-MODIFIED but does not raise SEQUENCE", () => {
  const root = parse("BEGIN:VTODO\r\nSEQUENCE:2\r\nSUMMARY:a\r\nEND:VTODO\r\n")
  mustPatch(root, { alarms: [HOUR_BEFORE] })
  assertEquals(getProperty(root, "SEQUENCE")!.value, "2")
  assertEquals(getProperty(root, "DTSTAMP")!.value, NOW_STAMP)
})

Deno.test("a long alarm description is folded to 75 octets and reads back whole", () => {
  const long = "Ünïcode reminder, with; punctuation — ".repeat(8).trim()
  const root = parse("BEGIN:VTODO\r\nSUMMARY:a\r\nEND:VTODO\r\n")
  mustPatch(root, { alarms: [{ ...HOUR_BEFORE, description: long }] })
  const out = serializeIcal(root)
  const encoder = new TextEncoder()
  for (const line of out.split("\r\n")) assert(encoder.encode(line).length <= 75, line)
  assert(out.includes("\r\n "))
  const back = parse(out)
  const alarm = back.components[0]!
  const description = getProperty(alarm, "DESCRIPTION")!
  assertEquals(
    description.value.replaceAll("\\,", ",").replaceAll("\\;", ";"),
    long,
  )
})

Deno.test("bad alarms are refused with InvalidValue and leave the document as it was", () => {
  const abs = { kind: AlarmTriggerKind.Absolute } as const
  const bad = [
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "1H" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "-P" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "PT" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "-pt1h" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "PT1H\r\nX:y" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H", related: 9 } },
    { trigger: { ...abs, at: { kind: IcalDateKind.Date, date: "2026-10-09" } } },
    {
      trigger: {
        ...abs,
        at: { kind: IcalDateKind.Floating, date: "2026-10-09", time: "08:00:00" },
      },
    },
    { trigger: { ...abs, at: utc("2026-13-09", "08:00:00") } },
    { action: "EMAIL", trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H" } },
    { trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT1H" }, description: 5 },
    { trigger: { kind: 7 } },
    {},
    null,
  ]
  for (const alarm of bad) {
    const root = parse(TASK_WITH_ALARMS)
    const result = patchTodo(
      root,
      { alarms: [alarm] } as unknown as Parameters<typeof patchTodo>[1],
      {
        now: NOW,
      },
    )
    assertEquals(result.error?.code, IcalErrorCode.InvalidValue, JSON.stringify(alarm))
    assertEquals(serializeIcal(root), TASK_WITH_ALARMS)
  }
  const notList = patchTodo(parse(TASK_WITH_ALARMS), { alarms: "x" } as never, { now: NOW })
  assertEquals(notList.error?.code, IcalErrorCode.InvalidValue)
})

Deno.test("valid durations in weeks, days, and mixed forms are accepted", () => {
  for (const duration of ["P1W", "-P2D", "P1DT2H30M10S", "PT30S", "+PT5M", "-PT1H30M", "PT0S"]) {
    const root = parse("BEGIN:VTODO\r\nSUMMARY:a\r\nEND:VTODO\r\n")
    const result = patchTodo(root, {
      alarms: [{ trigger: { kind: AlarmTriggerKind.Relative, duration } }],
    }, { now: NOW })
    assert(result.success, duration)
  }
})

Deno.test("newTodo and newEvent write alarms and a new object reads them back", () => {
  const options = { now: NOW, uid: "u1", prodid: "-//Test//EN" }
  const todo = newTodo({ summary: "Call", alarms: [HOUR_BEFORE] }, options)
  assert(todo.success)
  assertEquals(readTodo(todo.output)!.alarms.length, 1)
  assert(serializeIcal(todo.output).includes("DESCRIPTION:Call\r\n"))
  const event = newEvent({ start: utc("2026-10-10", "18:00:00"), alarms: [HOUR_BEFORE] }, options)
  assert(event.success)
  assertEquals(readEvent(event.output)!.alarms.length, 1)
  assert(serializeIcal(event.output).includes("DESCRIPTION:Reminder\r\n"))
  const none = newTodo({ summary: "x", alarms: null }, options)
  assert(none.success)
  assertEquals(serializeIcal(none.output).includes("VALARM"), false)
})

Deno.test("an existing reminder with the same trigger but another action is replaced, not kept", () => {
  const root = parse(
    "BEGIN:VTODO\r\nSUMMARY:a\r\nBEGIN:VALARM\r\nACTION:AUDIO\r\nTRIGGER:-PT15M\r\n" +
      "X-MOZ-LASTACK:20260101T000000Z\r\nEND:VALARM\r\nEND:VTODO\r\n",
  )
  const todo = mustPatch(root, {
    alarms: [{ trigger: { kind: AlarmTriggerKind.Relative, duration: "-PT15M" } }],
  })
  assertEquals(todo.alarms.map((alarm) => alarm.action), ["DISPLAY"])
  assertEquals(serializeIcal(root).includes("X-MOZ-LASTACK"), false)
})
