// Behaviour tests for the lossless iCalendar model. Fixtures under `testdata/ical/` are recorded
// from Stalwart 0.16 and Radicale 3.5 (text anonymised, octet lengths kept) or hand-written in
// the shape Tasks.org, Thunderbird, Apple Calendar, Nextcloud and Outlook produce. Deterministic:
// a fixed-seed generator, explicit zones, no host clock.

import { assert, assertEquals, assertExists, assertThrows } from "@std/assert"
import {
  getParameter,
  getProperties,
  getProperty,
  IcalComponent,
  IcalDateKind,
  IcalErrorCode,
  IcalProperty,
  parseIcal,
  readDate,
  readList,
  readText,
  removeProperty,
  resolveInstant,
  serializeIcal,
  setProperty,
  writeDate,
  writeList,
  writeText,
} from "./ical.ts"
import { foldLine, icsEscape, icsEscapeParameter } from "./ics-core.ts"

const FIXTURES = new URL("./testdata/ical/", import.meta.url)
const utf8 = new TextEncoder()

/** Every fixture by file name. Fails loudly when the folder is missing or incomplete. */
async function fixtures(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for await (const entry of Deno.readDir(FIXTURES)) {
    if (entry.name.endsWith(".ics")) {
      out.set(entry.name, await Deno.readTextFile(new URL(entry.name, FIXTURES)))
    }
  }
  assertEquals(out.size, 11, "expected 11 recorded and hand-written fixtures")
  return out
}

async function fixture(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(name, FIXTURES))
}

function parse(text: string): IcalComponent {
  const result = parseIcal(text)
  if (!result.success) throw new Error(`parse failed: ${result.error.message}`)
  return result.output
}

function child(root: IcalComponent, name: string, index = 0): IcalComponent {
  const found = root.components.filter((component) => component.name === name)[index]
  assertExists(found, `no ${name} #${index}`)
  return found
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

/** Every property in the tree, depth first. */
function allProperties(component: IcalComponent): IcalProperty[] {
  return [...component.properties, ...component.components.flatMap(allProperties)]
}

Deno.test("fixtures keep their recorded CRLF line breaks", async () => {
  for (const [name, text] of await fixtures()) {
    assert(text.endsWith("\r\n"), `${name} does not end with CRLF`)
    assertEquals(text.replaceAll("\r\n", "").includes("\n"), false, `${name} has a bare LF`)
  }
})

Deno.test("serializeIcal writes untouched recorded and sample input back byte for byte", async () => {
  for (const [name, text] of await fixtures()) {
    assertEquals(serializeIcal(parse(text)), text, name)
  }
})

Deno.test("editing one property leaves every other line byte-identical", async () => {
  for (const [name, text] of await fixtures()) {
    const original = logicalLines(text)
    const count = allProperties(parse(text)).length
    for (let index = 0; index < count; index++) {
      const root = parse(text)
      const property = allProperties(root)[index]!
      property.value = `EDITED-${index}`
      const edited = logicalLines(serializeIcal(root))
      assertEquals(edited.length, original.length, `${name} #${index}`)
      const changed = edited.flatMap((line, at) => line === original[at] ? [] : [line])
      assertEquals(changed.length, 1, `${name} #${index} changed ${changed.length} lines`)
      const unfolded = changed[0]!.replace(/\r\n[ \t]/g, "")
      assert(unfolded.endsWith(`:EDITED-${index}`), `${name} #${index}: ${unfolded}`)
    }
  }
})

Deno.test("a property written after a subcomponent keeps its place after an edit", async () => {
  // Radicale sorts properties and writes X-APPLE-SORT-ORDER after the VALARM.
  const root = parse(await fixture("radicale-tasksorg-subtask.ics"))
  const todo = child(root, "VTODO")
  writeText(todo, "SUMMARY", "Short")
  const out = serializeIcal(root)
  assert(out.includes("END:VALARM\r\nX-APPLE-SORT-ORDER:792512400\r\nEND:VTODO\r\n"))
  assert(out.includes("STATUS:NEEDS-ACTION\r\nSUMMARY:Short\r\nUID:"))
})

Deno.test("a new property goes after existing ones and before trailing subcomponents", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  setProperty(child(root, "VTODO"), "X-NEW", "1")
  assert(serializeIcal(root).includes("DUE;VALUE=DATE:20261009\r\nX-NEW:1\r\nBEGIN:VALARM\r\n"))
})

Deno.test("a value mutated directly is re-serialised even though its source is kept", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  const sortOrder = setProperty(child(root, "VTODO"), "X-APPLE-SORT-ORDER", "1")
  assertExists(sortOrder.source)
  sortOrder.params.push({ name: "X-NOTE", values: ["a:b"] })
  assert(serializeIcal(root).includes('X-APPLE-SORT-ORDER;X-NOTE="a:b":1\r\n'))
})

Deno.test("bare LF input is accepted and written back with CRLF", async () => {
  const text = await fixture("stalwart-tasksorg-folded.ics")
  assertEquals(serializeIcal(parse(text.replaceAll("\r\n", "\n"))), text)
})

Deno.test("parseIcal unfolds continuation lines that start with SPACE or HTAB", async () => {
  const event = child(parse(await fixture("outlook-sample.ics")), "VEVENT")
  assertEquals(
    readText(getProperty(event, "DESCRIPTION")!),
    "Agenda: budget review and the hiring plan for the next quarter. Bring the latest numbers.\n",
  )
  assertEquals(
    getProperty(event, "UID")!.value,
    "040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5A60100000000000000001" +
      "000000010203040506070809",
  )
})

Deno.test("a fresh line is folded to 75 octets without splitting a character", () => {
  const root = parse("BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID:a\r\nEND:VTODO\r\nEND:VCALENDAR\r\n")
  const todo = child(root, "VTODO")
  const text = "🎬 Задача с длинным названием, эмодзи 👩‍👩‍👧 и запятыми; ".repeat(6)
  writeText(todo, "SUMMARY", text)
  const out = serializeIcal(root)
  for (const line of out.split("\r\n")) {
    assert(utf8.encode(line).length <= 75, `${utf8.encode(line).length} octets: ${line}`)
    assert(line.isWellFormed(), `split surrogate pair: ${line}`)
  }
  assertEquals(readText(getProperty(child(parse(out), "VTODO"), "SUMMARY")!), text)
})

/** Deterministic 32-bit PRNG (mulberry32), so a failing generated case is reproducible. */
function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ALPHABET = [..."aZ09 ,;:\\\"^'\nЖжЯ€😀👩‍👧é\t-_./"]

function randomText(random: () => number, length: number): string {
  let out = ""
  for (let index = 0; index < length; index++) {
    out += ALPHABET[Math.floor(random() * ALPHABET.length)]
  }
  return out
}

/** Fold a logical line at random code-point boundaries, the way a careless producer might. */
function randomFold(random: () => number, line: string): string {
  const points = [...line]
  let out = points[0]!
  for (const point of points.slice(1)) {
    out += random() < 0.04 ? `\r\n${random() < 0.5 ? " " : "\t"}${point}` : point
  }
  return out
}

function randomComponent(random: () => number, name: string, depth: number): string[] {
  const lines = [`BEGIN:${name}`]
  const count = 1 + Math.floor(random() * 6)
  for (let index = 0; index < count; index++) {
    if (depth < 3 && random() < 0.2) {
      lines.push(...randomComponent(random, `X-C${depth}`, depth + 1))
    }
    const params = Array.from({ length: Math.floor(random() * 3) }, (_, at) => {
      const value = icsEscapeParameter(randomText(random, Math.floor(random() * 8)))
      return `;x-P${at}=${/[:;,"]/.test(value) || random() < 0.3 ? `"${value}"` : value}`
    }).join("")
    const name = random() < 0.5 ? "SUMMARY" : `X-${Math.floor(random() * 99)}`
    const value = icsEscape(randomText(random, Math.floor(random() * 120)))
    lines.push(randomFold(random, `${name}${params}:${value}`))
  }
  lines.push(`END:${name}`)
  return lines
}

Deno.test("generated documents round-trip byte for byte (seed 414)", () => {
  const random = prng(414)
  for (let run = 0; run < 300; run++) {
    const text = randomComponent(random, "VCALENDAR", 0).join("\r\n") + "\r\n"
    assertEquals(serializeIcal(parse(text)), text, `run ${run}`)
  }
})

Deno.test("writeText then readText returns the original text (seed 6868)", () => {
  const random = prng(6868)
  for (let run = 0; run < 300; run++) {
    const text = randomText(random, Math.floor(random() * 200))
    const root = parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
    writeText(root, "X-TEXT", text)
    setProperty(root, "X-PARAM", "v", [{ name: "X-P", values: [text] }])
    const back = parse(serializeIcal(root))
    assertEquals(readText(getProperty(back, "X-TEXT")!), text, `run ${run}`)
    assertEquals(getParameter(getProperty(back, "X-PARAM")!, "x-p")!.values, [text], `run ${run}`)
  }
})

Deno.test("parameters are decoded per RFC 6868 and quoted ones keep : ; ,", async () => {
  const event = child(parse(await fixture("apple-sample.ics")), "VEVENT")
  const attendee = getProperty(event, "ATTENDEE")!
  assertEquals(getParameter(attendee, "CN")!.values, ['Jane "JD" Doe'])
  assertEquals(attendee.value, "mailto:jane@example.com")
  const location = getProperty(event, "X-APPLE-STRUCTURED-LOCATION")!
  assertEquals(getParameter(location, "X-TITLE")!.values, ["Community Center: Hall B"])
  assertEquals(getParameter(location, "X-ADDRESS")!.values, ["100 Main Street, Springfield"])
  assertEquals(location.value, "geo:40.712800,-74.006000")
})

Deno.test("a written parameter value with : ; or , is quoted and one with a newline is escaped", () => {
  const root = parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
  setProperty(root, "X-A", "1", [{ name: "X-P", values: ["a;b", "plain", 'say "hi"\nnow'] }])
  assertEquals(serializeIcal(root).split("\r\n")[1], `X-A;X-P="a;b",plain,say ^'hi^'^nnow:1`)
})

Deno.test("readList merges every CATEGORIES line and splits only on unescaped commas", async () => {
  const thunderbird = child(parse(await fixture("thunderbird-sample.ics")), "VTODO")
  assertEquals(readList(thunderbird, "CATEGORIES"), ["Work", "Reports", "Q4"])
  const nextcloud = child(parse(await fixture("nextcloud-sample.ics")), "VTODO")
  assertEquals(readList(nextcloud, "categories"), ["Events, parties", "Planning"])
})

Deno.test("writeList replaces several lines with one in the first line's place", async () => {
  const root = parse(await fixture("thunderbird-sample.ics"))
  const todo = child(root, "VTODO")
  writeList(todo, "CATEGORIES", ["Work", "a,b"])
  assertEquals(getProperties(todo, "CATEGORIES").length, 1)
  assert(serializeIcal(root).includes("PERCENT-COMPLETE:40\r\nCATEGORIES:Work,a\\,b\r\nDTSTART;"))
  writeList(todo, "CATEGORIES", [])
  assertEquals(getProperty(todo, "CATEGORIES"), undefined)
})

Deno.test("removeProperty removes every property of that name and counts them", async () => {
  const todo = child(parse(await fixture("thunderbird-sample.ics")), "VTODO")
  assertEquals(removeProperty(todo, "categories"), 2)
  assertEquals(removeProperty(todo, "CATEGORIES"), 0)
})

Deno.test("readDate tells the four date kinds apart", async () => {
  const dateDue = child(parse(await fixture("stalwart-tasksorg-date-due.ics")), "VTODO")
  assertEquals(readDate(getProperty(dateDue, "DUE")!), {
    kind: IcalDateKind.Date,
    date: "2026-10-09",
  })
  const zoned = child(parse(await fixture("stalwart-tasksorg-recurring.ics")), "VTODO")
  assertEquals(readDate(getProperty(zoned, "DUE")!), {
    kind: IcalDateKind.Zoned,
    date: "2026-08-14",
    time: "11:00:01",
    tzid: "Asia/Ho_Chi_Minh",
  })
  assertEquals(readDate(getProperty(zoned, "DTSTAMP")!), {
    kind: IcalDateKind.Utc,
    date: "2026-08-18",
    time: "19:05:34",
  })
  const floating = child(parse(await fixture("nextcloud-sample.ics")), "VTODO")
  assertEquals(readDate(getProperty(floating, "DTSTART")!), {
    kind: IcalDateKind.Floating,
    date: "2026-10-02",
    time: "09:00:00",
  })
})

Deno.test("readDate rejects an impossible date or time", () => {
  for (const line of ["DUE:20260230", "DUE:20261301T000000Z", "DUE:20260101T240000", "DUE:2026"]) {
    const root = parse(`BEGIN:VTODO\r\n${line}\r\nEND:VTODO\r\n`)
    assertEquals(readDate(getProperty(root, "DUE")!), undefined, line)
  }
})

Deno.test("a date-only DUE stays date-only through an edit", async () => {
  const root = parse(await fixture("stalwart-tasksorg-date-due.ics"))
  const todo = child(root, "VTODO")
  const due = readDate(getProperty(todo, "DUE")!)!
  const result = writeDate(todo, "DUE", { ...due, date: "2026-10-12" })
  assert(result.success)
  assert(serializeIcal(root).includes("\r\nDUE;VALUE=DATE:20261012\r\n"))
})

Deno.test("a DUE with TZID keeps its zone when its VTIMEZONE is in the document", async () => {
  const root = parse(await fixture("stalwart-tasksorg-recurring.ics"))
  const todo = child(root, "VTODO")
  const due = readDate(getProperty(todo, "DUE")!)!
  assert(writeDate(todo, "DUE", { ...due, time: "12:30:00" }, { root }).success)
  assert(serializeIcal(root).includes("\r\nDUE;TZID=Asia/Ho_Chi_Minh:20260814T123000\r\n"))
  assertEquals(getProperty(todo, "RRULE")!.value, "FREQ=DAILY;INTERVAL=1")
})

Deno.test("writeDate refuses a TZID that no VTIMEZONE in the document defines", async () => {
  const root = parse(await fixture("stalwart-event-alarm.ics"))
  const event = child(root, "VEVENT")
  const start = readDate(getProperty(event, "DTSTART")!)!
  assertEquals(start.tzid, "Asia/Saigon")
  assertEquals(writeDate(event, "DTSTART", start, { root }).error?.code, IcalErrorCode.UnknownTzid)
  assertEquals(writeDate(event, "DTSTART", start).error?.code, IcalErrorCode.UnknownTzid)
})

Deno.test("writeDate refuses to make DUE and DTSTART value types differ", async () => {
  const todo = child(parse(await fixture("tasksorg-sample.ics")), "VTODO")
  const timed = { kind: IcalDateKind.Utc, date: "2026-10-10", time: "10:00:00" }
  assertEquals(writeDate(todo, "DUE", timed).error?.code, IcalErrorCode.ValueTypeMismatch)
  assertEquals(writeDate(todo, "DTSTART", timed).error?.code, IcalErrorCode.ValueTypeMismatch)
  assertEquals(getProperty(todo, "DUE")!.value, "20261010")
  removeProperty(todo, "DTSTART")
  assert(writeDate(todo, "DUE", timed).success)
  assertEquals(getProperty(todo, "DUE")!.params, [])
  assertEquals(getProperty(todo, "DUE")!.value, "20261010T100000Z")
})

Deno.test("writeDate keeps UTC-only properties in UTC and never rewrites CREATED", async () => {
  const todo = child(parse(await fixture("nextcloud-sample.ics")), "VTODO")
  const floating = { kind: IcalDateKind.Floating, date: "2026-10-08", time: "10:00:00" }
  assertEquals(writeDate(todo, "COMPLETED", floating).error?.code, IcalErrorCode.InvalidValue)
  const utc = { kind: IcalDateKind.Utc, date: "2026-10-08", time: "10:00:00" }
  assertEquals(writeDate(todo, "CREATED", utc).error?.code, IcalErrorCode.InvalidValue)
  assertEquals(getProperty(todo, "CREATED")!.value, "20261001T100000Z")
  assert(writeDate(todo, "LAST-MODIFIED", utc).success)
  assertEquals(getProperty(todo, "LAST-MODIFIED")!.value, "20261008T100000Z")
})

Deno.test("writeDate rejects a malformed date or time", () => {
  const root = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  const bad = [
    { kind: IcalDateKind.Date, date: "2026-02-30" },
    { kind: IcalDateKind.Utc, date: "2026-01-01" },
    { kind: IcalDateKind.Floating, date: "2026-01-01", time: "24:00:00" },
  ]
  for (const value of bad) {
    assertEquals(writeDate(root, "DUE", value).error?.code, IcalErrorCode.InvalidValue)
  }
  assertEquals(getProperty(root, "DUE"), undefined)
})

Deno.test("resolveInstant resolves UTC and IANA zones, never a vendor TZID", async () => {
  const recurring = child(parse(await fixture("stalwart-tasksorg-recurring.ics")), "VTODO")
  assertEquals(
    resolveInstant(readDate(getProperty(recurring, "DUE")!)!)?.toISOString(),
    "2026-08-14T04:00:01.000Z",
  )
  assertEquals(
    resolveInstant(readDate(getProperty(recurring, "DTSTAMP")!)!)?.toISOString(),
    "2026-08-18T19:05:34.000Z",
  )
  const alias = child(parse(await fixture("stalwart-event-alarm.ics")), "VEVENT")
  assertEquals(
    resolveInstant(readDate(getProperty(alias, "DTSTART")!)!)?.toISOString(),
    "2026-07-10T07:00:00.000Z",
  )
  const outlook = child(parse(await fixture("outlook-sample.ics")), "VEVENT")
  const windows = readDate(getProperty(outlook, "DTSTART")!)!
  assertEquals(windows.tzid, "W. Europe Standard Time")
  assertEquals(resolveInstant(windows, { zone: "Europe/Berlin" }), undefined)
})

Deno.test("resolveInstant resolves floating times and dates only with a zone", async () => {
  const todo = child(parse(await fixture("nextcloud-sample.ics")), "VTODO")
  const floating = readDate(getProperty(todo, "DTSTART")!)!
  assertEquals(resolveInstant(floating), undefined)
  assertEquals(
    resolveInstant(floating, { zone: "Europe/Berlin" })?.toISOString(),
    "2026-10-02T07:00:00.000Z",
  )
  const date = { kind: IcalDateKind.Date, date: "2026-10-09" }
  assertEquals(resolveInstant(date), undefined)
  assertEquals(
    resolveInstant(date, { zone: "Asia/Tokyo" })?.toISOString(),
    "2026-10-08T15:00:00.000Z",
  )
})

Deno.test("setProperty rejects a value or name that would inject a line", () => {
  const root = parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
  assertThrows(() => setProperty(root, "SUMMARY", "a\r\nEND:VCALENDAR"), TypeError)
  assertThrows(() => setProperty(root, "X Y", "a"), TypeError)
  assertThrows(() => setProperty(root, "X-A", "a", [{ name: "P:Q", values: [] }]), TypeError)
  const property = setProperty(root, "SUMMARY", "ok")
  property.value = "a\nBEGIN:VEVENT"
  assertThrows(() => serializeIcal(root), TypeError)
})

Deno.test("writeText escapes line breaks, commas and semicolons", () => {
  const root = parse("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n")
  writeText(root, "SUMMARY", "a,b;c\\d\ne")
  assertEquals(
    serializeIcal(root),
    "BEGIN:VCALENDAR\r\nSUMMARY:a\\,b\\;c\\\\d\\ne\r\nEND:VCALENDAR\r\n",
  )
})

Deno.test("writeText keeps the property's parameters", async () => {
  const event = child(parse(await fixture("outlook-sample.ics")), "VEVENT")
  writeText(event, "SUMMARY", "Budget review, moved")
  assertEquals(getParameter(getProperty(event, "SUMMARY")!, "LANGUAGE")!.values, ["en-us"])
})

Deno.test("parseIcal refuses input over maxBytes and nesting over maxDepth", async () => {
  const text = await fixture("stalwart-tasksorg-date-due.ics")
  assertEquals(parseIcal(text, { maxBytes: 429 }).error?.code, IcalErrorCode.TooLarge)
  assert(parseIcal(text, { maxBytes: 430 }).success)
  assertEquals(parseIcal(text, { maxDepth: 2 }).error?.code, IcalErrorCode.TooDeep)
  assert(parseIcal(text, { maxDepth: 3 }).success)
})

Deno.test("parseIcal reports malformed input with its line number", () => {
  const cases: [string, number | undefined][] = [
    ["BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nEND:VCALENDAR\r\n", 3],
    ["BEGIN:VCALENDAR\r\n", undefined],
    [" folded\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", 1],
    ["UID:1\r\n", 1],
    ["BEGIN:A\r\nEND:A\r\nBEGIN:B\r\nEND:B\r\n", 3],
    ["BEGIN:A\r\nNOCOLON\r\nEND:A\r\n", 2],
    ['BEGIN:A\r\nX;P="open:1\r\nEND:A\r\n', 2],
    ["BEGIN:A\r\nX;=1:2\r\nEND:A\r\n", 2],
    ["BEGIN:A B\r\nEND:A B\r\n", 1],
    ["", undefined],
  ]
  for (const [text, line] of cases) {
    const result = parseIcal(text)
    assertEquals(result.error?.code, IcalErrorCode.Malformed, JSON.stringify(text))
    assertEquals(result.error?.line, line, JSON.stringify(text))
  }
})

Deno.test("parseIcal names a continuation line that has no line to continue", () => {
  for (const text of [" X:1\r\nBEGIN:A\r\nEND:A\r\n", "\tX:1\r\nBEGIN:A\r\nEND:A\r\n"]) {
    assertEquals(
      parseIcal(text).error?.message,
      "continuation line without a line to continue",
      JSON.stringify(text),
    )
  }
})

Deno.test("time/ical and time/ical-tasks and their local imports use web-platform APIs only", async () => {
  // ical-tasks.ts adds itself, ical-tasks-complete.ts and rrule.ts to the files ical.ts reaches.
  for (const [entry, count] of [["./ical.ts", 4], ["./ical-tasks.ts", 7]] as const) {
    const seen = new Set<string>()
    const queue = [new URL(entry, import.meta.url)]
    while (queue.length > 0) {
      const url = queue.pop()!
      if (seen.has(url.href)) continue
      seen.add(url.href)
      const code = (await Deno.readTextFile(url))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1")
      assertEquals(/\bDeno\./.test(code), false, `${url.pathname} uses Deno.*`)
      for (const [, specifier] of code.matchAll(/\b(?:from|import)\s*\(?\s*"([^"]+)"/g)) {
        assert(specifier!.startsWith("./"), `${url.pathname} imports ${specifier}`)
        queue.push(new URL(specifier!, url))
      }
    }
    assertEquals(seen.size, count, `${entry} reaches ${[...seen].join(" ")}`)
  }
})

Deno.test("foldLine output of a fresh property parses back to the same value", () => {
  // Guards the contract the serialiser relies on: ics-core folds, ical unfolds.
  const value = "Ж".repeat(100)
  const root = parse(`BEGIN:A\r\n${foldLine(`X:${value}`)}\r\nEND:A\r\n`)
  assertEquals(getProperty(root, "X")!.value, value)
})

Deno.test("serializeIcal is linear in the number of interleaved subcomponents", () => {
  // 70,000 subcomponents, each followed by a property of the parent: 1.47 MB, under maxBytes.
  const text = `BEGIN:VCALENDAR\r\n${"BEGIN:A\r\nEND:A\r\nX:1\r\n".repeat(70_000)}END:VCALENDAR\r\n`
  const root = parse(text)
  const started = performance.now()
  const out = serializeIcal(root)
  const elapsed = performance.now() - started
  assertEquals(out, text)
  assert(elapsed < 10000, `serialising took ${Math.round(elapsed)} ms`)
})

Deno.test("a parameter-only edit re-serialises the property and keeps its value", async () => {
  const root = parse(await fixture("stalwart-tasksorg-recurring.ics"))
  const todo = child(root, "VTODO")
  const due = getProperty(todo, "DUE")!
  getParameter(due, "TZID")!.values[0] = "Europe/Berlin"
  assert(serializeIcal(root).includes("\r\nDUE;TZID=Europe/Berlin:20260814T110001\r\n"))
  due.params.push({ name: "X-NOTE", values: ["1"] })
  assert(serializeIcal(root).includes("\r\nDUE;TZID=Europe/Berlin;X-NOTE=1:20260814T110001\r\n"))
  const trigger = getProperty(child(todo, "VALARM"), "TRIGGER")!
  trigger.params[0]!.name = "X-RELATED"
  assert(serializeIcal(root).includes("\r\nTRIGGER;X-RELATED=END:PT0S\r\n"))
})

Deno.test("writeDate refuses a property that holds a list of dates", () => {
  const root = parse("BEGIN:VEVENT\r\nEXDATE:20261005T100000Z,20261012T100000Z\r\nEND:VEVENT\r\n")
  const value = { kind: IcalDateKind.Utc, date: "2026-10-19", time: "10:00:00" }
  assertEquals(writeDate(root, "EXDATE", value).error?.code, IcalErrorCode.InvalidValue)
  assertEquals(getProperty(root, "EXDATE")!.value, "20261005T100000Z,20261012T100000Z")
})

Deno.test("writeDate refuses an unknown date kind", () => {
  const root = parse("BEGIN:VTODO\r\nEND:VTODO\r\n")
  const value = { kind: 99 as IcalDateKind, date: "2026-10-19", time: "10:00:00" }
  assertEquals(writeDate(root, "DUE", value).error?.code, IcalErrorCode.InvalidValue)
  assertEquals(getProperty(root, "DUE"), undefined)
})
