// Behaviour tests for mailbox parsing and header safety.
//
// The two cases that matter most are the last two groups: a CRLF in a display
// name must be rejected rather than emitted, and a list with one broken entry
// must fail whole rather than quietly mailing the rest.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import {
  assertNoControlCharacters,
  formatAddress,
  isAddress,
  parseAddress,
  parseAddresses,
} from "./address.ts"

Deno.test("parses a bare addr-spec", () => {
  assertEquals(parseAddress("jane@example.com"), { address: "jane@example.com" })
  assertEquals(parseAddress("  jane@example.com  "), { address: "jane@example.com" })
})

Deno.test("parses a display name before an angle-addr", () => {
  assertEquals(parseAddress("Jane Doe <jane@example.com>"), {
    address: "jane@example.com",
    name: "Jane Doe",
  })
  assertEquals(parseAddress("Jane Doe<jane@example.com>"), {
    address: "jane@example.com",
    name: "Jane Doe",
  })
})

Deno.test("unquotes a display name that contains a comma", () => {
  assertEquals(parseAddress('"Doe, Jane" <jane@example.com>'), {
    address: "jane@example.com",
    name: "Doe, Jane",
  })
})

Deno.test("accepts an unquoted display name containing a comma", () => {
  assertEquals(parseAddress("Doe, Jane <jane@example.com>"), {
    address: "jane@example.com",
    name: "Doe, Jane",
  })
})

Deno.test("keeps a non-ASCII display name unencoded", () => {
  assertEquals(parseAddress("Jörg Müller <joerg@example.com>"), {
    address: "joerg@example.com",
    name: "Jörg Müller",
  })
})

Deno.test("resolves a backslash escape inside a quoted display name", () => {
  assertEquals(parseAddress('"a\\"b" <x@example.com>'), {
    address: "x@example.com",
    name: 'a"b',
  })
})

Deno.test("treats an empty quoted display name as no name", () => {
  assertEquals(parseAddress('"" <x@example.com>'), { address: "x@example.com" })
})

Deno.test("rejects a malformed mailbox", () => {
  for (
    const value of [
      "",
      "   ",
      "nonsense",
      "jane@example",
      "jane@",
      "@example.com",
      "jane@@example.com",
      "Jane <jane@example.com> trailing",
      "Jane <jane@example.com",
      "Jane jane@example.com>",
      "Jane <jane@example",
      "Jane <ja ne@example.com>",
      "Jane <a@b.c> <d@e.f>",
    ]
  ) {
    assertThrows(() => parseAddress(value), TypeError, undefined, `expected a throw for ${value}`)
  }
})

Deno.test("rejects a CRLF that would inject a header into a display name", () => {
  assertThrows(
    () => parseAddress("Jane\r\nBcc: victim@example.com"),
    TypeError,
    undefined,
    "bare CRLF display name",
  )
  assertThrows(
    () => parseAddress("Jane\r\nBcc: victim@example.com <jane@example.com>"),
    TypeError,
    undefined,
    "CRLF display name with a valid addr-spec behind it",
  )
  assertThrows(
    () => parseAddress('"Jane\nBcc: victim@example.com" <jane@example.com>'),
    TypeError,
    undefined,
    "CRLF inside a quoted display name",
  )
  assertThrows(
    () => parseAddress("jane@example.com\r\nBcc: victim@example.com"),
    TypeError,
    undefined,
    "CRLF appended to a bare addr-spec",
  )
})

Deno.test("rejects a NUL and a bare tab in a mailbox", () => {
  assertThrows(() => parseAddress("Jane\u0000 <jane@example.com>"), TypeError)
  assertThrows(() => parseAddress("Ja\tne <jane@example.com>"), TypeError)
})

Deno.test("rejects an unbalanced quote in a display name", () => {
  assertThrows(() => parseAddress('"Jane <jane@example.com>'), TypeError)
  assertThrows(() => parseAddress('Jane" <jane@example.com>'), TypeError)
  assertThrows(() => parseAddress('Doe "JJ" Smith <jane@example.com>'), TypeError)
})

Deno.test("accepts only a real addr-spec as an address", () => {
  assertEquals(isAddress("jane@example.com"), true)
  assertEquals(isAddress("jane+tag@sub.example.co.uk"), true)
  assertEquals(isAddress("jane@localhost"), false)
  assertEquals(isAddress("Jane <jane@example.com>"), false)
  assertEquals(isAddress("jane@example.com "), false)
})

Deno.test("re-quotes a display name that carries a comma or a quote", () => {
  assertEquals(
    formatAddress({ address: "jane@example.com", name: "Doe, Jane" }),
    '"Doe, Jane" <jane@example.com>',
  )
  assertEquals(
    formatAddress({ address: "jane@example.com", name: 'Jane "JJ" Doe' }),
    '"Jane \\"JJ\\" Doe" <jane@example.com>',
  )
  assertEquals(
    formatAddress({ address: "jane@example.com", name: "Jane Doe" }),
    "Jane Doe <jane@example.com>",
  )
  assertEquals(formatAddress({ address: "jane@example.com" }), "jane@example.com")
})

Deno.test("parses a list and preserves input order", () => {
  const parsed = parseAddresses(["b@example.com", "A <a@example.com>"])
  assertEquals(parsed.addresses, [
    { address: "b@example.com" },
    { address: "a@example.com", name: "A" },
  ])
  assertEquals(parsed.duplicates, [])
})

Deno.test("treats a single string as a one-entry list", () => {
  assertEquals(parseAddresses("a@example.com").addresses, [{ address: "a@example.com" }])
})

Deno.test("deduplicates recipients case-insensitively and reports them", () => {
  const parsed = parseAddresses(["Jane@example.com", "jane@example.com", "b@example.com"])
  assertEquals(parsed.addresses, [{ address: "Jane@example.com" }, { address: "b@example.com" }])
  assertEquals(parsed.duplicates, ["jane@example.com"])
})

Deno.test("rejects an empty recipient list", () => {
  assertThrows(() => parseAddresses([]), TypeError)
})

Deno.test("fails the whole list when one recipient is invalid", () => {
  assertThrows(
    () => parseAddresses(["good@example.com", "not an address", "also@example.com"]),
    TypeError,
    "Invalid email address",
  )
})

Deno.test("assertNoControlCharacters names the offending value", () => {
  assertThrows(
    () => assertNoControlCharacters("a\r\nBcc: b@example.com", "Subject"),
    TypeError,
    "Subject contains a control character",
  )
})

Deno.test("refuses NEL and the Unicode line separators in a mailbox", () => {
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    assertThrows(
      () => parseAddress(`Jane${separator}Bcc: victim@example.com <jane@example.com>`),
      TypeError,
      "control character",
    )
  }
})

Deno.test("assertNoControlCharacters allows a plain value", () => {
  assertNoControlCharacters("Meeting <draft> — 10:00", "Subject")
})

Deno.test("a rejected display name never reaches a formatted string", () => {
  const injected = "Jane\r\nBcc: victim@example.com"
  assertThrows(() => parseAddress(injected), TypeError)
  assertStringIncludes(parseAddress("Jane <jane@example.com>").address, "jane@example.com")
})
