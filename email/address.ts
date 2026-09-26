/**
 * Mailbox parsing for the `From` header and the recipient list.
 *
 * Both the parser and the formatter exist because a display name is attacker-
 * adjacent input the moment it reaches a header: `Name\r\nBcc: victim@…` is a
 * syntactically ordinary display name to a naive `slice` and a forged header to
 * every mail server. Nothing here interpolates a raw string into a header — the
 * caller gets a structured {@link EmailAddress} and the transport decides how to
 * encode it, which is also what makes a non-ASCII name come out as RFC 2047
 * instead of as mojibake.
 *
 * Deliberately stricter than RFC 5322 in two places, both documented at
 * {@link parseAddress}: control characters are rejected outright, and the domain
 * must carry at least one dot.
 * @module
 */

/** A parsed mailbox: the addr-spec, plus the display name that preceded it. */
export interface EmailAddress {
  /** The addr-spec, e.g. `jane@example.com`, never quoted and never wrapped in angle brackets. */
  address: string
  /** Display name with its surrounding quotes removed. Absent when the input carried none. */
  name?: string
}

/** The recipient list after parsing: deduplicated, with what was dropped recorded. */
export interface ParsedRecipients {
  /** Recipients in input order, first occurrence wins, compared case-insensitively. */
  addresses: EmailAddress[]
  /** Addresses dropped as duplicates, as they appeared after the first occurrence. */
  duplicates: string[]
}

/**
 * A dot-atom local part, then a dotted domain of at least two labels.
 *
 * The single-label domain rejection is the deliberate deviation from RFC 5322:
 * `user@localhost` is a valid addr-spec, and no SMTP relay outside a test
 * container will deliver it, so a bare-host address is nearly always a truncated
 * value. Failing it loudly at the boundary beats a silent bounce.
 */
const ADDRESS_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/

/**
 * Characters that can terminate a header line, a header block, or the message
 * body: the C0 range and DEL. Matching the C0 range is the point, so
 * `no-control-regex` is suppressed rather than worked around with a `\p{Cc}`
 * property escape — the explicit range is what a reader needs to see here.
 */
// deno-lint-ignore no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

/**
 * Characters refused in a mailbox on top of {@link CONTROL_CHARACTER_PATTERN}:
 * the C1 range (NEL, U+0085, among them) and the Unicode line and paragraph
 * separators U+2028 and U+2029.
 *
 * nodemailer encodes them inside a header, so they inject nothing there. They are
 * refused in a mailbox because no real address or display name carries one, and a
 * log line or a JSON consumer may read any of them as a line break. A subject or an
 * attachment filename keeps the C0-only rule: a U+2028 from a word processor or a
 * C1 character from mis-decoded Windows-1252 text is common there, and refusing it
 * would fail a send that has always worked.
 */
const MAILBOX_LINE_BREAK_PATTERN = /[\u0080-\u009f\u2028\u2029]/

/** Longest addr-spec that fits a `RCPT TO` path (RFC 5321 §4.5.3.1.3, 256 with the brackets). */
const MAX_ADDR_SPEC_LENGTH = 254

/**
 * Characters that force a display name to be emitted as a quoted-string.
 *
 * A plain space is deliberately absent: `Jane Doe` is a legal unquoted phrase,
 * and quoting it would change nothing for the recipient while making the value
 * harder to read in a log. Whitespace at the edges and the control characters are
 * handled separately in {@link needsQuoting}, so this set stays the RFC 5322
 * `specials` list and nothing else.
 */
const QUOTING_TRIGGER_PATTERN = /[()<>@,;:\\"[\]]/

/**
 * Reject a value that carries a control character — CR and LF above all.
 *
 * A CRLF in a header value injects an arbitrary header: `"Jane\r\nBcc: victim@example.com"`
 * becomes two headers, and the second one is the attacker's. `NUL` and the rest
 * of the C0 set are rejected with it because no header field may contain them
 * either, and the check is on the parsed value rather than on the interpolated
 * header so it cannot be bypassed by a later refactor of the header layout.
 *
 * Only the C0 range and DEL are checked here; a mailbox is held to the stricter
 * rule in {@link parseAddress}.
 *
 * @throws {TypeError} when `value` contains a C0 control character or DEL.
 */
export function assertNoControlCharacters(value: string, what: string): void {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new TypeError(
      `${what} contains a control character, which would inject a header: ${quoteForError(value)}`,
    )
  }
}

/**
 * `JSON.stringify` with every C1 character and U+2028/U+2029 escaped as `\uXXXX`.
 *
 * `JSON.stringify` escapes the C0 range but leaves those raw, so an error message
 * quoting a refused value would carry the very line break it refused.
 */
function quoteForError(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
}

/**
 * Parse `Name <addr>` or a bare addr-spec into its parts.
 *
 * Accepts the forms a caller actually has: `jane@example.com`,
 * `Jane Doe <jane@example.com>`, `"Doe, Jane" <jane@example.com>`, `Jörg <j@example.com>`.
 * A display name containing a comma is accepted unquoted — that is what `mig`
 * did and what a hand-written config value looks like — but it is re-emitted
 * quoted by {@link formatAddress}, because a bare comma splits the header into
 * two mailboxes at the first server that parses it strictly.
 *
 * @throws {TypeError} on a C0 or C1 control character, DEL, U+2028 or U+2029, an
 * unbalanced `<`/`>`, a quote that does not wrap the whole name, trailing text
 * after `>`, an addr-spec longer than 254 characters, or an addr-spec that
 * {@link ADDRESS_PATTERN} rejects.
 */
export function parseAddress(value: string): EmailAddress {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`Expected a non-empty mailbox, got ${JSON.stringify(value)}`)
  }
  assertNoControlCharacters(value, "Mailbox")
  if (MAILBOX_LINE_BREAK_PATTERN.test(value)) {
    throw new TypeError(
      `Mailbox contains a C1 control character or a line separator, which no address or ` +
        `display name carries: ${quoteForError(value)}`,
    )
  }

  const trimmed = value.trim()
  const open = trimmed.indexOf("<")
  const close = trimmed.lastIndexOf(">")

  if (open === -1 && close === -1) {
    return { address: assertAddrSpec(trimmed, value) }
  }

  if (open === -1 || close === -1 || close < open || close !== trimmed.length - 1) {
    throw new TypeError(
      `Malformed mailbox, expected "Name <addr>" or a bare addr-spec: ${JSON.stringify(value)}`,
    )
  }

  const rawName = trimmed.slice(0, open).trim()
  const address = assertAddrSpec(trimmed.slice(open + 1, close).trim(), value)

  if (rawName === "") return { address }
  if (rawName.includes("<")) {
    throw new TypeError(`Malformed display name in ${JSON.stringify(value)}`)
  }

  const name = unquoteDisplayName(rawName, value)
  return name === "" ? { address } : { address, name }
}

/**
 * Parse a recipient list, deduplicating case-insensitively.
 *
 * An address that fails to parse fails the whole list: the alternative is
 * sending to the subset that happened to be well-formed, which looks like a
 * successful send and silently drops a recipient. Nothing here decides what to
 * do about that — it throws, and the transport turns it into a failed
 * {@link SendResult} before any bytes leave the process.
 *
 * @throws {TypeError} on an empty list, or on the first unparsable entry.
 */
export function parseAddresses(values: string | readonly string[]): ParsedRecipients {
  const list = typeof values === "string" ? [values] : values
  if (list.length === 0) {
    throw new TypeError("At least one recipient is required")
  }

  const addresses: EmailAddress[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()

  for (const value of list) {
    const parsed = parseAddress(value)
    const key = parsed.address.toLowerCase()
    if (seen.has(key)) {
      duplicates.push(parsed.address)
      continue
    }
    seen.add(key)
    addresses.push(parsed)
  }

  return { addresses, duplicates }
}

/**
 * Render a mailbox for a log line or a plain-text body.
 *
 * Quotes the display name when it contains a character that would otherwise end
 * it — the comma in `Doe, Jane` above all — and escapes the two characters a
 * quoted-string treats specially. Non-ASCII stays literal: this is for humans
 * reading a string, while the raw name travels to the transport as a separate
 * field so it can be RFC 2047 encoded there.
 */
export function formatAddress(address: EmailAddress): string {
  const name = address.name
  if (name === undefined || name === "") return address.address

  if (!needsQuoting(name)) return `${name} <${address.address}>`

  const escaped = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  return `"${escaped}" <${address.address}>`
}

/** True when `value` is an addr-spec this module will send to. */
export function isAddress(value: string): boolean {
  return ADDRESS_PATTERN.test(value)
}

/**
 * Validate an addr-spec, naming the offending input on failure.
 *
 * The message repeats the input because a mailbox is rarely the only one in a
 * config, and "invalid address" without the value leaves the caller guessing
 * which of five entries it was.
 */
function assertAddrSpec(address: string, original: string): string {
  if (address.length > MAX_ADDR_SPEC_LENGTH) {
    throw new TypeError(
      `Email address is ${address.length} characters, over the ${MAX_ADDR_SPEC_LENGTH} limit`,
    )
  }
  if (!isAddress(address)) {
    throw new TypeError(`Invalid email address in ${JSON.stringify(original)}: ${address}`)
  }
  return address
}

/**
 * Strip the quotes from a display name, rejecting a quote that does not wrap it.
 *
 * `"Doe, Jane"` becomes `Doe, Jane`, and `"a\"b"` becomes `a"b`. A quote inside an
 * unquoted phrase throws — `Doe "JJ" Smith` is exactly the shape a hand-rolled
 * header builder gets wrong, and guessing at the intent would put an unescaped `"`
 * in a header. The bare-quote scan runs before the escapes are resolved, so
 * `"a\"b"` survives while `"a"b"` still fails.
 */
function unquoteDisplayName(rawName: string, original: string): string {
  const startsQuoted = rawName.startsWith('"')
  const endsQuoted = rawName.endsWith('"')

  if (!startsQuoted && !endsQuoted) {
    if (rawName.includes('"')) {
      throw new TypeError(`Unbalanced quote in display name: ${JSON.stringify(original)}`)
    }
    return rawName
  }

  if (!(startsQuoted && endsQuoted) || rawName.length < 2) {
    throw new TypeError(`Unbalanced quote in display name: ${JSON.stringify(original)}`)
  }

  const inner = rawName.slice(1, -1)
  let escaped = false
  for (const character of inner) {
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (character === '"') {
      throw new TypeError(`Unescaped quote in display name: ${JSON.stringify(original)}`)
    }
  }

  return inner.replace(/\\(.)/g, "$1")
}

/**
 * True when a display name has to be emitted as a quoted-string.
 *
 * Three separate reasons, and collapsing them is how a header gets built wrong:
 * an RFC 5322 `specials` character would end the phrase early, leading or
 * trailing whitespace is not part of an unquoted phrase, and a control character
 * — which cannot arrive through {@link parseAddress} but can through a
 * hand-built {@link EmailAddress} — is never legal in a header.
 */
function needsQuoting(name: string): boolean {
  return QUOTING_TRIGGER_PATTERN.test(name) ||
    name !== name.trim() ||
    CONTROL_CHARACTER_PATTERN.test(name)
}
