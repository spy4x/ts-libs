// Behaviour tests for the RFC 5545 wire primitives: folding, unfolding and the
// escaping rules. Deterministic by construction — no clock, no host timezone.

import { assertEquals, assertThrows } from "@std/assert"
import {
  assertFoldable,
  CONTINUATION_LIMIT,
  CRLF,
  FOLD_LIMIT,
  foldLine,
  formatIcsUtc,
  icsEscape,
  icsEscapeParameter,
  icsUnescape,
  icsUnescapeParameter,
  joinContentLines,
  LF,
  stripControlCharacters,
  unfoldLines,
} from "./ics-core.ts"

const utf8 = new TextEncoder()

/** Octet length of a string as it appears in the document. */
function octets(value: string): number {
  return utf8.encode(value).length
}

/** Physical lines of a document, without the trailing empty split entry. */
function physicalLines(document: string): string[] {
  return document.split(CRLF).filter((line) => line !== "")
}

/** Assert every physical line respects the 75-octet limit, continuation included. */
function assertFoldedWithinLimit(document: string): void {
  for (const line of physicalLines(document)) {
    const length = octets(line)
    assertEquals(
      length <= FOLD_LIMIT,
      true,
      `physical line is ${length} octets, above the ${FOLD_LIMIT}-octet limit`,
    )
  }
}

Deno.test("foldLine leaves a line of exactly 75 octets unfolded", () => {
  const line = "A".repeat(FOLD_LIMIT)
  assertEquals(octets(line), 75)
  assertEquals(foldLine(line), line)
  assertEquals(physicalLines(foldLine(line)).length, 1)
})

Deno.test("foldLine folds a line of 76 octets into one continuation line", () => {
  const line = "A".repeat(FOLD_LIMIT + 1)
  const folded = physicalLines(foldLine(line))

  assertEquals(folded.length, 2)
  assertEquals(octets(folded[0]!), FOLD_LIMIT)
  assertEquals(folded[1]!, ` A`)
  assertEquals(folded[1]!.startsWith(" "), true)
})

Deno.test("foldLine prefixes a continuation line with exactly one space", () => {
  const folded = physicalLines(foldLine("B".repeat(300)))

  assertEquals(folded.length, 5)
  for (const continuation of folded.slice(1)) {
    assertEquals(continuation.startsWith(" "), true)
    assertEquals(continuation.startsWith("  "), false)
    assertEquals(octets(continuation) <= FOLD_LIMIT, true)
  }
})

Deno.test("foldLine counts octets, not UTF-16 code units", () => {
  // 26 CJK code points = 26 code units = 78 octets: over the limit in octets,
  // under it if the loop counts characters. A character-counting fold leaves
  // this single 78-octet line on the wire.
  const line = "漢".repeat(26)
  assertEquals(line.length, 26)
  assertEquals(octets(line), 78)

  const folded = physicalLines(foldLine(line))
  assertEquals(folded.length, 2)
  assertFoldedWithinLimit(foldLine(line))
})

Deno.test("foldLine never splits an emoji across the fold boundary", () => {
  // 4 octets per emoji; the prefix pushes the boundary inside the 4-octet run.
  const line = `SUMMARY:${"🚀".repeat(40)}`
  const folded = physicalLines(foldLine(line))

  assertEquals(folded.length > 2, true)
  assertFoldedWithinLimit(foldLine(line))
  for (const physical of folded) {
    // A split emoji would emit a lone surrogate, which encodes as U+FFFD.
    assertEquals(physical.includes("\uFFFD"), false)
  }
  assertEquals(unfoldLines(foldLine(line)), line)
})

Deno.test("foldLine moves a 3-octet character off a boundary with room for two octets", () => {
  // "漢" is 3 octets; the first line has 2 octets of room. Slicing bytes would
  // emit two thirds of a code point, so the whole character must move down.
  const line = `${"A".repeat(73)}${"漢".repeat(4)}`
  const folded = physicalLines(foldLine(line))

  assertEquals(octets(folded[0]!), 73)
  assertEquals(folded[1]!.startsWith(" 漢"), true)
  assertFoldedWithinLimit(foldLine(line))
  assertEquals(unfoldLines(foldLine(line)), line)
})

Deno.test("foldLine round-trips multi-byte and control-heavy content exactly", () => {
  const samples = [
    "🚀".repeat(30),
    "漢字かなカナ".repeat(20),
    `${"A".repeat(75)}🚀${"B".repeat(10)}漢`,
    `${"mixed🚀漢 a, b; c\\d\n".repeat(12)}`,
    "",
    "short",
  ]

  for (const sample of samples) {
    const folded = foldLine(sample)
    assertEquals(unfoldLines(folded), sample, `unfold must reproduce ${JSON.stringify(sample)}`)
  }
})

Deno.test("foldLine counts a lone surrogate as its encoder replacement width", () => {
  // An unpaired surrogate is not valid UTF-8; TextEncoder substitutes U+FFFD
  // (3 octets). The fold loop must use that same measurement it encodes with,
  // or the emitted line can exceed 75 octets.
  const line = `${"A".repeat(74)}\uD83D${"B".repeat(10)}`
  assertFoldedWithinLimit(foldLine(line))
  assertEquals(unfoldLines(foldLine(line)), line)
})

Deno.test("CONTINUATION_LIMIT reserves one octet for the continuation space", () => {
  assertEquals(CONTINUATION_LIMIT, FOLD_LIMIT - 1)
})

Deno.test("unfoldLines rejoins a fold sequence and ignores a bare LF", () => {
  assertEquals(unfoldLines(`ABC${CRLF} DEF`), "ABCDEF")
  assertEquals(unfoldLines(`ABC${LF} DEF`), "ABCDEF")
  assertEquals(unfoldLines(`ABC${CRLF}\tDEF`), "ABCDEF")
  // A line that merely starts with a space, with no preceding break, is data.
  assertEquals(unfoldLines(` ABC`), " ABC")
})

Deno.test("joinContentLines terminates every line with CRLF, including the last", () => {
  assertEquals(
    joinContentLines(["BEGIN:VCALENDAR", "END:VCALENDAR"]),
    `BEGIN:VCALENDAR${CRLF}END:VCALENDAR${CRLF}`,
  )
  assertEquals(joinContentLines([]), "")
})

Deno.test("joinContentLines folds a long line and terminates it once", () => {
  const document = joinContentLines([`SUMMARY:${"漢".repeat(60)}`])

  assertEquals(document.endsWith(CRLF), true)
  assertEquals(document.includes(`${LF}${LF}`), false)
  assertFoldedWithinLimit(document)
  assertEquals(unfoldLines(document), `SUMMARY:${"漢".repeat(60)}${CRLF}`)
})

Deno.test("assertFoldable rejects a line over 75 octets and passes one at the limit", () => {
  assertFoldable("A".repeat(FOLD_LIMIT))
  assertThrows(() => assertFoldable("A".repeat(FOLD_LIMIT + 1)), RangeError)
  // 25 CJK code points are 75 octets but only 25 characters.
  assertFoldable("漢".repeat(25))
  assertThrows(() => assertFoldable("漢".repeat(26)), RangeError)
})

Deno.test("icsEscape escapes backslash, semicolon and comma", () => {
  assertEquals(icsEscape("a\\b;c,d"), "a\\\\b\\;c\\,d")
  assertEquals(icsEscape("plain"), "plain")
  assertEquals(icsEscape(""), "")
})

Deno.test("icsEscape collapses every line-break convention to the \\n escape", () => {
  assertEquals(icsEscape(`First${CRLF}Second`), "First\\nSecond")
  assertEquals(icsEscape(`First${LF}Second`), "First\\nSecond")
  assertEquals(icsEscape("First\rSecond"), "First\\nSecond")
  assertEquals(icsEscape(`a${CRLF}${LF}b`), "a\\n\\nb")
})

Deno.test("icsEscape doubles the backslash before the escape it prefixes", () => {
  // Order matters: escaping ";" first would turn a literal "\;" into "\\\;"
  // (an escaped backslash followed by an escaped semicolon) instead of the
  // literal backslash-semicolon the caller wrote.
  assertEquals(icsEscape("\\;"), "\\\\\\;")
  assertEquals(icsUnescape(icsEscape("\\;")), "\\;")
})

Deno.test("icsEscape strips NUL, BEL and DEL but keeps HTAB", () => {
  assertEquals(icsEscape("Client\u0000Name"), "ClientName")
  assertEquals(icsEscape("Note\u0007Text"), "NoteText")
  assertEquals(icsEscape("Tab\tkept"), "Tab\tkept")
  assertEquals(icsEscape("Del\u007Feted"), "Del" + "eted")
  assertEquals(stripControlCharacters("\u0000\u0007\u007F"), "")
})

Deno.test("icsUnescape is the exact inverse of icsEscape", () => {
  const samples = [
    "a\\b;c,d",
    `line one${LF}line two`,
    "\\n is not a newline until it is escaped",
    "trailing\\",
    "漢字 🚀 & <> |",
    "",
  ]

  for (const sample of samples) {
    assertEquals(
      icsUnescape(icsEscape(sample)),
      sample,
      `round trip failed for ${JSON.stringify(sample)}`,
    )
  }
})

Deno.test("icsEscapeParameter RFC 6868-encodes caret, quote and newline", () => {
  assertEquals(icsEscapeParameter("a^nb"), "a^^nb")
  assertEquals(icsEscapeParameter(`a"b`), "a^'b")
  assertEquals(icsEscapeParameter(`a${LF}b`), "a^nb")
  assertEquals(icsEscapeParameter(`a${CRLF}b`), "a^nb")
  assertEquals(icsEscapeParameter("plain"), "plain")
})

Deno.test("icsEscapeParameter never emits a bare quote or line break", () => {
  const escaped = icsEscapeParameter(`Visitor";ROLE=CHAIR^${LF}Injected`)

  assertEquals(escaped, "Visitor^';ROLE=CHAIR^^^nInjected")
  assertEquals(escaped.includes('"'), false)
  assertEquals(escaped.includes(LF), false)
  assertEquals(escaped.includes("\r"), false)
})

Deno.test("icsEscapeParameter doubles the caret so an encoded sequence survives decoding", () => {
  // A literal "^n" must not become the newline escape: the caret is doubled.
  assertEquals(icsEscapeParameter("^n"), "^^n")
  assertEquals(icsUnescapeParameter(icsEscapeParameter("^n")), "^n")
  assertEquals(icsUnescapeParameter("^^n"), "^n")
})

Deno.test("icsUnescapeParameter decodes ^^, ^' and ^n and passes unknown escapes through", () => {
  assertEquals(icsUnescapeParameter("a^'b"), `a"b`)
  assertEquals(icsUnescapeParameter("a^nb"), `a${LF}b`)
  assertEquals(icsUnescapeParameter("a^^b"), "a^b")
  assertEquals(icsUnescapeParameter("a^xb"), "a^xb")
  assertEquals(icsUnescapeParameter("trailing^"), "trailing^")
})

Deno.test("icsUnescapeParameter is the inverse of icsEscapeParameter", () => {
  // Caret-bearing samples included deliberately: "^^n" must decode to a literal
  // caret followed by "n", not to a newline, or a value holding "^n" cannot
  // round-trip. See icsUnescapeParameter's JSDoc.
  const samples = [
    `Lastname, Firstname; PhD`,
    `Visitor";ROLE=CHAIR${LF}Injected`,
    "^n",
    "^^",
    "a^nb",
    "a^b",
    "^",
    "trailing^",
    `${LF}`,
    "plain",
    "",
  ]

  for (const sample of samples) {
    assertEquals(
      icsUnescapeParameter(icsEscapeParameter(sample)),
      sample,
      `round trip failed for ${JSON.stringify(sample)}`,
    )
  }
})

Deno.test("formatIcsUtc emits a Z-suffixed UTC value and ignores the host timezone", () => {
  assertEquals(formatIcsUtc(new Date(Date.UTC(2026, 7, 28, 8, 0, 0))), "20260828T080000Z")
  assertEquals(formatIcsUtc(new Date(0)), "19700101T000000Z")
  // Sub-second precision is dropped, not rounded.
  assertEquals(formatIcsUtc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 999))), "20260102T030405Z")
})

Deno.test("formatIcsUtc pads single-digit fields and rejects an invalid Date", () => {
  assertEquals(formatIcsUtc(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "20260102T030405Z")
  assertThrows(() => formatIcsUtc(new Date(Number.NaN)), TypeError, "valid Date")
})
