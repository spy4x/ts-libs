// Behaviour tests for the message shape, the per-recipient timezone framing and
// the ICS attachment.
//
// Every case passes an explicit instant, an explicit `dtstamp` and explicit IANA
// zones, so nothing here depends on the host clock or on the host `TZ`. The suite
// is expected to pass identically under `TZ=Pacific/Kiritimati`.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { type IcsEvent, IcsEventStatus, type IcsOptions } from "@ts-libs/time/ics"
import {
  assertSendableMessage,
  type EmailMessage,
  frameInstantLong,
  frameInstantShort,
  frameWallClockLong,
  frameWallClockShort,
  hasBody,
  icalAttachment,
} from "./message.ts"

const PRODID = "-//ts-libs//email//EN"
/** One fixed instant, so nothing in this suite reads the clock. */
const DTSTAMP = new Date(Date.UTC(2026, 7, 25, 16, 42, 0))

/** 2026-08-28 10:00 in Europe/Berlin, the wall clock `mig`'s confirmation used. */
const BOOKING = { date: "2026-08-28", time: "10:00", sourceTz: "Europe/Berlin" }

/** A 30-minute meeting over the booking above, as an absolute instant. */
function makeEvent(overrides: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "01HXYZBK8M@calendar.example.com",
    start: new Date(Date.UTC(2026, 7, 28, 8, 0, 0)),
    end: new Date(Date.UTC(2026, 7, 28, 8, 30, 0)),
    summary: "Meeting with the guest",
    ...overrides,
  }
}

function makeOptions(overrides: Partial<IcsOptions> = {}): IcsOptions {
  return { prodid: PRODID, dtstamp: DTSTAMP, ...overrides }
}

function makeMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return { to: "guest@example.com", subject: "Booking confirmed", text: "Hello", ...overrides }
}

Deno.test("frames a wall clock in the recipient's zone and names the zone", () => {
  assertEquals(
    frameWallClockLong(BOOKING.date, BOOKING.time, BOOKING.sourceTz, "America/New_York"),
    "Friday, 28 August 2026 at 04:00 (America/New_York)",
  )
})

Deno.test("frames a wall clock in the source zone when the recipient has none", () => {
  assertEquals(
    frameWallClockLong(BOOKING.date, BOOKING.time, BOOKING.sourceTz),
    "Friday, 28 August 2026 at 10:00 (Europe/Berlin)",
  )
})

Deno.test("falls back to the source zone for an unknown recipient zone", () => {
  assertEquals(
    frameWallClockLong(BOOKING.date, BOOKING.time, BOOKING.sourceTz, "Not/A_Timezone"),
    "Friday, 28 August 2026 at 10:00 (Europe/Berlin)",
  )
})

Deno.test("frames a wall clock without the zone name, for a subject line", () => {
  assertEquals(
    frameWallClockShort(BOOKING.date, BOOKING.time, BOOKING.sourceTz, "America/New_York"),
    "Fri 28 Aug 04:00",
  )
  assertEquals(
    frameWallClockShort(BOOKING.date, BOOKING.time, BOOKING.sourceTz, "Not/A_Timezone"),
    "Fri 28 Aug 10:00",
  )
})

Deno.test("frames an instant in the recipient's zone", () => {
  const instant = new Date(Date.UTC(2026, 7, 28, 8, 0, 0))
  assertEquals(
    frameInstantLong(instant, "America/New_York", "Europe/Berlin"),
    "Friday, 28 August 2026 at 04:00 (America/New_York)",
  )
  assertEquals(
    frameInstantShort(instant, "Pacific/Kiritimati", "Europe/Berlin"),
    "Fri 28 Aug 22:00",
  )
})

Deno.test("rejects a fallback zone the runtime does not know", () => {
  const instant = new Date(Date.UTC(2026, 7, 28, 8, 0, 0))
  assertThrows(
    () => frameInstantLong(instant, "America/New_York", "Not/A_Timezone"),
    RangeError,
    "Timezone is not an IANA zone",
  )
  assertThrows(
    () => frameWallClockLong(BOOKING.date, BOOKING.time, "Not/A_Timezone"),
    RangeError,
    "sourceTz is not an IANA zone",
  )
})

Deno.test("accepts a message with a text body, an html body, or both", () => {
  assertSendableMessage(makeMessage())
  assertSendableMessage(makeMessage({ text: undefined, html: "<p>Hello</p>" }))
  assertSendableMessage(makeMessage({ html: "<p>Hello</p>" }))
})

Deno.test("treats a blank body as absent", () => {
  assertEquals(hasBody(""), false)
  assertEquals(hasBody("   \n"), false)
  assertEquals(hasBody("x"), true)
  assertEquals(hasBody(undefined), false)
})

Deno.test("rejects a message with no body at all", () => {
  assertThrows(
    () => assertSendableMessage(makeMessage({ text: undefined })),
    TypeError,
    "needs a text body",
  )
  assertThrows(
    () => assertSendableMessage(makeMessage({ text: "   " })),
    TypeError,
    "needs a text body",
  )
})

Deno.test("rejects a message with no recipients", () => {
  assertThrows(() => assertSendableMessage(makeMessage({ to: [] })), TypeError)
  assertThrows(() => assertSendableMessage(makeMessage({ to: "  " })), TypeError)
})

Deno.test("rejects a CRLF in the subject instead of folding it", () => {
  assertThrows(
    () => assertSendableMessage(makeMessage({ subject: "Hi\r\nBcc: victim@example.com" })),
    TypeError,
    "Subject contains a control character",
  )
})

Deno.test("rejects a CRLF in an attachment filename", () => {
  assertThrows(
    () =>
      assertSendableMessage(makeMessage({
        attachments: [{
          filename: "a.ics\r\nContent-Type: text/html",
          content: "x",
          contentType: "text/calendar",
        }],
      })),
    TypeError,
    "Attachment filename contains a control character",
  )
})

Deno.test("rejects an attachment with no content type or no filename", () => {
  assertThrows(
    () =>
      assertSendableMessage(makeMessage({
        attachments: [{ filename: "a.ics", content: "x", contentType: "  " }],
      })),
    TypeError,
    "has no contentType",
  )
  assertThrows(
    () =>
      assertSendableMessage(makeMessage({
        attachments: [{ filename: "", content: "x", contentType: "text/calendar" }],
      })),
    TypeError,
    "filename must not be empty",
  )
})

Deno.test("accepts angle brackets in a subject, which are ordinary text", () => {
  assertSendableMessage(makeMessage({ subject: "Meeting <draft> confirmed" }))
})

Deno.test("builds a text/calendar attachment from a time/ics event", () => {
  const attachment = icalAttachment(makeEvent(), { ics: makeOptions() })

  assertEquals(attachment.filename, "meeting.ics")
  assertEquals(attachment.contentType, "text/calendar; charset=utf-8; method=REQUEST")
  assertStringIncludes(attachment.content, "BEGIN:VCALENDAR\r\n")
  assertStringIncludes(attachment.content, "METHOD:REQUEST")
  assertStringIncludes(attachment.content, "SUMMARY:Meeting with the guest")
})

Deno.test("takes the MIME method from the generated calendar, not a second derivation", () => {
  const attachment = icalAttachment(
    makeEvent({ status: IcsEventStatus.CANCELLED }),
    { ics: makeOptions() },
  )

  assertStringIncludes(attachment.content, "METHOD:CANCEL")
  assertEquals(attachment.contentType, "text/calendar; charset=utf-8; method=CANCEL")
})

Deno.test("honours an explicit iTIP method in both the body and the MIME type", () => {
  const attachment = icalAttachment(makeEvent(), { ics: makeOptions(), filename: "invite.ics" })

  assertEquals(attachment.filename, "invite.ics")
  assertEquals(attachment.contentType, "text/calendar; charset=utf-8; method=REQUEST")
})

Deno.test("keeps a multi-byte filename unchanged — encoding is the transport's job", () => {
  const attachment = icalAttachment(makeEvent(), {
    ics: makeOptions(),
    filename: "Einladung – Besprechung.ics",
  })
  assertEquals(attachment.filename, "Einladung – Besprechung.ics")
})
