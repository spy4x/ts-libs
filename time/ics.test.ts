// Behaviour tests for the VEVENT/VCALENDAR writer.
//
// Every case passes an explicit UTC instant and an explicit `dtstamp`, so the
// suite is independent of the host clock and of the host `TZ`.

import { assertEquals, assertThrows } from "@std/assert"
import { CRLF, FOLD_LIMIT, formatIcsUtc, LF, unfoldLines } from "./ics-core.ts"
import {
  attendeeLine,
  buildVEventLines,
  generateIcs,
  type IcsEvent,
  IcsEventStatus,
  IcsMethod,
  type IcsOptions,
  IcsPartStat,
  IcsRole,
  organizerLine,
} from "./ics.ts"

const PRODID = "-//ts-libs//time//EN"
const DTSTAMP = new Date(Date.UTC(2026, 7, 25, 16, 42, 0))

const utf8 = new TextEncoder()

/** A 30-minute meeting at 08:00 UTC, the instant Europe/Berlin 10:00 in August maps to. */
function makeEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "01HXYZBK8M@calendar.example.com",
    start: new Date(Date.UTC(2026, 7, 28, 8, 0, 0)),
    end: new Date(Date.UTC(2026, 7, 28, 8, 30, 0)),
    summary: "Meeting with Jane Doe",
    ...overrides,
  }
}

function makeOptions(overrides: Partial<IcsOptions> = {}): IcsOptions {
  return { prodid: PRODID, dtstamp: DTSTAMP, ...overrides }
}

/** Every physical line of a document, trailing empty split entry removed. */
function physicalLines(document: string): string[] {
  return document.split(CRLF).filter((line) => line !== "")
}

/** Assert every physical line is within the 75-octet limit. */
function assertFoldedWithinLimit(document: string): void {
  for (const line of physicalLines(document)) {
    const octets = utf8.encode(line).length
    assertEquals(
      octets <= FOLD_LIMIT,
      true,
      `physical line is ${octets} octets, above the ${FOLD_LIMIT}-octet limit`,
    )
  }
}

Deno.test("generateIcs emits one VCALENDAR wrapping exactly one VEVENT", () => {
  const document = generateIcs(makeEvent(), makeOptions())
  const flat = unfoldLines(document)

  assertEquals(document.startsWith(`BEGIN:VCALENDAR${CRLF}`), true)
  assertEquals(document.endsWith(`END:VCALENDAR${CRLF}`), true)
  assertEquals(flat.includes(`${CRLF}BEGIN:VEVENT${CRLF}`), true)
  assertEquals(flat.includes(`${CRLF}END:VEVENT${CRLF}`), true)
  assertEquals(flat.split("BEGIN:VEVENT").length - 1, 1)
  assertEquals(flat.split("END:VEVENT").length - 1, 1)
})

Deno.test("generateIcs emits the calendar-level properties", () => {
  const flat = unfoldLines(generateIcs(makeEvent(), makeOptions()))

  assertEquals(flat.includes(`PRODID:${PRODID}${CRLF}`), true)
  assertEquals(flat.includes(`VERSION:2.0${CRLF}`), true)
  assertEquals(flat.includes(`CALSCALE:GREGORIAN${CRLF}`), true)
  assertEquals(flat.includes(`METHOD:REQUEST${CRLF}`), true)
})

Deno.test("generateIcs serialises DTSTART, DTEND and DTSTAMP as UTC with a Z suffix", () => {
  const document = generateIcs(makeEvent(), makeOptions())
  const flat = unfoldLines(document)

  // Europe/Berlin on 2026-08-28 is CEST (UTC+2): 10:00 local = 08:00Z. The
  // caller converted; this writer must not shift it again.
  assertEquals(flat.includes(`DTSTART:20260828T080000Z${CRLF}`), true)
  assertEquals(flat.includes(`DTEND:20260828T083000Z${CRLF}`), true)
  assertEquals(flat.includes(`DTSTAMP:20260825T164200Z${CRLF}`), true)

  for (const line of physicalLines(document)) {
    if (line.startsWith("DTSTART:") || line.startsWith("DTEND:")) {
      assertEquals(line.endsWith("Z"), true, `${line} must be a UTC value`)
      assertEquals(
        /^DT(?:START|END):\d{8}T\d{6}Z$/.test(line),
        true,
        `${line} must match YYYYMMDDTHHMMSSZ`,
      )
    }
  }
})

Deno.test("generateIcs keeps UID stable and unescaped so it round-trips", () => {
  const uid = "01HXYZBK8M@calendar.example.com"
  const flat = unfoldLines(generateIcs(makeEvent({ uid }), makeOptions()))

  assertEquals(flat.includes(`UID:${uid}${CRLF}`), true)
  // A UID holding RFC 5545 TEXT metacharacters must come back byte-exact: the
  // identifier is handed out to clients and compared on the next envelope, so
  // escaping it would change the event's identity.
  const metacharacters = "a,b;c\\d@example.com"
  assertEquals(
    unfoldLines(generateIcs(makeEvent({ uid: metacharacters }), makeOptions()))
      .includes(`UID:${metacharacters}${CRLF}`),
    true,
  )
})

Deno.test("generateIcs emits a byte-exact document for fixed arguments", () => {
  // The whole document, asserted literally. This is what makes the writer's
  // output reproducible: `dtstamp` is caller-supplied, so nothing here can
  // depend on the wall clock, the host TZ or a locale.
  //
  // The DTSTAMP line is built from a hardcoded literal + formatIcsUtc(DTSTAMP)
  // rather than an interpolated string: a writer that ignored options.dtstamp
  // and read the clock instead then fails here, whereas a plain
  // `DTSTAMP:20260825T164200Z` literal is only pinned by the sibling test above
  // and leaves this one passing under that mutation.
  const expectedDtstamp = `DTSTAMP:${formatIcsUtc(DTSTAMP)}`
  assertEquals(expectedDtstamp, "DTSTAMP:20260825T164200Z")

  assertEquals(
    generateIcs(makeEvent(), makeOptions()),
    [
      "BEGIN:VCALENDAR",
      `PRODID:${PRODID}`,
      "VERSION:2.0",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:01HXYZBK8M@calendar.example.com",
      expectedDtstamp,
      "DTSTART:20260828T080000Z",
      "DTEND:20260828T083000Z",
      "SUMMARY:Meeting with Jane Doe",
      "STATUS:CONFIRMED",
      "TRANSP:OPAQUE",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n"),
  )
})

Deno.test("generateIcs drops CR and LF from a UID instead of emitting injected properties", () => {
  const injected = "abc\r\nX-INJECTED:1\r\nUID:forged"
  const document = generateIcs(makeEvent({ uid: injected }), makeOptions())

  // The UID occupies a property value, so a surviving CR or LF ends the content
  // line and the remainder becomes a property of the attacker's choosing. Every
  // C0 control goes, and the filter must not rely on stripControlCharacters —
  // that helper keeps LF and CR on purpose, for RFC 5545 §3.1 folding.
  for (const line of physicalLines(document)) {
    assertEquals(line.startsWith("X-INJECTED"), false, "injected an X-INJECTED property")
    assertEquals(
      line.startsWith("UID:"),
      line === "UID:abcX-INJECTED:1UID:forged",
      `unexpected UID line ${line}`,
    )
  }
  assertEquals(document.split(`${CRLF}UID:`).length - 1, 1)
  assertEquals(unfoldLines(document).includes(`UID:abcX-INJECTED:1UID:forged${CRLF}`), true)
})

Deno.test("generateIcs rejects a UID that is nothing but control characters", () => {
  assertThrows(() => generateIcs(makeEvent({ uid: "\r\n" }), makeOptions()), TypeError, "uid")
  assertThrows(() => generateIcs(makeEvent({ uid: "\u0000" }), makeOptions()), TypeError, "uid")
  assertThrows(() => generateIcs(makeEvent({ uid: "\t " }), makeOptions()), TypeError, "uid")
})

Deno.test("generateIcs quotes and RFC 6868-escapes the ORGANIZER CN parameter", () => {
  const flat = unfoldLines(
    generateIcs(
      makeEvent({ organizer: { email: "jane@example.com", name: "Jane Doe" } }),
      makeOptions(),
    ),
  )

  assertEquals(flat.includes(`ORGANIZER;CN="Jane Doe":mailto:jane@example.com${CRLF}`), true)
})

Deno.test("generateIcs emits one ATTENDEE line per attendee with its parameters", () => {
  const flat = unfoldLines(
    generateIcs(
      makeEvent({
        attendees: [
          { email: "client@example.com", name: "Client", rsvp: true },
          {
            email: "chair@example.com",
            name: "Chair",
            role: IcsRole.CHAIR,
            partStat: IcsPartStat.ACCEPTED,
            rsvp: false,
          },
        ],
      }),
      makeOptions(),
    ),
  )

  assertEquals(
    flat.includes(`ATTENDEE;CN="Client";RSVP=TRUE:mailto:client@example.com${CRLF}`),
    true,
  )
  assertEquals(
    flat.includes(
      `ATTENDEE;CN="Chair";ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:chair@example.com${CRLF}`,
    ),
    true,
  )
  assertEquals(flat.split("ATTENDEE").length - 1, 2)
})

Deno.test("generateIcs omits ORGANIZER and ATTENDEE when none are supplied", () => {
  const flat = unfoldLines(generateIcs(makeEvent(), makeOptions()))

  assertEquals(flat.includes("ORGANIZER"), false)
  assertEquals(flat.includes("ATTENDEE"), false)
})

Deno.test("generateIcs leaves an RFC 5545-legal comma and semicolon unescaped inside CN", () => {
  const flat = unfoldLines(
    generateIcs(
      makeEvent({
        attendees: [{ email: "client@example.com", name: "Lastname, Firstname; PhD", rsvp: true }],
      }),
      makeOptions(),
    ),
  )

  // Inside a quoted parameter value, `,` and `;` are data — only RFC 6868
  // escapes apply, so the source's backslash-escaping would be wrong here.
  assertEquals(flat.includes(`CN="Lastname, Firstname; PhD";RSVP=TRUE`), true)
  assertEquals(flat.includes("\\;"), false)
})

Deno.test("generateIcs RFC 6868-escapes a parameter value that tries to inject a parameter", () => {
  const document = generateIcs(
    makeEvent({
      attendees: [{
        email: "client@example.com",
        name: `Visitor";ROLE=CHAIR^${LF}Injected`,
        rsvp: true,
      }],
    }),
    makeOptions(),
  )
  const flat = unfoldLines(document)

  // The injected ROLE must not have become a real parameter: the parameter list
  // is exactly CN and RSVP, and everything the attacker wrote sits inside the
  // quoted CN value.
  assertEquals(
    flat.includes(
      `ATTENDEE;CN="Visitor^';ROLE=CHAIR^^^nInjected";RSVP=TRUE:mailto:client@example.com${CRLF}`,
    ),
    true,
  )
  for (const line of physicalLines(document)) {
    assertEquals(line.startsWith("ROLE="), false, "injected a ROLE property")
    assertEquals(line.startsWith("RSVP=TRUE"), false, "injected an RSVP property")
  }
})

Deno.test("generateIcs escapes TEXT properties and folds nothing into a new property", () => {
  const event = makeEvent({
    summary: "Standup; ops, weekly",
    description: `Agenda${CRLF}Line two; with, punctuation`,
    location: "Room 1, Floor 2; north wing",
    url: "https://meet.example.com/room/1",
  })
  const flat = unfoldLines(generateIcs(event, makeOptions()))

  assertEquals(flat.includes(`SUMMARY:Standup\\; ops\\, weekly${CRLF}`), true)
  assertEquals(flat.includes(`DESCRIPTION:Agenda\\nLine two\\; with\\, punctuation${CRLF}`), true)
  assertEquals(flat.includes(`LOCATION:Room 1\\, Floor 2\\; north wing${CRLF}`), true)
  assertEquals(flat.includes(`URL:https://meet.example.com/room/1${CRLF}`), true)
})

Deno.test("generateIcs omits optional TEXT properties that were not supplied", () => {
  const flat = unfoldLines(generateIcs(makeEvent(), makeOptions()))

  assertEquals(flat.includes("DESCRIPTION"), false)
  assertEquals(flat.includes("LOCATION"), false)
  assertEquals(flat.includes("URL"), false)
  assertEquals(flat.includes("SEQUENCE"), false)

  const withEmpty = unfoldLines(
    generateIcs(makeEvent({ description: "", location: "", url: "" }), makeOptions()),
  )
  assertEquals(withEmpty.includes("DESCRIPTION"), false)
  assertEquals(withEmpty.includes("LOCATION"), false)
  assertEquals(withEmpty.includes("URL"), false)
})

Deno.test("generateIcs strips control characters before any escaping", () => {
  const document = generateIcs(
    makeEvent({
      summary: "Client\u0000Name",
      description: "Note\u0007Text",
      location: "Room\u007F1",
    }),
    makeOptions(),
  )
  const flat = unfoldLines(document)

  assertEquals(document.includes("\u0000"), false)
  assertEquals(document.includes("\u0007"), false)
  assertEquals(document.includes("\u007F"), false)
  assertEquals(flat.includes("SUMMARY:ClientName"), true)
  assertEquals(flat.includes("NoteText"), true)
  assertEquals(flat.includes("Room1"), true)
})

Deno.test("generateIcs emits STATUS:CONFIRMED and METHOD:REQUEST for an active event", () => {
  const flat = unfoldLines(generateIcs(makeEvent(), makeOptions()))

  assertEquals(flat.includes(`STATUS:CONFIRMED${CRLF}`), true)
  assertEquals(flat.includes(`METHOD:REQUEST${CRLF}`), true)
  assertEquals(flat.includes(`TRANSP:OPAQUE${CRLF}`), true)
})

Deno.test("generateIcs honours an explicitly tentative status", () => {
  const flat = unfoldLines(
    generateIcs(makeEvent({ status: IcsEventStatus.TENTATIVE }), makeOptions()),
  )

  assertEquals(flat.includes(`STATUS:TENTATIVE${CRLF}`), true)
  assertEquals(flat.includes(`METHOD:REQUEST${CRLF}`), true)
})

Deno.test("generateIcs sends a cancellation as METHOD:CANCEL with STATUS:CANCELLED", () => {
  const flat = unfoldLines(
    generateIcs(makeEvent({ status: IcsEventStatus.CANCELLED }), makeOptions()),
  )

  assertEquals(flat.includes(`STATUS:CANCELLED${CRLF}`), true)
  // RFC 5545 §3.4: a cancellation is METHOD:CANCEL. The source hardcoded
  // METHOD:REQUEST (mig/lib/ics.ts:136) for every status, so clients treated
  // the cancellation as an update request and kept the event.
  assertEquals(flat.includes(`METHOD:CANCEL${CRLF}`), true)
  assertEquals(flat.includes("METHOD:REQUEST"), false)
})

Deno.test("generateIcs emits SEQUENCE only when supplied, and it increments the revision", () => {
  const bare = unfoldLines(generateIcs(makeEvent(), makeOptions()))
  assertEquals(bare.includes("SEQUENCE"), false)

  const revised = unfoldLines(
    generateIcs(makeEvent({ status: IcsEventStatus.CANCELLED, sequence: 1 }), makeOptions()),
  )
  assertEquals(revised.includes(`SEQUENCE:1${CRLF}`), true)

  const zero = unfoldLines(generateIcs(makeEvent({ sequence: 0 }), makeOptions()))
  assertEquals(zero.includes(`SEQUENCE:0${CRLF}`), true)
})

Deno.test("generateIcs rejects a SEQUENCE that is not a non-negative integer", () => {
  // RFC 5545 §3.8.7.4: SEQUENCE is a non-negative integer. NaN, Infinity, 1.5
  // and -3 are all type-legal `number`s, so nothing but an explicit guard stops
  // them reaching the wire as SEQUENCE:NaN, SEQUENCE:1.5 and so on.
  for (
    const sequence of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -3, -1]
  ) {
    assertThrows(
      () => generateIcs(makeEvent({ sequence }), makeOptions()),
      TypeError,
      "event.sequence must be a non-negative integer",
      `${String(sequence)} must be rejected`,
    )
  }

  // A JS caller can pass a string; its CRLF would become a real content line.
  const injected = "1\r\nX-INJECTED:1"
  assertThrows(
    () => generateIcs(makeEvent({ sequence: injected as unknown as number }), makeOptions()),
    TypeError,
    "event.sequence must be a non-negative integer",
  )
  // And the value RFC 5545 permits must still be accepted.
  for (const sequence of [0, 1, 2147483647]) {
    assertEquals(
      unfoldLines(generateIcs(makeEvent({ sequence }), makeOptions()))
        .includes(`SEQUENCE:${sequence}${CRLF}`),
      true,
    )
  }
  assertThrows(
    () => generateIcs(makeEvent({ sequence: 2147483648 }), makeOptions()),
    TypeError,
    "non-negative integer",
  )
})

Deno.test("generateIcs keeps the SEQUENCE guard in buildVEventLines, the exported entry", () => {
  // buildVEventLines is exported for #13, so the guard must live there and not
  // only in generateIcs.
  assertThrows(
    () => buildVEventLines(makeEvent({ sequence: 1.5 }), DTSTAMP, IcsMethod.REQUEST),
    TypeError,
    "event.sequence must be a non-negative integer",
  )
  assertEquals(
    buildVEventLines(makeEvent({ sequence: 2 }), DTSTAMP, IcsMethod.REQUEST).includes("SEQUENCE:2"),
    true,
  )
})

Deno.test("buildVEventLines emits a foldable VEVENT block with the RFC 5545 property order", () => {
  const lines = buildVEventLines(
    makeEvent({
      description: "Agenda",
      location: "Room 1",
      url: "https://meet.example.com/room/1",
      organizer: { email: "jane@example.com", name: "Jane Doe" },
      attendees: [{ email: "client@example.com", name: "Client", rsvp: true }],
    }),
    DTSTAMP,
    IcsMethod.REQUEST,
  )

  assertEquals(lines[0], "BEGIN:VEVENT")
  assertEquals(lines.at(-1), "END:VEVENT")
  assertEquals(
    lines.indexOf("DTSTART:20260828T080000Z") < lines.indexOf("SUMMARY:Meeting with Jane Doe"),
    true,
  )
  assertEquals(
    lines.indexOf("DTSTAMP:20260825T164200Z") < lines.indexOf("DTSTART:20260828T080000Z"),
    true,
  )
  assertEquals(lines.indexOf("STATUS:CONFIRMED") < lines.indexOf("END:VEVENT"), true)
  // Every line is foldable on its own, and the block carries no line break of
  // its own — the caller joins it.
  for (const line of lines) {
    assertEquals(utf8.encode(line).length <= FOLD_LIMIT, true, `unfoldable: ${line.slice(0, 40)}`)
    assertEquals(line.includes("\r"), false)
    assertEquals(line.includes("\n"), false)
  }
  assertThrows(
    () => buildVEventLines(makeEvent(), DTSTAMP, IcsMethod.CANCEL),
    TypeError,
    "contradicts",
  )
})

Deno.test("organizerLine quotes and escapes the CN parameter", () => {
  assertEquals(
    organizerLine({ email: "jane@example.com", name: "Jane Doe" }),
    'ORGANIZER;CN="Jane Doe":mailto:jane@example.com',
  )
  assertEquals(
    organizerLine({ email: "jane@example.com" }),
    "ORGANIZER:mailto:jane@example.com",
  )
  // RFC 6868 escaping inside the quoted value, no backslash escaping.
  assertEquals(
    organizerLine({ email: "jane@example.com", name: `Jane "JD"${LF}Doe` }),
    `ORGANIZER;CN="Jane ^'JD^'^nDoe":mailto:jane@example.com`,
  )
  assertEquals(
    organizerLine({ email: "  jane@example.com  " }),
    "ORGANIZER:mailto:jane@example.com",
  )
  assertThrows(() => organizerLine({ email: "\r\n" }), TypeError, "ORGANIZER")
})

Deno.test("attendeeLine emits parameters in RFC 5545 order and defaults ROLE away", () => {
  assertEquals(
    attendeeLine({ email: "client@example.com", name: "Client", rsvp: true }),
    'ATTENDEE;CN="Client";RSVP=TRUE:mailto:client@example.com',
  )
  assertEquals(
    attendeeLine({
      email: "chair@example.com",
      name: "Chair",
      role: IcsRole.CHAIR,
      partStat: IcsPartStat.ACCEPTED,
      rsvp: false,
    }),
    'ATTENDEE;CN="Chair";ROLE=CHAIR;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:chair@example.com',
  )
  // REQ-PARTICIPANT is RFC 5545's default, so it emits no parameter.
  assertEquals(
    attendeeLine({ email: "a@example.com", role: IcsRole.REQ_PARTICIPANT }),
    "ATTENDEE:mailto:a@example.com",
  )
  assertEquals(
    attendeeLine({ email: "a@example.com", partStat: IcsPartStat.NEEDS_ACTION }),
    "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:a@example.com",
  )
  // A CN carrying RFC 6868 or TEXT metacharacters stays inside the quoted value.
  assertEquals(
    attendeeLine({ email: "a@example.com", name: "Last, First; PhD" }),
    `ATTENDEE;CN="Last, First; PhD":mailto:a@example.com`,
  )
})

Deno.test("generateIcs emits SEQUENCE after STATUS so clients read the revision with the status", () => {
  const flat = unfoldLines(
    generateIcs(makeEvent({ status: IcsEventStatus.CANCELLED, sequence: 2 }), makeOptions()),
  )

  assertEquals(
    flat.indexOf(`${CRLF}STATUS:CANCELLED${CRLF}`) < flat.indexOf(`${CRLF}SEQUENCE:2${CRLF}`),
    true,
  )
})

Deno.test("generateIcs rejects a method that contradicts the event status", () => {
  assertThrows(
    () => generateIcs(makeEvent(), makeOptions({ method: IcsMethod.CANCEL })),
    TypeError,
    "contradicts a CONFIRMED event",
  )
  assertThrows(
    () =>
      generateIcs(
        makeEvent({ status: IcsEventStatus.CANCELLED }),
        makeOptions({ method: IcsMethod.REQUEST }),
      ),
    TypeError,
    "contradicts a CANCELLED event",
  )
})

Deno.test("generateIcs rejects an end that is not after the start", () => {
  const start = new Date(Date.UTC(2026, 7, 28, 8, 0, 0))

  assertThrows(
    () => generateIcs(makeEvent({ end: start }), makeOptions()),
    RangeError,
    "after event.start",
  )
  assertThrows(
    () => generateIcs(makeEvent({ end: new Date(Date.UTC(2026, 7, 28, 7, 59, 0)) }), makeOptions()),
    RangeError,
    "after event.start",
  )
})

Deno.test("generateIcs rejects missing required values", () => {
  assertThrows(() => generateIcs(makeEvent({ uid: "  " }), makeOptions()), TypeError, "uid")
  assertThrows(() => generateIcs(makeEvent({ uid: "\u0000" }), makeOptions()), TypeError, "uid")
  assertThrows(
    () => generateIcs(makeEvent({ start: new Date(Number.NaN) }), makeOptions()),
    TypeError,
    "valid Dates",
  )
  assertThrows(() => generateIcs(makeEvent(), makeOptions({ prodid: " " })), TypeError, "prodid")
  assertThrows(
    () => generateIcs(makeEvent(), makeOptions({ dtstamp: new Date(Number.NaN) })),
    TypeError,
    "dtstamp",
  )
  assertThrows(
    () => generateIcs(makeEvent({ organizer: { email: " " } }), makeOptions()),
    TypeError,
    "ORGANIZER",
  )
  assertThrows(
    () => generateIcs(makeEvent({ attendees: [{ email: "" }] }), makeOptions()),
    TypeError,
    "ATTENDEE",
  )
})

Deno.test("generateIcs ignores surrounding whitespace in an email address", () => {
  const flat = unfoldLines(
    generateIcs(makeEvent({ organizer: { email: "  jane@example.com  " } }), makeOptions()),
  )
  assertEquals(flat.includes(`ORGANIZER:mailto:jane@example.com${CRLF}`), true)
})

Deno.test("generateIcs strips a control character from an email address in the value position", () => {
  const document = generateIcs(
    makeEvent({ organizer: { email: "jane\r\nX-INJECTED:1@example.com" } }),
    makeOptions(),
  )

  // The address is not escaped, so a raw CRLF would end the ORGANIZER line and
  // start a new property. It must be removed, not escaped — the injected
  // property never appears at the start of a line.
  assertEquals(document.includes("\rX-INJECTED"), false)
  assertEquals(document.includes("\nX-INJECTED"), false)
  for (const line of physicalLines(document)) {
    assertEquals(line.startsWith("X-INJECTED"), false, "injected an X-INJECTED property")
  }
  assertEquals(
    unfoldLines(document).includes("ORGANIZER:mailto:janeX-INJECTED:1@example.com"),
    true,
  )
})

Deno.test("generateIcs separates every content line with literal CRLF", () => {
  const document = generateIcs(
    makeEvent({ description: `line one${LF}line two` }),
    makeOptions(),
  )

  // Literal CRLF bytes, deliberately not the CRLF constant: RFC 5545 §3.1
  // requires a real carriage return, and an assertion phrased in terms of the
  // constant would silently follow the implementation if the constant changed.
  assertEquals(document.startsWith("BEGIN:VCALENDAR\r\n"), true)
  assertEquals(document.endsWith("END:VCALENDAR\r\n"), true)
  assertEquals(document.includes("\r\n"), true)
  assertEquals(document.replaceAll("\r\n", "").includes("\n"), false)
  assertEquals(document.replaceAll("\r\n", "").includes("\r"), false)

  // Every physical line is terminated by exactly one CRLF, so the split count
  // is the physical-line count plus the trailing empty entry.
  const physical = document.split("\r\n")
  assertEquals(physical.at(-1), "")
  assertEquals(physical.length, physicalLines(document).length + 1)
  for (const line of physical.slice(0, -1)) {
    assertEquals(line.includes("\n"), false, `bare LF inside ${JSON.stringify(line)}`)
    assertEquals(line.includes("\r"), false, `bare CR inside ${JSON.stringify(line)}`)
  }
})

Deno.test("generateIcs folds every line to 75 octets and unfolds back to the logical document", () => {
  const event = makeEvent({
    summary: "Meeting with 訪問者訪問者訪問者訪問者訪問者訪問者訪問者訪問者 🚀",
    description: `${"漢字かなカナ 🚀 ".repeat(20)}end`,
    location: "Konferenzraum 漢字",
    organizer: { email: "jane@example.com", name: "Jane Doe 訪問者" },
    attendees: [{ email: "client@example.com", name: "Client 訪", rsvp: true }],
  })
  const document = generateIcs(event, makeOptions())

  assertFoldedWithinLimit(document)

  const flat = unfoldLines(document)
  assertEquals(flat.includes(`SUMMARY:${event.summary}${CRLF}`), true)
  assertEquals(flat.includes(`DESCRIPTION:${event.description}${CRLF}`), true)
  assertEquals(flat.includes(`LOCATION:${event.location}${CRLF}`), true)
  assertEquals(flat.includes(`CN="Client 訪";RSVP=TRUE`), true)
})

Deno.test("generateIcs rejects a ROLE or PARTSTAT outside its enum", () => {
  // JavaScript callers bypass the enum, and the value lands in the parameter
  // list, so an unvalidated string forges parameters or rewrites the address.
  const hostile = 'X;CN="Evil";RSVP=TRUE:mailto:attacker@example.com'

  assertEquals(
    unfoldLines(
      generateIcs(
        makeEvent({ attendees: [{ email: "victim@example.com", name: "V", role: IcsRole.CHAIR }] }),
        makeOptions(),
      ),
    ).includes(`ATTENDEE;CN="V";ROLE=CHAIR:mailto:victim@example.com${CRLF}`),
    true,
  )
  const asRole = hostile as unknown as IcsRole
  const asPartStat = 99 as unknown as IcsPartStat
  assertThrows(
    () =>
      generateIcs(
        makeEvent({ attendees: [{ email: "v@example.com", role: asRole }] }),
        makeOptions(),
      ),
    TypeError,
    "attendee.role",
  )
  assertThrows(
    () =>
      generateIcs(
        makeEvent({ attendees: [{ email: "v@example.com", partStat: asPartStat }] }),
        makeOptions(),
      ),
    TypeError,
    "attendee.partStat",
  )
  assertThrows(
    () => generateIcs(makeEvent(), makeOptions({ method: 99 as unknown as IcsMethod })),
    TypeError,
    "method",
  )
})

Deno.test("generateIcs omits the ROLE parameter for the RFC 5545 default", () => {
  const flat = unfoldLines(
    generateIcs(
      makeEvent({ attendees: [{ email: "a@example.com", role: IcsRole.REQ_PARTICIPANT }] }),
      makeOptions(),
    ),
  )

  assertEquals(flat.includes("ROLE="), false)
  assertEquals(flat.includes(`ATTENDEE:mailto:a@example.com${CRLF}`), true)
})

Deno.test("generateIcs never emits an empty line or a continuation for a short document", () => {
  const document = generateIcs(makeEvent(), makeOptions())

  for (const line of physicalLines(document)) {
    assertEquals(line !== "", true)
  }
  assertEquals(physicalLines(document).length, 15)
  assertEquals(unfoldLines(document).includes(`${CRLF}${CRLF}`), false)
})
