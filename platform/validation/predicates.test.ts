// Behaviour of the portable text predicates. No disk, no environment, no network: the time-zone
// cases rely on `Intl`'s bundled tzdata being deterministic for the names asserted here.

import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert"
import { type } from "arktype"
import { isValidTimeZone } from "@spy4x/time/tz"
import {
  DEL_CODE_POINT,
  hasHeaderControlCharacters,
  hasTextControlCharacters,
  HEADER_MAX_CODE_POINT,
  headerSafeString,
  honeypotField,
  isHoneypotFilled,
  isValidTimeZoneName,
  TEXT_ALLOWED_CODE_POINTS,
  textSafeString,
  timeZoneName,
} from "./predicates.ts"

/** RFC 2606 domain, RFC 5737 address, obviously-fake — never a real destination. */
const validBooking = {
  name: "Visitor",
  notes: "",
  website: "",
}

const bookingForm = type({
  name: headerSafeString,
  notes: textSafeString,
  website: honeypotField,
  "guestTz?": timeZoneName,
})

Deno.test("header predicate rejects C0 code point 31 and DEL 127, accepts the 32..126 printable range", () => {
  for (let codePoint = 0; codePoint <= HEADER_MAX_CODE_POINT; codePoint++) {
    assert(
      hasHeaderControlCharacters(String.fromCodePoint(codePoint)),
      `code point ${codePoint} must be rejected in a header value`,
    )
  }
  assertFalse(hasHeaderControlCharacters(" "))
  assertFalse(hasHeaderControlCharacters("~"))
  assert(hasHeaderControlCharacters(String.fromCodePoint(DEL_CODE_POINT)))
})

Deno.test("header predicate rejects NUL, TAB, LF and CR — a header admits no control character at all", () => {
  for (const codePoint of [0, 9, 10, 13]) {
    assert(
      hasHeaderControlCharacters(String.fromCodePoint(codePoint)),
      `code point ${codePoint} must be rejected in a header value`,
    )
  }
})

Deno.test("text predicate keeps TAB, LF and CR, and rejects the rest of C0 including backspace and DEL", () => {
  for (const codePoint of TEXT_ALLOWED_CODE_POINTS) {
    assertFalse(
      hasTextControlCharacters(String.fromCodePoint(codePoint)),
      `code point ${codePoint} must stay legal in free text`,
    )
  }
  assert(hasTextControlCharacters(String.fromCodePoint(8)))
  assert(hasTextControlCharacters(String.fromCodePoint(31)))
  assertFalse(hasTextControlCharacters(" "))
  assert(hasTextControlCharacters(String.fromCodePoint(DEL_CODE_POINT)))
  assert(hasTextControlCharacters("\u0000"))
})

Deno.test("boundary code points separate the header and text predicates", () => {
  assertEquals(HEADER_MAX_CODE_POINT, 31)
  assertEquals(DEL_CODE_POINT, 127)
  assertEquals(TEXT_ALLOWED_CODE_POINTS, [9, 10, 13])

  const boundary = {
    0: { header: true, text: true },
    8: { header: true, text: true },
    9: { header: true, text: false },
    10: { header: true, text: false },
    13: { header: true, text: false },
    31: { header: true, text: true },
    32: { header: false, text: false },
    126: { header: false, text: false },
    127: { header: true, text: true },
  }

  for (const [codePoint, expected] of Object.entries(boundary)) {
    const character = String.fromCodePoint(Number(codePoint))
    assertEquals(hasHeaderControlCharacters(character), expected.header, `header, ${codePoint}`)
    assertEquals(hasTextControlCharacters(character), expected.text, `text, ${codePoint}`)
  }
})

Deno.test("a multi-line note passes the text refinement and fails the header one", () => {
  const note = "First line\r\nSecond line\twith a tab"

  assertEquals(textSafeString(note), note)
  assertEquals(
    textSafeString("Line one\nLine two\tindented"),
    "Line one\nLine two\tindented",
  )
  assertInstanceOf(headerSafeString(note), type.errors)
  assertInstanceOf(headerSafeString("Visitor\nInjected"), type.errors)
})

Deno.test("emoji and accented text pass both predicates", () => {
  const value = "🔐 émojis & spëcial"

  assertFalse(hasHeaderControlCharacters(value))
  assertFalse(hasTextControlCharacters(value))
  assertEquals(headerSafeString(value), value)
  assertEquals(textSafeString(value), value)
})

Deno.test("the empty string passes both string refinements", () => {
  assertEquals(headerSafeString(""), "")
  assertEquals(textSafeString(""), "")
})

Deno.test("honeypotField accepts only the empty string, and isHoneypotFilled agrees on every case", () => {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    ["", false],
    ["http://spam.example", true],
    [" ", true],
    ["\u0000", true],
    ["0", true],
  ]

  for (const [value, filled] of cases) {
    const outcome = honeypotField(value)
    assertEquals(
      outcome instanceof type.errors,
      filled,
      `honeypotField must ${filled ? "reject" : "accept"} ${JSON.stringify(value)}`,
    )
    assertEquals(isHoneypotFilled(value), filled, `isHoneypotFilled on ${JSON.stringify(value)}`)
    assertEquals(
      outcome instanceof type.errors,
      isHoneypotFilled(value),
      `schema and predicate must not drift on ${JSON.stringify(value)}`,
    )
  }
})

Deno.test("time zone probe accepts real IANA zone names and rejects unknown, empty or padded ones", () => {
  const accepted = ["UTC", "Europe/Berlin", "America/New_York"]
  const rejected = ["Not/A_Timezone", "", "gibberish", "EST5EDT "]

  for (const zone of accepted) {
    assert(isValidTimeZoneName(zone), `${JSON.stringify(zone)} must be accepted`)
    assertEquals(timeZoneName(zone), zone)
  }
  for (const zone of rejected) {
    assertFalse(isValidTimeZoneName(zone), `${JSON.stringify(zone)} must be rejected`)
    assertEquals(
      timeZoneName(zone) instanceof type.errors,
      true,
      `${JSON.stringify(zone)} must be rejected by the refinement`,
    )
  }
})

Deno.test("isValidTimeZoneName agrees with @spy4x/time/tz's isValidTimeZone (#71)", () => {
  // isValidTimeZoneName is a deprecated call-through to isValidTimeZone. This checks that the two
  // agree on every case either suite uses, plus a lowercase zone; it cannot tell a call-through
  // from a copied body, so it guards behaviour, not the delegation.
  const cases = [
    "UTC",
    "Europe/Berlin",
    "America/New_York",
    "america/new_york",
    "Not/A_Timezone",
    "gibberish",
    "",
    "Europe/Berlin ",
    "EST5EDT ",
  ]
  for (const zone of cases) {
    assertEquals(
      isValidTimeZoneName(zone),
      isValidTimeZone(zone),
      `isValidTimeZoneName and isValidTimeZone must agree on ${JSON.stringify(zone)}`,
    )
  }
})

Deno.test("a refinement failure reports the ctx.mustBe text, not arktype's anonymous-predicate default", () => {
  const outcome = textSafeString("Note\u0000Injected")

  assertInstanceOf(outcome, type.errors)
  assertStringIncludes(outcome.summary, "contains a control character")
  assertFalse(outcome.summary.includes("anonymous predicate"))
  assertStringIncludes(String(honeypotField("http://spam.example")), "must be empty")
})

Deno.test("the predicates compose inside a larger object schema", () => {
  assertInstanceOf(bookingForm(validBooking), Object)
  assertInstanceOf(bookingForm({ ...validBooking, guestTz: "America/New_York" }), Object)
  assertInstanceOf(bookingForm(bookingForm(validBooking)), Object)

  assertEquals(
    bookingForm({ ...validBooking, name: "Visitor\nInjected" }) instanceof type.errors,
    true,
  )
  assertEquals(
    bookingForm({ ...validBooking, notes: "Note\u0000Injected" }) instanceof type.errors,
    true,
  )
  assertEquals(
    bookingForm({ ...validBooking, notes: "First line\nSecond line" }) instanceof type.errors,
    false,
  )
  assertEquals(
    bookingForm({ ...validBooking, website: "http://spam.example" }) instanceof type.errors,
    true,
  )
  assertEquals(
    bookingForm({ ...validBooking, guestTz: "Not/A_Timezone" }) instanceof type.errors,
    true,
  )
})
