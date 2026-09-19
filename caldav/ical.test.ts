// Behaviour tests for the RFC 5545 builder and parser.
//
// The evidence discipline here matters more than the count: a test that builds a
// document and parses it back with the same code passes even when both sides are
// symmetrically wrong, so wherever a value's meaning is at stake the expectation
// is a hand-written literal — either a fixture string that the parser must read,
// or a literal document the writer must produce.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { FOLD_LIMIT, unfoldLines } from "@ts-libs/time/ics-core"
import {
  buildEventIcal,
  buildTodoIcal,
  CalDavDateValue,
  DEFAULT_PRODID,
  dueLine,
  findPropertySeparator,
  fromCalDavDateValue,
  parseEvents,
  parseIcal,
  parsePropertyPrefix,
  parseTodos,
  readRelatedTo,
  resourceUrl,
  splitEscapedList,
  toCalDavDate,
  toCalDavDateValue,
  unfoldDocument,
} from "./ical.ts"
import { ComponentType, RelatedType, TodoStatus } from "./types.ts"
import { FIXED_NOW } from "./test-doubles.ts"
import { octets } from "./test-doubles.ts"

const OPTIONS = { uid: "task-1@example.com", dtstamp: FIXED_NOW }
const CALENDAR_URL = "https://caldav.example.com/user/calendars/tasks/"

/**
 * A VTODO document written by hand, not by this package's builder.
 *
 * Everything the parser is expected to understand appears here exactly as a
 * server would send it: a folded multi-byte SUMMARY, escaped TEXT, a
 * `VALUE=DATE` DUE, an unknown property, a duplicate RELATED-TO, and a
 * `STATUS` the RFC does not define.
 */
const FIXTURE_VTODO = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Example Corp//CalDAV Client//EN",
  "BEGIN:VTODO",
  "UID:fixture-1@example.com",
  "DTSTAMP:20260601T000000Z",
  "SUMMARY:Bake a cake with a very long name that needs folding across lines ✓ and more text",
  "DESCRIPTION:Line one\\nLine two\\; with a semicolon\\, and a comma",
  "CATEGORIES:home\\,baking,food",
  "STATUS:X-CUSTOM",
  "PRIORITY:3",
  "DUE;VALUE=DATE:20260704",
  "PERCENT-COMPLETE:40",
  "X-APPLE-SORT-ORDER:12",
  "RELATED-TO;RELTYPE=PARENT:parent-1@example.com",
  "RELATED-TO;RELTYPE=CHILD:parent-1@example.com",
  "RELATED-TO:parent-2@example.com",
  "RELATED-TO;RELTYPE=SIBLING:",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n")

/** The same fixture with its long SUMMARY physically folded, as a server sends it. */
const FIXTURE_VTODO_FOLDED = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VTODO",
  "UID:fixture-2@example.com",
  "SUMMARY:Bake a cake with a very long name that needs folding across lines ✓ and more tex",
  " t",
  "DUE;VALUE=DATE-TIME:20260704T090000Z",
  "END:VTODO",
  "END:VCALENDAR",
].join("\r\n")

Deno.test("parseIcal reads a folded multi-byte SUMMARY the writer's folding produced", () => {
  // Fold on the writer side, unfold on the reader side, and compare against the
  // literal summary: a pair of inverses that disagree about octets versus
  // characters passes a naive round trip and fails this.
  const summary = `Réunion avec l'équipe — notes ✓ ${"x".repeat(120)}`
  const document = buildTodoIcal({ summary }, OPTIONS)
  const physical = unfoldDocument(document).replaceAll("\r\n", "\n").split("\n")
  const summaryLine = physical.find((line) => line.startsWith("SUMMARY:"))!
  assertEquals(summaryLine, `SUMMARY:${summary}`)

  const parsed = parseTodos(document, { calendarUrl: CALENDAR_URL })
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.summary, summary)
})

Deno.test("buildTodoIcal folds every physical line to at most 75 octets", () => {
  const document = buildTodoIcal(
    { summary: "✓".repeat(90), description: "é".repeat(120) },
    OPTIONS,
  )
  for (const line of document.split("\r\n")) {
    if (line === "") continue
    assertEquals(octets(line) <= FOLD_LIMIT, true, `line exceeds ${FOLD_LIMIT} octets: ${line}`)
  }
})

Deno.test("unfolding the writer's output through time/ics-core recovers the literal line", () => {
  const description = "a".repeat(100) + "é".repeat(20) + "b".repeat(60)
  const document = buildTodoIcal({ summary: "x", description }, OPTIONS)

  // The shared core is the arbiter: foldLine here, unfoldLines there.
  const unfolded = unfoldLines(document)
  assertStringIncludes(unfolded, `DESCRIPTION:${description}`)
  assertEquals(unfolded.includes("\r\n "), false, "no continuation line survives unfolding")
})

Deno.test("a byte-sliced fold of the same value would corrupt it", () => {
  // Pins *why* the shared core is required rather than merely preferred: the
  // source's character-based slice at 75 corrupts a multi-byte value once its
  // UTF-8 length crosses the boundary, and this asserts the shared writer does
  // not do that.
  const value = "é".repeat(60)
  const document = buildTodoIcal({ summary: value }, OPTIONS)
  const unfolded = unfoldLines(document)
  assertStringIncludes(unfolded, `SUMMARY:${value}`)
  assertEquals(new TextDecoder().decode(new TextEncoder().encode(unfolded)).includes(value), true)
})

Deno.test("parseIcal unfolds before it unescapes, so an escaped newline survives folding", () => {
  // A folded value whose next chunk starts after an escaped newline: unescaping
  // first would turn the `\n` into a real line break, split the property, and the
  // continuation half would be dropped.
  const description = `${"z".repeat(70)}\\nSECOND LINE`
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:u1",
    `DESCRIPTION:${description}`,
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseTodos(document)
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.description, `${"z".repeat(70)}\nSECOND LINE`)
})

Deno.test("parseTodos reads every property of a hand-written fixture", () => {
  const parsed = parseTodos(FIXTURE_VTODO, {
    calendarName: "Tasks",
    calendarUrl: CALENDAR_URL,
    etags: new Map([["fixture-1@example.com", '"etag-1"']]),
  })
  assert(parsed.success)
  assertEquals(parsed.output.todos.length, 1)
  const todo = parsed.output.todos[0]!
  assertEquals(todo.uid, "fixture-1@example.com")
  assertEquals(todo.summary.startsWith("Bake a cake with a very long name"), true)
  assertEquals(todo.description, "Line one\nLine two; with a semicolon, and a comma")
  assertEquals(todo.categories, ["home,baking", "food"])
  assertEquals(todo.priority, 3)
  assertEquals(todo.due, "2026-07-04")
  assertEquals(todo.percentComplete, 40)
  assertEquals(todo.statusLabel, "X-CUSTOM")
  assertEquals(todo.status, TodoStatus.NEEDS_ACTION)
  assertEquals(todo.etag, '"etag-1"')
  assertEquals(todo.calendarName, "Tasks")
  assertEquals(todo.url, `${CALENDAR_URL}fixture-1%40example.com.ics`)
})

Deno.test("parseTodos keeps the wire STATUS instead of reporting an unknown one as open", () => {
  const parsed = parseTodos(FIXTURE_VTODO)
  assert(parsed.success)
  // The enum falls back so the type stays total, but the label is authoritative:
  // a caller reading `statusLabel` is told exactly what the server said.
  assertEquals(parsed.output.todos[0]!.statusLabel, "X-CUSTOM")
  assertEquals(parsed.output.todos[0]!.status, TodoStatus.NEEDS_ACTION)
})

Deno.test("parseTodos deduplicates RELATED-TO by UID and keeps the first RELTYPE", () => {
  const parsed = parseTodos(FIXTURE_VTODO)
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.relatedTo, [
    { uid: "parent-1@example.com", reltype: RelatedType.PARENT },
    { uid: "parent-2@example.com", reltype: RelatedType.PARENT },
  ])
})

Deno.test("readRelatedTo defaults a missing RELTYPE to PARENT and drops an empty UID", () => {
  const parsed = parseIcal(FIXTURE_VTODO)
  assert(parsed.success)
  const properties = parsed.output.components[0]!.properties
  const relations = readRelatedTo(properties)
  assertEquals(relations.length, 2)
  assertEquals(relations[1], { uid: "parent-2@example.com", reltype: RelatedType.PARENT })
})

Deno.test("readRelatedTo reads edges past a repeated property the data map overwrote", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:x",
    "RELATED-TO;RELTYPE=PARENT:a",
    "RELATED-TO;RELTYPE=CHILD:b",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseIcal(document)
  assert(parsed.success)
  assertEquals(parsed.output.components[0]!.data["RELATED-TO"], "a")
  assertEquals(readRelatedTo(parsed.output.components[0]!.properties), [
    { uid: "a", reltype: RelatedType.PARENT },
    { uid: "b", reltype: RelatedType.CHILD },
  ])
})

Deno.test("parseTodos reports a present but unreadable DUE as an issue, not as absent", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:x",
    "SUMMARY:t",
    "DUE:not-a-date",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseTodos(document)
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.due, undefined)
  assertEquals(parsed.output.issues.length, 1)
  assertEquals(parsed.output.issues[0]!.property, "DUE")
  assertEquals(parsed.output.issues[0]!.value, "not-a-date")
})

Deno.test("parseTodos ignores an unknown property instead of failing", () => {
  const parsed = parseTodos(FIXTURE_VTODO)
  assert(parsed.success)
  assertEquals(parsed.output.issues.length, 0)
  const components = parseIcal(FIXTURE_VTODO)
  assert(components.success)
  const properties = components.output.components[0]!.properties
  assertEquals(properties.some((entry) => entry.name === "X-APPLE-SORT-ORDER"), true)
})

Deno.test("parseTodos leaves a VMETA-only document as a success with no tasks", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:only an event",
    "DTSTART:20260704T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseTodos(document)
  assert(parsed.success)
  assertEquals(parsed.output.todos, [])
})

Deno.test("parseIcal reads a text/calendar body carrying two components", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTODO",
    "UID:t1",
    "SUMMARY:Task one",
    "STATUS:COMPLETED",
    "END:VTODO",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Event one",
    "DTSTART:20260704T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseIcal(document)
  assert(parsed.success)
  assertEquals(parsed.output.components.map((component) => component.component), [
    ComponentType.VTODO,
    ComponentType.VEVENT,
  ])
})

Deno.test("parseIcal fails on an unclosed component", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:t1",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseIcal(document)
  assert(!parsed.success)
  assertEquals(parsed.error.code, 6)
  assertStringIncludes(parsed.error.message, "unclosed")
})

Deno.test("parseIcal fails on a missing END for the document", () => {
  const document = ["BEGIN:VCALENDAR", "BEGIN:VTODO", "UID:t1", "END:VTODO"].join("\r\n")
  const parsed = parseIcal(document)
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "VCALENDAR is never closed")
})

Deno.test("parseIcal fails on garbage instead of throwing out of the parser", () => {
  const parsed = parseIcal("this is not a calendar at all\nnor is this")
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "no property separator")
})

Deno.test("parseIcal fails on an empty document", () => {
  const parsed = parseIcal("   \r\n ")
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "empty")
})

Deno.test("parseIcal fails on an END with no BEGIN", () => {
  const parsed = parseIcal(["BEGIN:VCALENDAR", "END:VTODO", "END:VCALENDAR"].join("\r\n"))
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "no matching BEGIN")
})

Deno.test("parseIcal warns about a content line with no separator", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:t1",
    "garbage-without-a-colon",
    "SUMMARY:kept",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseIcal(document)
  assert(parsed.success)
  assertEquals(parsed.output.components[0]!.data["SUMMARY"], "kept")
  assertEquals(parsed.output.warnings.length, 1)
  assertStringIncludes(parsed.output.warnings[0]!, "no property separator")
})

Deno.test("buildTodoIcal emits DTSTAMP as a valid UTC DATE-TIME", () => {
  const document = buildTodoIcal({ summary: "t" }, { uid: "u", dtstamp: FIXED_NOW })
  // The source's `toISOString().replace(/[-:]/g, "")` produced
  // `20260701T120000.000Z`: the fractional-seconds field is not part of a
  // DATE-TIME value, so the literal is the pin.
  assertStringIncludes(document, "DTSTAMP:20260701T120000Z")
  assertEquals(document.includes(".000"), false)
})

Deno.test("buildTodoIcal emits a whole-day DUE as VALUE=DATE", () => {
  const document = buildTodoIcal({ summary: "t", due: "2026-07-04" }, OPTIONS)
  assertStringIncludes(document, "DUE;VALUE=DATE:20260704")
  assertEquals(document.includes("DUE;VALUE=DATE-TIME"), false)
})

Deno.test("buildTodoIcal emits an instant DUE without a VALUE parameter", () => {
  const document = buildTodoIcal({ summary: "t", due: "2026-07-04T09:30:00Z" }, OPTIONS)
  assertStringIncludes(document, "DUE:20260704T093000Z")
})

Deno.test("toCalDavDateValue keeps DATE and DATE-TIME distinct", () => {
  assertEquals(toCalDavDateValue("2026-07-04"), {
    value: "20260704",
    parameter: CalDavDateValue.DATE,
  })
  assertEquals(toCalDavDateValue("2026-07-04T09:30:00Z"), {
    value: "20260704T093000Z",
    parameter: CalDavDateValue.DATE_TIME,
  })
})

Deno.test("toCalDavDateValue rejects a date that does not exist", () => {
  assertThrows(() => toCalDavDateValue("2026-02-30"), TypeError)
  assertThrows(() => toCalDavDateValue("not a date"), TypeError)
})

Deno.test("fromCalDavDateValue keeps a DATE a whole day and a floating time unsuffixed", () => {
  assertEquals(fromCalDavDateValue("20260704", "DATE"), {
    iso: "2026-07-04",
    value: CalDavDateValue.DATE,
  })
  assertEquals(fromCalDavDateValue("20260704", undefined), {
    iso: "2026-07-04",
    value: CalDavDateValue.DATE,
  })
  assertEquals(fromCalDavDateValue("20260704T093000", undefined), {
    iso: "2026-07-04T09:30:00",
    value: CalDavDateValue.DATE_TIME,
  })
  assertEquals(fromCalDavDateValue("20260704T093000Z", undefined), {
    iso: "2026-07-04T09:30:00Z",
    value: CalDavDateValue.DATE_TIME,
  })
})

Deno.test("fromCalDavDateValue returns undefined for an empty or impossible value", () => {
  assertEquals(fromCalDavDateValue("", undefined), undefined)
  assertEquals(fromCalDavDateValue("20260230", "DATE"), undefined)
  assertEquals(fromCalDavDateValue("20260704T250000Z", undefined), undefined)
  assertEquals(fromCalDavDateValue("tomorrow", undefined), undefined)
})

Deno.test("dueLine marks a whole-day date and toCalDavDate promotes it to midnight UTC", () => {
  assertEquals(dueLine("2026-07-04"), "DUE;VALUE=DATE:20260704")
  assertEquals(toCalDavDate("2026-07-04"), "20260704T000000Z")
})

Deno.test("buildTodoIcal rejects an empty required SUMMARY", () => {
  assertThrows(() => buildTodoIcal({ summary: "   " }, OPTIONS), TypeError)
})

Deno.test("buildTodoIcal omits PRIORITY outside the RFC 1-9 range", () => {
  assertEquals(buildTodoIcal({ summary: "t", priority: 0 }, OPTIONS).includes("PRIORITY"), false)
  assertEquals(buildTodoIcal({ summary: "t", priority: 10 }, OPTIONS).includes("PRIORITY"), false)
  assertStringIncludes(buildTodoIcal({ summary: "t", priority: 9 }, OPTIONS), "PRIORITY:9")
})

Deno.test("buildTodoIcal clamps PERCENT-COMPLETE into 0-100", () => {
  assertStringIncludes(
    buildTodoIcal({ summary: "t", percentComplete: 150 }, OPTIONS),
    "PERCENT-COMPLETE:100",
  )
  assertStringIncludes(
    buildTodoIcal({ summary: "t", percentComplete: -4 }, OPTIONS),
    "PERCENT-COMPLETE:0",
  )
})

Deno.test("splitEscapedList splits on unescaped commas only", () => {
  assertEquals(splitEscapedList("home\\,baking,food"), ["home\\,baking", "food"])
  assertEquals(splitEscapedList("a,b,c"), ["a", "b", "c"])
  assertEquals(splitEscapedList(""), [])
})

Deno.test("findPropertySeparator skips an escaped colon inside the value", () => {
  assertEquals(findPropertySeparator("URL:https\\://example.com/a"), 3)
  assertEquals(findPropertySeparator("SUMMARY:a\\:b:c"), 7)
  assertEquals(findPropertySeparator("no-separator-here"), -1)
})

Deno.test("parsePropertyPrefix keeps parameters and unquotes a quoted value", () => {
  assertEquals(parsePropertyPrefix("DUE;VALUE=DATE"), { name: "DUE", params: { VALUE: "DATE" } })
  assertEquals(parsePropertyPrefix('ATTENDEE;CN="Doe; John";ROLE=CHAIR'), {
    name: "ATTENDEE",
    params: { CN: "Doe; John", ROLE: "CHAIR" },
  })
})

Deno.test("parseIcal reads a value whose own colon is escaped without truncating it", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:s",
    "URL:https\\://example.com/a",
    "DTSTART:20260704T090000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseIcal(document)
  assert(parsed.success)
  assertEquals(parsed.output.components[0]!.data["URL"], "https://example.com/a")
})

Deno.test("parseEvents reads DTSTART, DTEND and falls back to DTSTART when DTEND is absent", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Standup",
    "DTSTART;VALUE=DATE-TIME:20260704T090000Z",
    "DTEND:20260704T093000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:e2",
    "SUMMARY:All day",
    "DTSTART;VALUE=DATE:20260704",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseEvents(document, { calendarName: "Work", calendarUrl: CALENDAR_URL })
  assert(parsed.success)
  assertEquals(parsed.output.events.length, 2)
  assertEquals(parsed.output.events[0]!.start, "2026-07-04T09:00:00Z")
  assertEquals(parsed.output.events[0]!.end, "2026-07-04T09:30:00Z")
  assertEquals(parsed.output.events[1]!.start, "2026-07-04")
  assertEquals(parsed.output.events[1]!.end, "2026-07-04")
})

Deno.test("buildEventIcal round-trips through parseEvents against literal values", () => {
  const document = buildEventIcal({
    summary: "Design review",
    start: "2026-07-04T09:00:00Z",
    end: "2026-07-04T10:00:00Z",
    location: "Room 1",
    description: "a, b; c",
    status: "TENTATIVE",
  }, OPTIONS)
  assertStringIncludes(document, `PRODID:${DEFAULT_PRODID}`)

  const parsed = parseEvents(document)
  assert(parsed.success)
  const event = parsed.output.events[0]!
  assertEquals(event.summary, "Design review")
  assertEquals(event.start, "2026-07-04T09:00:00Z")
  assertEquals(event.end, "2026-07-04T10:00:00Z")
  assertEquals(event.location, "Room 1")
  assertEquals(event.description, "a, b; c")
  assertEquals(event.status, "TENTATIVE")
  assertEquals(event.uid, "task-1@example.com")
})

Deno.test("buildEventIcal rejects an end before the start", () => {
  assertThrows(
    () =>
      buildEventIcal({
        summary: "x",
        start: "2026-07-04T10:00:00Z",
        end: "2026-07-04T09:00:00Z",
      }, OPTIONS),
    RangeError,
  )
})

Deno.test("resourceUrl percent-encodes the UID and normalises the base URL", () => {
  assertEquals(
    resourceUrl("https://caldav.example.com/user/calendars/tasks", "a/b?c"),
    "https://caldav.example.com/user/calendars/tasks/a%2Fb%3Fc.ics",
  )
  assertEquals(
    resourceUrl(CALENDAR_URL, "u1"),
    "https://caldav.example.com/user/calendars/tasks/u1.ics",
  )
})

Deno.test("resourceUrl prefers an absolute URL the component declares", () => {
  assertEquals(
    resourceUrl(CALENDAR_URL, "u1", "https://elsewhere.example.com/u1.ics"),
    "https://elsewhere.example.com/u1.ics",
  )
  assertEquals(
    resourceUrl(CALENDAR_URL, "u1", "/dav/u1.ics"),
    "/dav/u1.ics",
  )
})

Deno.test("parseTodos reads a resource URL the component declares", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:u1",
    "SUMMARY:s",
    "URL:https://caldav.example.com/other/u1.ics",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  const parsed = parseTodos(document, { calendarUrl: CALENDAR_URL })
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.url, "https://caldav.example.com/other/u1.ics")
})

Deno.test("parseTodos reads a folded fixture written by hand", () => {
  const parsed = parseTodos(FIXTURE_VTODO_FOLDED)
  assert(parsed.success)
  assertEquals(
    parsed.output.todos[0]!.summary,
    "Bake a cake with a very long name that needs folding across lines ✓ and more text",
  )
  assertEquals(parsed.output.todos[0]!.due, "2026-07-04T09:00:00Z")
})

Deno.test("a category containing a comma survives the writer and the parser", () => {
  const categories = ["home, baking", "food"]
  const document = buildTodoIcal({ summary: "t", categories }, OPTIONS)
  assertStringIncludes(document, "CATEGORIES:home\\, baking,food")
  const parsed = parseTodos(document)
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.categories, categories)
})

Deno.test("buildTodoIcal writes RELATED-TO edges the parser reads back as edges", () => {
  const document = buildTodoIcal({
    summary: "child",
    relatedTo: [
      { uid: "parent@example.com", reltype: RelatedType.PARENT },
      { uid: "sibling@example.com", reltype: RelatedType.SIBLING },
    ],
  }, OPTIONS)
  assertStringIncludes(document, "RELATED-TO;RELTYPE=PARENT:parent@example.com")
  assertStringIncludes(document, "RELATED-TO;RELTYPE=SIBLING:sibling@example.com")
  const parsed = parseTodos(document)
  assert(parsed.success)
  assertEquals(parsed.output.todos[0]!.relatedTo, [
    { uid: "parent@example.com", reltype: RelatedType.PARENT },
    { uid: "sibling@example.com", reltype: RelatedType.SIBLING },
  ])
})
