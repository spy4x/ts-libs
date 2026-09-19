/**
 * RFC 5545 iCalendar builder and parser for the CalDAV wire code.
 *
 * Ported from `caldav-mcp/caldav/ical.ts` (issue #13). The wire primitives —
 * 75-octet folding, unfolding and TEXT escaping — are **not** re-implemented
 * here: they are imported from `@ts-libs/time/ics-core`, the module `#3`/`#26`
 * extracted for exactly this reason. The source carried its own
 * character-counted `foldLine` (`line.length`, `slice(i, i + 75)`), which splits
 * a multi-byte UTF-8 sequence across a fold and emits a document no conforming
 * parser can read; that is the bug the shared core fixes.
 *
 * Bugs fixed at extraction time (source line numbers in the PR body):
 *
 *  - `CATEGORIES` splitting ignored escaping, so a category containing a comma
 *    (`a\,b`) came back as two categories.
 *  - `escapeICal` left CR and every other C0 control character in the value, and
 *    the component builders wrote a `UID` and a `RELATED-TO` uid through a
 *    hand-rolled escape chain that did the same, so a value in the property
 *    position could end its own content line.
 *  - a `STATUS` outside the RFC's four values was reported as `NEEDS-ACTION`,
 *    telling a caller an unknown-status task was open.
 *  - the fallback resource URL interpolated the `UID` unencoded and assumed a
 *    trailing slash, so a UID containing a slash or a dot changed the URL shape.
 *  - `fromICalDate("")` returned the *current* time, so a task with no `DUE`
 *    acquired one, and `fromICalDate("banana")` returned `"bana-na-"`: it sliced
 *    fixed offsets and validated nothing.
 *
 * Out of scope, as in the source (documented in `caldav/README.md`):
 * RRULE/EXDATE/RECURRENCE-ID, VTIMEZONE/TZID, VALARM/DURATION, and *any* form of
 * recurrence expansion. `parseIcal` keeps the **first** occurrence of a repeated
 * property in `data` and makes every occurrence available in `properties`.
 */

import {
  formatIcsUtc,
  icsEscape,
  icsUnescape,
  joinContentLines,
  unfoldLines,
} from "@ts-libs/time/ics-core"
import { sameOrigin } from "./origin.ts"
import {
  CalDavErrorCode,
  type CalDavResult,
  ComponentType,
  ComponentTypeLabel,
  type Event,
  fail,
  LabelRelatedType,
  LabelTodoStatus,
  ok,
  type RelatedTo,
  RelatedType,
  RelatedTypeLabel,
  reshapeFailure,
  type Todo,
  TodoStatusLabel,
} from "./types.ts"

/** The `PRODID` emitted when a caller does not supply one. */
export const DEFAULT_PRODID = "-//ts-libs//caldav//EN"

/** The two component kinds this module reads and writes. */
export type IcalComponent = ComponentType.VTODO | ComponentType.VEVENT

/** How a `DUE`/`DTSTART` value is typed on the wire, RFC 5545 §3.3.4. */
export enum CalDavDateValue {
  /** `VALUE=DATE`, a whole day: `20260701`. */
  DATE = 1,
  /** `VALUE=DATE-TIME`, an instant: `20260701T120000Z`, or floating without the `Z`. */
  DATE_TIME = 2,
}

/** A parsed date value: its ISO 8601 form and how it was typed on the wire. */
export interface CalDavDate {
  /** ISO 8601. `YYYY-MM-DD` for a `DATE`, otherwise a date-time keeping any `Z`. */
  iso: string
  /** Which wire form the value had. */
  value: CalDavDateValue
}

/**
 * One content line of a component, split into name, parameters and value.
 *
 * The source model was a single `data: Record<string, string>` keyed by bare
 * property name, which loses the parameters. Keeping them is what lets
 * `DUE;VALUE=DATE` stay a whole day instead of becoming a midnight instant.
 */
export interface IcalProperty {
  /** Property name, upper-cased: `DUE`. */
  name: string
  /** Parameters, upper-cased names with unquoted values: `{ VALUE: "DATE" }`. */
  params: Record<string, string>
  /** Value with RFC 5545 TEXT escapes decoded. */
  value: string
  /** The content line after unfolding, escapes intact. */
  raw: string
}

/** A parsed `VTODO` or `VEVENT` block. */
export interface ParsedIcal {
  /** Which component this block is. */
  component: IcalComponent
  /**
   * First occurrence of each property, keyed by upper-cased name, unescaped.
   * The source's shape, kept so callers can index `data["SUMMARY"]`.
   */
  data: Record<string, string>
  /** Every property in document order, duplicates included. */
  properties: IcalProperty[]
  /** The component block after unfolding, escapes intact. */
  rawBlock: string
}

/** A property the parser read but could not interpret. */
export interface IcalIssue {
  /** Upper-cased property name, e.g. `DUE`. */
  property: string
  /** The value as it appeared, escapes decoded. */
  value: string
  /** Why it was unusable. */
  message: string
}

/**
 * A successful {@link parseIcal} result.
 *
 * `issues` is how a present-but-unusable value is reported: `DUE:not-a-date`
 * must not be indistinguishable from a task with no `DUE`, and must not fail the
 * whole document either.
 */
export interface ParsedIcalDocument {
  /** One entry per `VTODO`/`VEVENT` block, in document order. */
  components: ParsedIcal[]
  /** Values read but not interpretable; empty when the document is clean. */
  issues: IcalIssue[]
  /**
   * Structural oddities that did not prevent parsing — a content line with no
   * `:` separator, or a block whose component kind is not read by this module.
   */
  warnings: string[]
}

/** Caller-supplied values a builder cannot infer; all optional. */
export interface IcalBuildOptions {
  /** `UID`; generated with `crypto.randomUUID()` when absent. */
  uid?: string
  /** `DTSTAMP` instant; defaults to {@link IcalBuildOptions.now}. */
  dtstamp?: Date
  /** Clock read for `DTSTAMP` when `dtstamp` is absent. Injected for determinism. */
  now?: Date
  /** `PRODID`; defaults to {@link DEFAULT_PRODID}. */
  prodid?: string
}

/** Fields describing a `VTODO` to write. */
export interface TodoIcalInput {
  /** `SUMMARY`; required, empty is rejected. */
  summary: string
  /** `DESCRIPTION`, escaped as TEXT. */
  description?: string
  /** `CATEGORIES`; each item escaped, joined with commas. */
  categories?: readonly string[]
  /** `STATUS`; a {@link TodoStatusLabel} name. Defaults to `NEEDS-ACTION`. */
  status?: string
  /** `PRIORITY` 1-9; a value outside the range is omitted, per RFC 5545 §3.8.1.9. */
  priority?: number
  /** `DUE` as an ISO 8601 date or date-time; the `VALUE` parameter follows the input. */
  due?: string
  /** `PERCENT-COMPLETE`; clamped to 0-100. */
  percentComplete?: number
  /** `RELATED-TO` edges, each emitted with its `RELTYPE`. */
  relatedTo?: readonly RelatedTo[]
}

/** Fields describing a `VEVENT` to write. */
export interface EventIcalInput {
  /** `SUMMARY`; required, empty is rejected. */
  summary: string
  /** `DTSTART` as an ISO 8601 date-time string. */
  start: string
  /** `DTEND` as an ISO 8601 date-time string; must not precede `start`. */
  end: string
  /** `DESCRIPTION`, escaped as TEXT. */
  description?: string
  /** `LOCATION`, escaped as TEXT. */
  location?: string
  /** `STATUS`; emitted only when supplied. */
  status?: string
}

/** Options accepted by {@link parseTodos} and {@link parseEvents}. */
export interface ParseOptions {
  /** `displayName` of the collection the text came from. */
  calendarName?: string
  /**
   * Absolute URL of the collection, used to derive a resource URL.
   *
   * Also the only origin a component's `URL` property may point at: a declared
   * URL on another origin is ignored and reported in `issues` (see
   * {@link resourceUrl}). Omitting it means no origin can be proven, so a
   * declared absolute `URL` is ignored for every component.
   */
  calendarUrl?: string
  /** `UID` → `getetag` map, as extracted from the REPORT response. */
  etags?: ReadonlyMap<string, string>
}

/**
 * Validate a required TEXT field and return its escaped form.
 *
 * @throws {TypeError} when the value is empty or entirely whitespace. A blank
 * `SUMMARY:` line is legal iCalendar but leaves a caller unable to tell a blank
 * task from a missing one, so it is rejected at the writer instead.
 */
function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} is required`)
  }
  return icsEscape(value)
}

/** True for a whole-day ISO 8601 value, `YYYY-MM-DD`, with no time part. */
function isDateOnly(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso)
}

/** True when (year, month, day) names a day that exists in the Gregorian calendar. */
function isRealDate(year: number, month: number, day: number): boolean {
  const instant = new Date(Date.UTC(year, month - 1, day))
  return instant.getUTCFullYear() === year && instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
}

/**
 * Format an ISO 8601 string as a CalDAV DATE-TIME value, `YYYYMMDDTHHMMSSZ`.
 *
 * The maths is `time/ics-core`'s `formatIcsUtc`; this wrapper only parses the
 * ISO input and rejects what it cannot.
 *
 * @throws {TypeError} when the input is not a parseable date. A whole-day value
 * is accepted and promoted to midnight UTC, because the `VALUE=DATE` form
 * belongs to {@link toCalDavDateValue} and a caller reaching here has asked for
 * an instant.
 */
export function toCalDavDate(iso: string): string {
  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError(`not a valid date: ${JSON.stringify(iso)}`)
  }
  return formatIcsUtc(instant)
}

/**
 * Format an ISO 8601 string as a CalDAV value plus its `VALUE` parameter.
 *
 * `2026-07-01` becomes `{ value: "20260701", parameter: DATE }`; anything else
 * becomes a UTC `DATE-TIME` carrying no parameter, because `DATE-TIME` is the
 * RFC 5545 default and an explicit `VALUE=DATE-TIME` on every line is noise
 * some servers reject.
 *
 * @throws {TypeError} when the input is not a parseable date.
 */
export function toCalDavDateValue(iso: string): { value: string; parameter?: CalDavDateValue } {
  if (isDateOnly(iso)) {
    const [year, month, day] = iso.split("-") as [string, string, string]
    if (!isRealDate(Number(year), Number(month), Number(day))) {
      throw new TypeError(`not a valid date: ${JSON.stringify(iso)}`)
    }
    return { value: `${year}${month}${day}`, parameter: CalDavDateValue.DATE }
  }
  return { value: toCalDavDate(iso), parameter: CalDavDateValue.DATE_TIME }
}

/**
 * Render a `DUE` content line, choosing `VALUE=DATE` for a whole-day input.
 *
 * @throws {TypeError} when the input is not a parseable date.
 */
export function dueLine(iso: string): string {
  const { value, parameter } = toCalDavDateValue(iso)
  const marker = parameter === CalDavDateValue.DATE ? ";VALUE=DATE" : ""
  return `DUE${marker}:${value}`
}

/**
 * Convert a CalDAV `DUE`/`DTSTART` value back to ISO 8601.
 *
 * A `VALUE=DATE` value stays `YYYY-MM-DD`; a `DATE-TIME` keeps the `Z` when it
 * was UTC and has no suffix when it was floating, which is what RFC 5545 means
 * by a time with neither `Z` nor `TZID`. The source appended `Z` only when the
 * input happened to contain one, so a floating time became a UTC one on the
 * round trip, and it blanked an empty input to *now*, so a task with no due date
 * acquired one.
 *
 * @returns `undefined` for an empty or unparseable value, so the caller can
 * report an {@link IcalIssue} instead of inventing a date.
 */
export function fromCalDavDateValue(value: string, parameter?: string): CalDavDate | undefined {
  const trimmed = value.trim()
  if (trimmed === "") return undefined

  // A whole-day value arrives as `YYYYMMDD`, and a value read back out of this
  // package's own `DUE`/`DTSTART` handling arrives as the ISO form `YYYY-MM-DD`;
  // both mean VALUE=DATE. Accepting only the compact form is how a date-only
  // `DUE` came back as absent.
  const dateOnly = parameter?.toUpperCase() === "DATE" ||
    /^\d{8}$/.test(trimmed) ||
    isDateOnly(trimmed)
  if (dateOnly) {
    const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(trimmed)
    if (!match) return undefined
    const [, year, month, day] = match as unknown as [string, string, string, string]
    if (!isRealDate(Number(year), Number(month), Number(day))) return undefined
    return { iso: `${year}-${month}-${day}`, value: CalDavDateValue.DATE }
  }

  const match = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})(Z)?$/.exec(trimmed)
  if (!match) return undefined
  const [, year, month, day, hour, minute, second, zulu] = match as unknown as string[]
  if (
    !isRealDate(Number(year), Number(month), Number(day)) ||
    Number(hour) > 23 || Number(minute) > 59 || Number(second) > 60
  ) {
    return undefined
  }
  return {
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${zulu ? "Z" : ""}`,
    value: CalDavDateValue.DATE_TIME,
  }
}

/**
 * Locate the colon separating a property's name-and-parameters from its value.
 *
 * RFC 5545 §3.1 lets a value contain a colon, and a colon inside a TEXT value may
 * itself be escaped, so the separator is the first colon not preceded by an odd
 * number of backslashes.
 *
 * The simpler `indexOf(":")` the source used is correct for every value a real
 * server sends — the RFC forbids escaping a colon in a *value*, and a *name*
 * cannot contain one — so this is a hardening choice rather than a bug fix: it
 * costs one pass over the name-and-parameters prefix, which is short, and it
 * removes the need to reason about whether a backslash `indexOf` did not account
 * for was an escape.
 *
 * @returns the index, or `-1` when the line carries no separator at all and is
 * therefore not a property.
 */
export function findPropertySeparator(line: string): number {
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== ":") continue
    let backslashes = 0
    for (let back = index - 1; back >= 0 && line[back] === "\\"; back--) backslashes++
    if (backslashes % 2 === 0) return index
  }
  return -1
}

/**
 * Split a property's name-and-parameters prefix into its name and parameters.
 *
 * Parameters are `;`-separated and a quoted parameter value may itself contain a
 * `;` or a `:` (RFC 5545 §3.1), so the split tracks quoting. A quoted value is
 * unquoted; RFC 6868 caret escapes are deliberately left intact because nothing
 * in this package interprets a parameter's *value*.
 */
export function parsePropertyPrefix(prefix: string): {
  name: string
  params: Record<string, string>
} {
  const segments: string[] = []
  let segment = ""
  let quoted = false
  for (const character of prefix) {
    if (character === '"') quoted = !quoted
    if (character === ";" && !quoted) {
      segments.push(segment)
      segment = ""
      continue
    }
    segment += character
  }
  segments.push(segment)

  const name = (segments.shift() ?? "").trim().toUpperCase()
  const params: Record<string, string> = {}
  for (const parameter of segments) {
    const equals = parameter.indexOf("=")
    if (equals === -1) continue
    const key = parameter.slice(0, equals).trim().toUpperCase()
    if (key === "") continue
    let value = parameter.slice(equals + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    params[key] = value
  }
  return { name, params }
}

/**
 * Split a TEXT list on its unescaped commas.
 *
 * `icsEscape` escapes a comma inside an item as `\,`, so a naive `split(",")`
 * turns one category into two. This is the inverse of the join the writer does,
 * and the two are tested against each other *and* against a literal fixture
 * written by hand, so a symmetrically wrong pair cannot pass.
 */
export function splitEscapedList(value: string): string[] {
  const items: string[] = []
  let item = ""
  let index = 0
  while (index < value.length) {
    const character = value[index]!
    if (character === "\\" && index + 1 < value.length) {
      item += character + value[index + 1]!
      index += 2
      continue
    }
    if (character === ",") {
      items.push(item)
      item = ""
      index++
      continue
    }
    item += character
    index++
  }
  items.push(item)
  return items.filter((entry) => entry.trim() !== "")
}

/** Render the `STATUS` value for a todo, defaulting to `NEEDS-ACTION`. */
function todoStatusValue(status: string | undefined): string {
  return status === undefined || status === "" ? TodoStatusLabel[1] : status
}

/** Join escaped category items into a `CATEGORIES` value. */
export function categoriesValue(categories: readonly string[]): string {
  return categories.map((category) => icsEscape(category)).join(",")
}

/**
 * Render one `RELATED-TO` line from a {@link RelatedTo} edge.
 *
 * The `UID` is escaped with `time/ics-core`'s `icsEscape`, exactly like every
 * other TEXT value this module writes. A hand-rolled `\`, `;`, `,` chain is not
 * equivalent: it leaves CR, LF and the rest of C0 in place, so a UID of
 * `"a\r\nSUMMARY:INJECTED"` closes the `RELATED-TO` line and opens a second
 * content line — a property the caller never asked for, written to the server by
 * `PUT`. `icsEscape` strips those characters *and* escapes the three listed
 * ones, and it is the same function `time/ics.ts` uses, so there is one
 * definition rather than two.
 *
 * @throws {TypeError} when `reltype` is not a recognised {@link RelatedType}.
 */
export function relatedToLine(relation: RelatedTo): string {
  const label = RelatedTypeLabel[relation.reltype]
  if (typeof label !== "string") {
    throw new TypeError(`relatedTo.reltype is not a recognised value: ${String(relation.reltype)}`)
  }
  const uid = requiredText(relation.uid, "relatedTo.uid")
  return `RELATED-TO;RELTYPE=${label}:${uid}`
}

/** Wrap component lines in a `VCALENDAR` envelope and fold every line. */
function wrapCalendar(lines: readonly string[], prodid: string): string {
  return joinContentLines([
    "BEGIN:VCALENDAR",
    `PRODID:${icsEscape(prodid)}`,
    "VERSION:2.0",
    ...lines,
    "END:VCALENDAR",
  ])
}

/** Resolve the `UID` and `DTSTAMP` a builder needs, honouring the injected clock. */
function identity(options: IcalBuildOptions): { uid: string; dtstamp: Date } {
  const uid = options.uid ?? crypto.randomUUID()
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new TypeError("options.uid must be a non-empty string")
  }
  const dtstamp = options.dtstamp ?? options.now ?? new Date()
  if (Number.isNaN(dtstamp.getTime())) {
    throw new TypeError("options.dtstamp must be a valid Date")
  }
  return { uid: uid.trim(), dtstamp }
}

/**
 * Serialise a `VTODO` into a complete iCalendar document.
 *
 * The `DTSTAMP` is `formatIcsUtc`'s output, so the value always ends in `Z` with
 * no fractional seconds and never depends on the host's timezone.
 *
 * @throws {TypeError} when `summary` is empty, `priority` or `percentComplete`
 * is not a number, or `due` is not a parseable date.
 */
export function buildTodoIcal(todo: TodoIcalInput, options: IcalBuildOptions = {}): string {
  const { uid, dtstamp } = identity(options)
  const status = todoStatusValue(todo.status)

  const lines: string[] = [
    "BEGIN:VTODO",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${formatIcsUtc(dtstamp)}`,
    `SUMMARY:${requiredText(todo.summary, "todo.summary")}`,
    `STATUS:${icsEscape(status)}`,
  ]
  if (todo.description) lines.push(`DESCRIPTION:${icsEscape(todo.description)}`)
  if (todo.categories && todo.categories.length > 0) {
    lines.push(`CATEGORIES:${categoriesValue(todo.categories)}`)
  }
  if (todo.due) lines.push(dueLine(todo.due))
  // RFC 5545 §3.8.1.9: PRIORITY is 0-9, where 0 means "undefined priority", so a
  // value outside 1-9 is omitted rather than written as a number no client reads.
  if (todo.priority !== undefined && Number.isInteger(todo.priority)) {
    if (todo.priority >= 1 && todo.priority <= 9) lines.push(`PRIORITY:${todo.priority}`)
  }
  if (todo.percentComplete !== undefined) {
    if (!Number.isFinite(todo.percentComplete)) {
      throw new TypeError("todo.percentComplete must be a finite number")
    }
    const clamped = Math.max(0, Math.min(100, Math.round(todo.percentComplete)))
    lines.push(`PERCENT-COMPLETE:${clamped}`)
  }
  for (const relation of todo.relatedTo ?? []) lines.push(relatedToLine(relation))
  lines.push("END:VTODO")

  return wrapCalendar(lines, options.prodid ?? DEFAULT_PRODID)
}

/**
 * Serialise a `VEVENT` into a complete iCalendar document.
 *
 * @throws {TypeError} when `summary` is empty or `start`/`end` is not a
 * parseable date, and {@link RangeError} when `end` precedes `start`.
 */
export function buildEventIcal(event: EventIcalInput, options: IcalBuildOptions = {}): string {
  const { uid, dtstamp } = identity(options)
  const start = new Date(event.start)
  const end = new Date(event.end)
  if (Number.isNaN(start.getTime())) {
    throw new TypeError(`event.start is not a valid date: ${JSON.stringify(event.start)}`)
  }
  if (Number.isNaN(end.getTime())) {
    throw new TypeError(`event.end is not a valid date: ${JSON.stringify(event.end)}`)
  }
  if (end.getTime() < start.getTime()) {
    throw new RangeError("event.end must not precede event.start")
  }

  const lines: string[] = [
    "BEGIN:VEVENT",
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${formatIcsUtc(dtstamp)}`,
    `SUMMARY:${requiredText(event.summary, "event.summary")}`,
    `DTSTART:${formatIcsUtc(start)}`,
    `DTEND:${formatIcsUtc(end)}`,
  ]
  if (event.description) lines.push(`DESCRIPTION:${icsEscape(event.description)}`)
  if (event.location) lines.push(`LOCATION:${icsEscape(event.location)}`)
  if (event.status) lines.push(`STATUS:${icsEscape(event.status)}`)
  lines.push("END:VEVENT")

  return wrapCalendar(lines, options.prodid ?? DEFAULT_PRODID)
}

/**
 * Parse every `VTODO` and `VEVENT` block out of iCalendar text.
 *
 * Content lines are unfolded through `time/ics-core`'s `unfoldLines` *before*
 * any value is unescaped: unfolding a value that still contains `\n` escapes
 * cannot corrupt it, whereas unescaping first would turn an escaped newline
 * inside a folded value into a real line break and split one property into two.
 *
 * @returns a failure when the text is empty, is not a string, contains no
 * component, or has a structural fault — an unclosed component, a mismatched
 * `END`, an `END` with no `BEGIN`, or a `BEGIN:VCALENDAR` with no matching
 * `END:VCALENDAR`. A property line without a separator is a warning instead,
 * because a real server can append non-property noise without the document
 * becoming unusable.
 */
export function parseIcal(text: string): CalDavResult<ParsedIcalDocument> {
  if (typeof text !== "string" || text.trim() === "") {
    return fail(CalDavErrorCode.INVALID_ARGUMENT, "iCalendar text is empty")
  }

  const unfolded = unfoldLines(text)
  const components: ParsedIcal[] = []
  const issues: IcalIssue[] = []
  const warnings: string[] = []

  let openComponent: IcalComponent | undefined
  let openLines: string[] = []
  let insideCalendar = false
  let sawAnyComponent = false

  const lines = unfolded.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trimEnd()
    if (line.trim() === "") continue

    const separator = findPropertySeparator(line)
    if (separator === -1) {
      warnings.push(`line ${index + 1} has no property separator: ${line.slice(0, 60)}`)
      continue
    }
    const { name, params } = parsePropertyPrefix(line.slice(0, separator))
    const rawValue = line.slice(separator + 1)
    const value = icsUnescape(rawValue)

    if (name === "BEGIN") {
      const kind = value.trim().toUpperCase()
      if (kind === "VCALENDAR") {
        insideCalendar = true
        continue
      }
      if (kind === "VTODO" || kind === "VEVENT") {
        if (openComponent !== undefined) {
          return fail(
            CalDavErrorCode.PARSE,
            `BEGIN:${kind} at line ${index + 1} opens inside an unclosed ${
              componentLabel(openComponent)
            }`,
          )
        }
        openComponent = kind === "VTODO" ? ComponentType.VTODO : ComponentType.VEVENT
        openLines = []
        continue
      }
      warnings.push(`line ${index + 1} opens unsupported component ${kind}`)
      continue
    }

    if (name === "END") {
      const kind = value.trim().toUpperCase()
      if (kind === "VCALENDAR") {
        if (openComponent !== undefined) {
          return fail(
            CalDavErrorCode.PARSE,
            `END:VCALENDAR at line ${index + 1} closes an unclosed ${
              componentLabel(openComponent)
            }`,
          )
        }
        insideCalendar = false
        continue
      }
      if (kind === "VTODO" || kind === "VEVENT") {
        if (openComponent === undefined) {
          return fail(
            CalDavErrorCode.PARSE,
            `END:${kind} at line ${index + 1} has no matching BEGIN`,
          )
        }
        if (componentLabel(openComponent) !== kind) {
          return fail(
            CalDavErrorCode.PARSE,
            `END:${kind} at line ${index + 1} closes a ${componentLabel(openComponent)}`,
          )
        }
        const block = parseComponentBlock(openComponent, openLines)
        components.push(block)
        sawAnyComponent = true
        openComponent = undefined
        openLines = []
        continue
      }
      warnings.push(`line ${index + 1} closes unsupported component ${kind}`)
      continue
    }

    if (openComponent === undefined) {
      if (!insideCalendar) {
        return fail(
          CalDavErrorCode.PARSE,
          `property ${name} at line ${index + 1} is outside any component`,
        )
      }
      continue
    }

    openLines.push(line)
    if (name === "DUE" || name === "DTSTART" || name === "DTEND" || name === "COMPLETED") {
      const parsed = fromCalDavDateValue(value, params["VALUE"])
      if (parsed === undefined) {
        issues.push({
          property: name,
          value,
          message: "not a valid RFC 5545 DATE or DATE-TIME value",
        })
      }
    }
  }

  if (openComponent !== undefined) {
    return fail(
      CalDavErrorCode.PARSE,
      `${componentLabel(openComponent)} is never closed by an END line`,
    )
  }
  if (insideCalendar) {
    return fail(CalDavErrorCode.PARSE, "VCALENDAR is never closed by END:VCALENDAR")
  }
  if (!sawAnyComponent) {
    const detail = warnings.length === 0 ? "" : ` (${warnings.slice(0, 3).join("; ")})`
    return fail(CalDavErrorCode.PARSE, `no VTODO or VEVENT component found${detail}`)
  }

  return ok({ components, issues, warnings })
}

/** Build a {@link ParsedIcal} from the content lines between `BEGIN` and `END`. */
function parseComponentBlock(
  component: IcalComponent,
  lines: readonly string[],
): ParsedIcal {
  const properties: IcalProperty[] = []
  const data: Record<string, string> = {}
  for (const line of lines) {
    const separator = findPropertySeparator(line)
    if (separator === -1) continue
    const { name, params } = parsePropertyPrefix(line.slice(0, separator))
    if (name === "") continue
    const value = icsUnescape(line.slice(separator + 1)).trim()
    properties.push({ name, params, value, raw: line })
    // First occurrence wins, matching the source: `parseIcal` keeps one value
    // per property and `properties` carries the rest. A repeated `RELATED-TO`
    // is read from `properties`, which is why it does not lose edges.
    if (data[name] === undefined) data[name] = value
  }
  return {
    component,
    data,
    properties,
    rawBlock: [`BEGIN:${componentLabel(component)}`, ...lines, `END:${componentLabel(component)}`]
      .join("\r\n"),
  }
}

/** Upper-cased label for a component kind, without the enum indirection. */
function componentLabel(component: IcalComponent): string {
  return ComponentTypeLabel[component]
}

/** Normalise a collection URL to end in exactly one slash. */
function withTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`
}

/**
 * Derive a resource URL for a component, preferring the component's own `URL`.
 *
 * The source built `${baseUrl}${uid}.ics` unconditionally: a base URL without a
 * trailing slash produced `https://host/caluser.ics`, and a `UID` containing a
 * slash or a `?` rewrote the path or started a query. Here the UID is
 * percent-encoded and the base is normalised, so the URL's shape depends only on
 * the base's path.
 *
 * **A declared `URL` is a server-named URL, so it is honoured only where it can
 * be shown to resolve onto the calendar's own origin.** An absolute URL must
 * share an `http(s)` origin with `calendarUrl`; a rooted path (`/dav/u.ics`) is
 * *resolved* against `calendarUrl` and kept only when the result is on that
 * origin — which is what separates it from the network-path reference
 * `//attacker.example.net/u.ics`, another origin wearing the same first
 * character. Anything else — another origin, a relative reference, or an origin
 * that cannot be compared because `calendarUrl` is empty or not `http(s)` — is
 * ignored and the URL is derived from `calendarUrl` exactly as for a component
 * with no `URL` at all.
 *
 * The guarantee that buys, stated exactly: **every returned URL is either an
 * absolute URL on the calendar's own origin, or a rooted path that resolves to
 * it.** It is never a reference that resolves to another origin. The cost is
 * that a task whose `URL` really did point at another origin loses that URL —
 * silently in this function, reported through `parseTodos`/`parseEvents`
 * `issues`.
 *
 * @param calendarUrl Absolute URL of the collection the component came from.
 * @param uid `UID` of the component, percent-encoded into the resource name.
 * @param declaredUrl The component's `URL` property, when it has one.
 * @returns The resource URL to use for a GET/PUT/DELETE.
 */
export function resourceUrl(calendarUrl: string, uid: string, declaredUrl?: string): string {
  const candidate = declaredUrl?.trim() ?? ""
  if (candidate !== "" && isUsableDeclaredUrl(candidate, calendarUrl)) return candidate
  const name = uid.trim() === "" ? "untitled" : uid.trim()
  return `${withTrailingSlash(calendarUrl)}${encodeURIComponent(name)}.ics`
}

/**
 * True when a server-declared `URL` may stand in for the resource location.
 *
 * The reference is **resolved** and its origin compared, never pattern-matched
 * on its first character. `//host/x` starts with `/` exactly as `/dav/x` does,
 * and it is a *network-path reference*: resolved against the calendar it lands
 * on `https://host/x`, another origin. Prefix matching accepted it, `resourceUrl`
 * handed it back verbatim, and `Todo.url` then had an attacker's origin — which
 * falsified the guarantee both this file and the README publish.
 *
 * What is accepted, and why:
 *
 *  - an absolute URL, kept only when it shares an `http(s)` origin with
 *    `calendarUrl` ({@link sameOrigin}, which fails closed);
 *  - a **rooted** path, resolved against `calendarUrl` first and kept only when
 *    the resolved origin is the calendar's;
 *  - nothing else. A relative reference (`u.ics`) is refused: it is not an
 *    absolute URL a caller can use, and the derived URL is absolute. A
 *    non-`http(s)` scheme, the empty `calendarUrl` a caller gets when it parses
 *    a document with no options, and unparseable text all return `false`,
 *    because none of them can be *shown* to be same-origin.
 */
function isUsableDeclaredUrl(declaredUrl: string, calendarUrl: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:/i.test(declaredUrl)) return sameOrigin(declaredUrl, calendarUrl)
  if (!declaredUrl.startsWith("/")) return false
  let resolved: string
  try {
    resolved = new URL(declaredUrl, new URL(calendarUrl)).toString()
  } catch {
    return false
  }
  return sameOrigin(resolved, calendarUrl)
}

/**
 * Read the `CATEGORIES` property as a list.
 *
 * Split from the **raw** line, before unescaping: the split has to respect
 * escaping (`a\,b,c` is two categories, not three), and the unescaped value no
 * longer contains the backslashes it would need to tell the two apart. Each item
 * is then unescaped individually.
 */
function readCategories(properties: readonly IcalProperty[]): string[] | undefined {
  const declared = properties.find((entry) => entry.name === "CATEGORIES")
  if (declared === undefined || declared.raw.trim() === "") return undefined
  const separator = findPropertySeparator(declared.raw)
  if (separator === -1) return undefined
  const items = splitEscapedList(declared.raw.slice(separator + 1))
    .map((item) => icsUnescape(item).trim())
    .filter((item) => item !== "")
  return items.length === 0 ? undefined : items
}

/** Collapse an empty relation list to `undefined`, so `relatedTo` is absent. */
function optionalRelations(related: RelatedTo[]): RelatedTo[] | undefined {
  return related.length === 0 ? undefined : related
}

/**
 * Read every `RELATED-TO` property of a block, deduplicated by `UID`.
 *
 * Read from `properties`, not from `data`: the source re-scanned the raw block
 * with a regex and lost a second edge whenever the first occurrence of the
 * property had been overwritten. A `RELATED-TO` with no `RELTYPE` is `PARENT`
 * (RFC 5545 §3.8.4.5). Duplicates keep the **first** relation seen for a `UID`,
 * so a `PARENT` edge followed by a `CHILD` edge to the same task stays `PARENT`.
 */
export function readRelatedTo(properties: readonly IcalProperty[]): RelatedTo[] {
  const related: RelatedTo[] = []
  const seen = new Set<string>()
  for (const property of properties) {
    if (property.name !== "RELATED-TO") continue
    const uid = property.value.trim()
    if (uid === "" || seen.has(uid)) continue
    seen.add(uid)
    const declared = property.params["RELTYPE"]?.toUpperCase()
    related.push({ uid, reltype: LabelRelatedType[declared ?? ""] ?? RelatedType.PARENT })
  }
  return related
}

/** Read a `PRIORITY` value, returning it only inside RFC 5545's 1-9 range. */
function readPriority(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 9 ? parsed : undefined
}

/** Read a `PERCENT-COMPLETE` value, clamped to 0-100. */
function readPercent(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return undefined
  return Math.max(0, Math.min(100, parsed))
}

/** Read an ISO 8601 date property, returning `undefined` when unusable. */
function readDate(value: string | undefined, parameter?: string): string | undefined {
  if (value === undefined) return undefined
  return fromCalDavDateValue(value, parameter)?.iso
}

/**
 * The `issues` entry for a server-declared `URL` that {@link resourceUrl} refused.
 *
 * `undefined` when there is nothing to report: no `URL`, or one the resource URL
 * may legitimately be derived from (rooted, or absolute on the calendar's
 * origin). The caller gets it in `issues`, the place every other present-but-
 * unusable property is reported.
 */
function declaredUrlIssue(
  declaredUrl: string | undefined,
  calendarUrl: string | undefined,
): IcalIssue | undefined {
  const candidate = declaredUrl?.trim() ?? ""
  if (candidate === "" || isUsableDeclaredUrl(candidate, calendarUrl ?? "")) return undefined
  return {
    property: "URL",
    value: candidate,
    message: `is not on the origin of ${
      calendarUrl ?? "the calendar"
    }; the resource URL is derived from the calendar instead`,
  }
}

/**
 * Convert parsed iCalendar text into {@link Todo} values.
 *
 * @returns a failure when the document itself is unusable, otherwise a success
 * whose `issues` carry any property that was present but unreadable — a task
 * with `DUE:garbage` is neither silently dropped nor reported as one with no due
 * date, and a `URL` the server named off the calendar's origin is reported there
 * too while the derived URL is used instead ({@link resourceUrl}). Blocks of the
 * wrong component kind are skipped, not treated as faults.
 */
export function parseTodos(
  text: string,
  options: ParseOptions = {},
): CalDavResult<{ todos: Todo[]; issues: IcalIssue[]; warnings: string[] }> {
  const parsed = parseIcal(text)
  if (!parsed.success) return reshapeFailure(parsed)

  const todos: Todo[] = []
  const issues: IcalIssue[] = [...parsed.output.issues]
  for (const block of parsed.output.components) {
    if (block.component !== ComponentType.VTODO) continue
    const uid = block.data["UID"] ?? ""
    const statusLabel = block.data["STATUS"] ?? TodoStatusLabel[1]
    // `URL` is a server-named URL: `resourceUrl` ignores one that is not on the
    // calendar's origin, and the caller is told here rather than left to notice
    // that the URL it got back is not the one the document carried.
    const declaredIssue = declaredUrlIssue(block.data["URL"], options.calendarUrl)
    if (declaredIssue !== undefined) issues.push(declaredIssue)
    todos.push({
      summary: block.data["SUMMARY"] ?? "Untitled",
      description: block.data["DESCRIPTION"],
      categories: readCategories(block.properties),
      status: LabelTodoStatus[statusLabel.toUpperCase()] ?? LabelTodoStatus[TodoStatusLabel[1]]!,
      statusLabel,
      priority: readPriority(block.data["PRIORITY"]),
      due: readDate(
        block.data["DUE"],
        block.properties.find((entry) => entry.name === "DUE")?.params["VALUE"],
      ),
      completed: readDate(
        block.data["COMPLETED"],
        block.properties.find((entry) => entry.name === "COMPLETED")?.params["VALUE"],
      ),
      percentComplete: readPercent(block.data["PERCENT-COMPLETE"]),
      relatedTo: optionalRelations(readRelatedTo(block.properties)),
      url: resourceUrl(options.calendarUrl ?? "", uid, block.data["URL"]),
      etag: options.etags?.get(uid) ?? "",
      calendarName: options.calendarName ?? "",
      uid,
    })
  }
  return ok({ todos, issues, warnings: parsed.output.warnings })
}

/**
 * Convert parsed iCalendar text into {@link Event} values.
 *
 * An event without `DTEND` falls back to its `DTSTART`, which is what RFC 5545
 * §3.6.1 means by a date-only or zero-length event.
 */
export function parseEvents(
  text: string,
  options: ParseOptions = {},
): CalDavResult<{ events: Event[]; issues: IcalIssue[]; warnings: string[] }> {
  const parsed = parseIcal(text)
  if (!parsed.success) return reshapeFailure(parsed)

  const events: Event[] = []
  const issues: IcalIssue[] = [...parsed.output.issues]
  for (const block of parsed.output.components) {
    if (block.component !== ComponentType.VEVENT) continue
    const uid = block.data["UID"] ?? ""
    const startProperty = block.properties.find((entry) => entry.name === "DTSTART")
    const endProperty = block.properties.find((entry) => entry.name === "DTEND")
    const start = readDate(block.data["DTSTART"], startProperty?.params["VALUE"]) ?? ""
    const end = readDate(block.data["DTEND"], endProperty?.params["VALUE"]) || start
    // See `parseTodos`: a `URL` off the calendar's origin is ignored by
    // `resourceUrl` and reported as an issue instead of silently swapped.
    const declaredIssue = declaredUrlIssue(block.data["URL"], options.calendarUrl)
    if (declaredIssue !== undefined) issues.push(declaredIssue)
    events.push({
      summary: block.data["SUMMARY"] ?? "Untitled",
      description: block.data["DESCRIPTION"],
      start,
      end,
      location: block.data["LOCATION"],
      url: resourceUrl(options.calendarUrl ?? "", uid, block.data["URL"]),
      etag: options.etags?.get(uid) ?? "",
      calendarName: options.calendarName ?? "",
      uid,
      status: block.data["STATUS"],
    })
  }
  return ok({ events, issues, warnings: parsed.output.warnings })
}
