// RFC 5545 VCALENDAR/VEVENT writer.
//
// Framework-agnostic and domain-free: this module knows nothing about bookings,
// hosts, products or URLs beyond what the caller puts in an {@link IcsEvent}.
// It depends only on `time/ics-core.ts` — deliberately not on `time/tz.ts` —
// so the entire timezone contract is "give me the correct UTC instant".
//
// Out of scope by design (documented in `time/README.md`): RRULE/EXDATE/
// RECURRENCE-ID, VTIMEZONE/TZID, VALARM/DURATION, VTODO, multiple VEVENTs, and
// any parsing of existing calendars.

import { formatIcsUtc, icsEscape, icsEscapeParameter, joinContentLines } from "./ics-core.ts"

/** RFC 5545 §3.7.2 iTIP method carried by the `METHOD` property. */
export enum IcsMethod {
  PUBLISH = 1,
  REQUEST = 2,
  REPLY = 3,
  ADD = 4,
  CANCEL = 5,
  REFRESH = 6,
  COUNTER = 7,
  DECLINECOUNTER = 8,
}

/** iTIP method name for each {@link IcsMethod} member, as emitted on the wire. */
const METHOD_NAMES: Record<IcsMethod, string> = {
  [IcsMethod.PUBLISH]: "PUBLISH",
  [IcsMethod.REQUEST]: "REQUEST",
  [IcsMethod.REPLY]: "REPLY",
  [IcsMethod.ADD]: "ADD",
  [IcsMethod.CANCEL]: "CANCEL",
  [IcsMethod.REFRESH]: "REFRESH",
  [IcsMethod.COUNTER]: "COUNTER",
  [IcsMethod.DECLINECOUNTER]: "DECLINECOUNTER",
}

/** RFC 5545 §3.8.1.11 `STATUS` property for a VEVENT. */
export enum IcsEventStatus {
  TENTATIVE = 1,
  CONFIRMED = 2,
  CANCELLED = 3,
}

/** RFC 5545 §3.8.1.11 status name for each {@link IcsEventStatus} member. */
const STATUS_NAMES: Record<IcsEventStatus, string> = {
  [IcsEventStatus.TENTATIVE]: "TENTATIVE",
  [IcsEventStatus.CONFIRMED]: "CONFIRMED",
  [IcsEventStatus.CANCELLED]: "CANCELLED",
}

/** RFC 5545 §3.2.12 `PARTSTAT` participation status. */
export enum IcsPartStat {
  NEEDS_ACTION = 1,
  ACCEPTED = 2,
  DECLINED = 3,
  TENTATIVE = 4,
  DELEGATED = 5,
}

/** `PARTSTAT` name for each {@link IcsPartStat} member. */
const PARTSTAT_NAMES: Record<IcsPartStat, string> = {
  [IcsPartStat.NEEDS_ACTION]: "NEEDS-ACTION",
  [IcsPartStat.ACCEPTED]: "ACCEPTED",
  [IcsPartStat.DECLINED]: "DECLINED",
  [IcsPartStat.TENTATIVE]: "TENTATIVE",
  [IcsPartStat.DELEGATED]: "DELEGATED",
}

/** RFC 5545 §3.2.16 `ROLE` parameter values for an attendee. */
export enum IcsRole {
  CHAIR = 1,
  REQ_PARTICIPANT = 2,
  OPT_PARTICIPANT = 3,
  NON_PARTICIPANT = 4,
}

/** `ROLE` name for each {@link IcsRole} member. */
const ROLE_NAMES: Record<IcsRole, string> = {
  [IcsRole.CHAIR]: "CHAIR",
  [IcsRole.REQ_PARTICIPANT]: "REQ-PARTICIPANT",
  [IcsRole.OPT_PARTICIPANT]: "OPT-PARTICIPANT",
  [IcsRole.NON_PARTICIPANT]: "NON-PARTICIPANT",
}

/**
 * A calendar address: a bare mailbox address, e.g. `jane@example.com`.
 *
 * A `mailto:` URI is not accepted here — the writer adds the scheme — because
 * the scheme is the only part RFC 5545 §3.8.4.3 permits and the parameter
 * form (`ORGANIZER;SENT-BY=...`) would otherwise be caller-supplied.
 */
export interface IcsAddress {
  /** Mailbox address without a `mailto:` scheme. */
  email: string
  /** Display name, emitted as an RFC 6868-escaped quoted `CN` parameter. */
  name?: string
}

/** One `ATTENDEE` property with its optional iTIP parameters. */
export interface IcsAttendee extends IcsAddress {
  /** Emitted as `RSVP=TRUE`; omitted entirely when `undefined`. */
  rsvp?: boolean
  /** Emitted as `PARTSTAT=<value>`. */
  partStat?: IcsPartStat
  /**
   * Emitted as `ROLE=<value>`; omitted for `REQ-PARTICIPANT`, which is RFC 5545's
   * default. An enum rather than a free string: the value lands in the parameter
   * list, where an interpolated `X;CN="Evil";RSVP=TRUE:mailto:attacker@…` would
   * forge parameters and replace the address.
   */
  role?: IcsRole
}

/**
 * The single VEVENT to serialise.
 *
 * `start` and `end` are absolute instants, not wall-clock strings: converting a
 * local date + time + IANA zone into an instant is `time/tz.ts`'s job
 * (`zonedDateTime`), and keeping it out of this module is what lets the writer
 * stay dependency-free. Times emitted are always UTC (`DTSTART:...Z`), which is
 * an absolute instant every calendar client renders in the viewer's own zone.
 */
export interface IcsEvent {
  /** Globally unique, stable identifier; emitted verbatim as `UID`. */
  uid: string
  /** Event start as an absolute instant; serialised to UTC `DTSTART`. */
  start: Date
  /** Event end as an absolute instant; serialised to UTC `DTEND`. */
  end: Date
  /** Emitted as `SUMMARY`. */
  summary: string
  /** Emitted as `DESCRIPTION` with TEXT escaping; omitted when empty. */
  description?: string
  /** Emitted as `LOCATION` with TEXT escaping; omitted when empty. */
  location?: string
  /** Emitted as `STATUS`; defaults to `CONFIRMED`. */
  status?: IcsEventStatus
  /** Emitted as `SEQUENCE`; omitted when `undefined`. */
  sequence?: number
  /** Emitted as `URL`; omitted when empty. */
  url?: string
  /** Emitted as `ORGANIZER`; omitted when `undefined`. */
  organizer?: IcsAddress
  /** Emitted as one `ATTENDEE` line each; omitted when empty. */
  attendees?: readonly IcsAttendee[]
}

/**
 * Calendar-level properties and the values this writer cannot infer.
 *
 * `dtstamp` is required rather than defaulted to `new Date()`: a writer that
 * reads the clock is untestable and produces a different document on every
 * call, which breaks idempotency for callers that store or diff the output.
 */
export interface IcsOptions {
  /** Emitted as `PRODID`, e.g. `-//example.com//app//EN`. */
  prodid: string
  /** Instant stamped into `DTSTAMP`; pass the same value for reproducible output. */
  dtstamp: Date
  /**
   * Emitted as `METHOD`; defaults to `REQUEST` for a `CONFIRMED` or `TENTATIVE`
   * event and `CANCEL` for a `CANCELLED` one. An explicit value that contradicts
   * `event.status` throws rather than emitting a contradictory document.
   *
   * Consequence worth knowing: only those two pairings are reachable, so
   * `IcsMethod.PUBLISH` and `IcsMethod.REPLY` cannot be combined with a VEVENT
   * here. A published event with no organizer is out of scope — add it as a
   * separate code path if a caller needs it, rather than relaxing the check and
   * letting a contradiction through.
   */
  method?: IcsMethod
}

/**
 * Look up a finite-constant enum's wire name, rejecting anything that is not a
 * member.
 *
 * The writer is called from JavaScript as often as from TypeScript, where the
 * enum is only a convention: `role: "X;CN=..."` or a missing key would otherwise
 * interpolate `undefined` — or the attacker's string — straight into the
 * parameter list.
 *
 * @throws {TypeError} for a value outside the enum.
 */
function enumName<T extends number>(names: Record<T, string>, value: T, property: string): string {
  const name = names[value]
  if (typeof name !== "string") {
    throw new TypeError(`${property} is not a recognised value: ${String(value)}`)
  }
  return name
}

/**
 * Validate a `SEQUENCE` value and return its decimal form.
 *
 * RFC 5545 §3.8.7.4 defines `SEQUENCE` as a non-negative integer. `NaN`,
 * `Infinity`, `1.5` and `-3` are all type-legal `number`s, so the compiler will
 * not stop them and they serialize to values a strict parser rejects; a JS
 * caller can pass a string, whose CRLF would forge a content line. Both are
 * rejected here rather than quietly written, the same rationale as
 * {@link enumName}.
 *
 * @throws {TypeError} for anything that is not a non-negative integer.
 */
function sequenceValue(sequence: number): string {
  if (
    typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 0 ||
    sequence > 2147483647
  ) {
    throw new TypeError(`event.sequence must be a non-negative integer: ${String(sequence)}`)
  }
  return String(sequence)
}

/** Default iTIP method implied by an event status. */
function defaultMethod(status: IcsEventStatus): IcsMethod {
  return status === IcsEventStatus.CANCELLED ? IcsMethod.CANCEL : IcsMethod.REQUEST
}

/**
 * Remove every control character from a value that occupies the property *value*
 * position and return `undefined` when nothing usable is left.
 *
 * This is stricter than `ics-core`'s `stripControlCharacters`, which
 * deliberately keeps LF and CR so RFC 5545 §3.1 folding still has them. A value
 * in the value position is never folded on its own line breaks: a surviving CR
 * or LF ends the content line and lets the rest of the value become a property
 * of the attacker's choosing. HTAB goes too — as a value's leading octet a
 * parser reads it back as a fold continuation.
 */
function sanitizeValue(value: string): string | undefined {
  const sanitized = [...value].filter((character) => {
    const code = character.codePointAt(0)!
    return code > 31 && code !== 127
  }).join("").trim()
  return sanitized === "" ? undefined : sanitized
}

/**
 * Normalise a mail address for the `mailto:` value of `ORGANIZER`/`ATTENDEE`.
 *
 * Addresses are emitted in the property *value* position, which no escaping
 * helper covers: a CR or LF that survives ends the content line and lets the
 * rest of the address become a property of its own
 * (`jane\r\nX-INJECTED:1@example.com` yields a real `X-INJECTED` property), and
 * a comma would turn one ATTENDEE into two addresses.
 *
 * @throws {TypeError} when nothing usable survives.
 */
function addressValue(address: IcsAddress, property: string): string {
  const value = sanitizeValue(address.email)
  if (value === undefined) {
    throw new TypeError(`${property} requires a non-empty email address`)
  }
  return value
}

/**
 * Build the `ORGANIZER` property for an address, quoting `CN` per RFC 5545
 * §3.2.5 and escaping it per RFC 6868.
 */
export function organizerLine(address: IcsAddress): string {
  const parameters = address.name ? `;CN="${icsEscapeParameter(address.name)}"` : ""
  return `ORGANIZER${parameters}:mailto:${addressValue(address, "ORGANIZER")}`
}

/**
 * Build the `ATTENDEE` property for an attendee, including whichever of
 * `CN`, `ROLE`, `PARTSTAT` and `RSVP` the caller supplied.
 */
export function attendeeLine(attendee: IcsAttendee): string {
  let parameters = ""
  if (attendee.name) parameters += `;CN="${icsEscapeParameter(attendee.name)}"`
  // REQ-PARTICIPANT is RFC 5545's default, so it emits no parameter.
  if (attendee.role !== undefined && attendee.role !== IcsRole.REQ_PARTICIPANT) {
    parameters += `;ROLE=${enumName(ROLE_NAMES, attendee.role, "attendee.role")}`
  }
  if (attendee.partStat !== undefined) {
    parameters += `;PARTSTAT=${enumName(PARTSTAT_NAMES, attendee.partStat, "attendee.partStat")}`
  }
  if (attendee.rsvp !== undefined) parameters += `;RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}`
  return `ATTENDEE${parameters}:mailto:${addressValue(attendee, "ATTENDEE")}`
}

/**
 * Normalise a `UID` value.
 *
 * `UID` is a TEXT property, but escaping it would change the identifier the
 * caller hands out — a UID containing `,` would come back as a different string
 * on the next envelope. Every control character is dropped instead, CR and LF
 * included: a UID of `abc\r\nUID:forged` would otherwise emit a second, forged
 * `UID` line, and a `UID` is not a value that can legitimately contain a line
 * break, so nothing of value is lost. Every other octet is preserved verbatim,
 * which keeps the identifier byte-exact across envelopes.
 *
 * @throws {TypeError} when nothing usable survives the filter.
 */
function uidValue(uid: string): string {
  const value = sanitizeValue(uid)
  if (value === undefined) {
    throw new TypeError("event.uid is required")
  }
  return value
}

/**
 * Build the VEVENT property lines, in RFC 5545 §3.6.1 order.
 *
 * Throws on a missing `uid`, an invalid `start`/`end`, an `end` at or before
 * `start`, or on any optional TEXT property whose value cannot round-trip —
 * an explicit throw beats a silently malformed calendar a client drops.
 */
export function buildVEventLines(event: IcsEvent, dtstamp: Date, method: IcsMethod): string[] {
  if (Number.isNaN(event.start.getTime()) || Number.isNaN(event.end.getTime())) {
    throw new TypeError("event.start and event.end must be valid Dates")
  }
  if (event.end.getTime() <= event.start.getTime()) {
    throw new RangeError("event.end must be after event.start")
  }

  const status = event.status ?? IcsEventStatus.CONFIRMED
  const statusName = enumName(STATUS_NAMES, status, "event.status")
  const expected = defaultMethod(status)
  if (method !== expected) {
    throw new TypeError(
      `method ${enumName(METHOD_NAMES, method, "method")} contradicts a ${statusName} event; ` +
        `use ${enumName(METHOD_NAMES, expected, "method")}`,
    )
  }

  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${uidValue(event.uid)}`,
    `DTSTAMP:${formatIcsUtc(dtstamp)}`,
    `DTSTART:${formatIcsUtc(event.start)}`,
    `DTEND:${formatIcsUtc(event.end)}`,
    `SUMMARY:${icsEscape(event.summary)}`,
  ]

  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`)
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`)
  if (event.url) lines.push(`URL:${icsEscape(event.url)}`)
  if (event.organizer) lines.push(organizerLine(event.organizer))
  for (const attendee of event.attendees ?? []) lines.push(attendeeLine(attendee))
  lines.push(
    `STATUS:${statusName}`,
    "TRANSP:OPAQUE",
  )
  if (event.sequence !== undefined) lines.push(`SEQUENCE:${sequenceValue(event.sequence)}`)
  lines.push("END:VEVENT")
  return lines
}

/**
 * Serialise one event into a complete iCalendar document.
 *
 * The result is CRLF-separated, folded to 75 octets per physical line, and
 * terminated by a trailing CRLF. Every property value is escaped, so untrusted
 * user input (a name, a note, a location) cannot inject a property.
 *
 * @throws {TypeError} when a required value is missing or an email address is empty.
 * @throws {RangeError} when `end` is not after `start`.
 */
export function generateIcs(event: IcsEvent, options: IcsOptions): string {
  const prodid = options.prodid.trim()
  if (prodid === "") {
    throw new TypeError("options.prodid is required")
  }
  if (Number.isNaN(options.dtstamp.getTime())) {
    throw new TypeError("options.dtstamp must be a valid Date")
  }
  const status = event.status ?? IcsEventStatus.CONFIRMED
  const method = options.method ?? defaultMethod(status)

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    `PRODID:${icsEscape(prodid)}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${enumName(METHOD_NAMES, method, "method")}`,
    ...buildVEventLines(event, options.dtstamp, method),
    "END:VCALENDAR",
  ]

  return joinContentLines(lines)
}
