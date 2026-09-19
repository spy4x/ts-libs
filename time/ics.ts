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

import {
  type ContentLine,
  formatIcsUtc,
  icsEscape,
  icsEscapeParameter,
  joinContentLines,
  stripControlCharacters,
} from "./ics-core.ts"

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
  /** Emitted as `ROLE=<value>`, already in RFC 5545 form, e.g. `REQ-PARTICIPANT`. */
  role?: string
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
   * Emitted as `METHOD`; defaults to `REQUEST` for a `CONFIRMED` event and
   * `CANCEL` for a `CANCELLED` one. An explicit value that contradicts
   * `event.status` throws rather than emitting a document clients ignore.
   */
  method?: IcsMethod
}

/** Default iTIP method implied by an event status. */
function defaultMethod(status: IcsEventStatus): IcsMethod {
  return status === IcsEventStatus.CANCELLED ? IcsMethod.CANCEL : IcsMethod.REQUEST
}

/**
 * Strip control characters from a mail address and reject an empty result.
 *
 * Addresses are emitted in the property *value* position (`mailto:...`), which
 * no escaping helper covers: a CR or LF that survives into the value ends the
 * content line and lets the rest of the address become a property of its own
 * (`jane\r\nX-INJECTED:1@example.com` yields a real `X-INJECTED` property), and
 * a comma would turn one ATTENDEE into two addresses. HTAB is allowed — but as
 * a value's leading octet it would be read back as a fold continuation, so
 * nothing in the C0 range survives here.
 */
function addressValue(address: IcsAddress, property: string): string {
  const value = [...address.email].filter((character) => {
    const code = character.codePointAt(0)!
    return code > 31 && code !== 127
  }).join("").trim()
  if (value === "") {
    throw new TypeError(`${property} requires a non-empty email address`)
  }
  return value
}

/**
 * Build the `ORGANIZER` property for an address, quoting `CN` per RFC 5545
 * §3.2.5 and escaping it per RFC 6868.
 */
export function organizerLine(address: IcsAddress): ContentLine {
  const parameters = address.name ? `;CN="${icsEscapeParameter(address.name)}"` : ""
  return `ORGANIZER${parameters}:mailto:${addressValue(address, "ORGANIZER")}`
}

/**
 * Build the `ATTENDEE` property for an attendee, including whichever of
 * `CN`, `ROLE`, `PARTSTAT` and `RSVP` the caller supplied.
 */
export function attendeeLine(attendee: IcsAttendee): ContentLine {
  let parameters = ""
  if (attendee.name) parameters += `;CN="${icsEscapeParameter(attendee.name)}"`
  if (attendee.role) parameters += `;ROLE=${attendee.role}`
  if (attendee.partStat !== undefined) {
    parameters += `;PARTSTAT=${PARTSTAT_NAMES[attendee.partStat]}`
  }
  if (attendee.rsvp !== undefined) parameters += `;RSVP=${attendee.rsvp ? "TRUE" : "FALSE"}`
  return `ATTENDEE${parameters}:mailto:${addressValue(attendee, "ATTENDEE")}`
}

/**
 * Normalise a `UID` value.
 *
 * `UID` is a TEXT property, but escaping it would change the identifier the
 * caller hands out — a UID containing `,` would come back as a different string
 * on the next envelope. Control characters are stripped instead, which is all
 * that is needed to make the value safe on one content line.
 */
function uidValue(uid: string): string {
  const value = stripControlCharacters(uid).trim()
  if (value === "") {
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
export function buildVEventLines(event: IcsEvent, dtstamp: Date, method: IcsMethod): ContentLine[] {
  if (Number.isNaN(event.start.getTime()) || Number.isNaN(event.end.getTime())) {
    throw new TypeError("event.start and event.end must be valid Dates")
  }
  if (event.end.getTime() <= event.start.getTime()) {
    throw new RangeError("event.end must be after event.start")
  }

  const status = event.status ?? IcsEventStatus.CONFIRMED
  const expected = defaultMethod(status)
  if (method !== expected) {
    throw new TypeError(
      `method ${METHOD_NAMES[method]} contradicts a ${STATUS_NAMES[status]} event; ` +
        `use ${METHOD_NAMES[expected]}`,
    )
  }

  const lines: ContentLine[] = [
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
    `STATUS:${STATUS_NAMES[status]}`,
    "TRANSP:OPAQUE",
  )
  if (event.sequence !== undefined) lines.push(`SEQUENCE:${event.sequence}`)
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

  const lines: ContentLine[] = [
    "BEGIN:VCALENDAR",
    `PRODID:${icsEscape(prodid)}`,
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${METHOD_NAMES[method]}`,
    ...buildVEventLines(event, options.dtstamp, method),
    "END:VCALENDAR",
  ]

  return joinContentLines(lines)
}
