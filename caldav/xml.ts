/**
 * CalDAV/WebDAV request-body builders and response readers, as strings.
 *
 * Ported from `caldav-mcp/caldav/xml.ts` plus the response parsing half of
 * `client.ts` (issue #13). No XML library, on either side: the builders emit
 * literal strings and the readers match elements with a namespace-prefix-
 * agnostic pattern. A server may use any prefix or none at all — Radicale writes
 * `xmlns="DAV:"` with unprefixed children, Apple's CalendarServer writes
 * `D:`/`C:`/`CS:`, SabreDAV writes lowercase — so every pattern here accepts
 * `<response>`, `<D:response>` and `<d:response>` alike. See `caldav/README.md`
 * for the interop notes this encodes.
 *
 * Bugs fixed at extraction time (source line numbers in the PR body):
 *
 *  - the response pattern was `/<(?:D:)?response>/i`, hard-coded to the single
 *    prefix `D:`, so a SabreDAV response using `<d:response>` or a default
 *    namespace using `<response>` parsed to zero calendars. The source had a
 *    correct pattern in `query.ts` (`extractTagSimple`) and a broken one in
 *    `client.ts`; the single correct implementation is here.
 *  - `escapeXml` left an XML-invalid C0 control character in place, so a
 *    `displayName` carrying a `\u0000` produced a body no server can parse.
 *  - the resource-type test was `block.includes("<calendar")`, which matches
 *    `<calendar-color>` and therefore reports a plain collection carrying only a
 *    colour as a calendar.
 */

import { toCalDavDate } from "./ical.ts"
import {
  CalDavErrorCode,
  type CalDavResult,
  type Calendar,
  ComponentType,
  ComponentTypeLabel,
  fail,
  ok,
} from "./types.ts"

/** XML declaration prepended to every request body. */
export const XML_PROLOG = '<?xml version="1.0" encoding="utf-8" ?>'

/** WebDAV namespace; `DAV:` is the documented prefix but any prefix is legal. */
export const DAV_NAMESPACE = "DAV:"

/** CalDAV namespace. */
export const CALDAV_NAMESPACE = "urn:ietf:params:xml:ns:caldav"

/** CalendarServer extensions namespace, which carries `getctag` and `calendar-color`. */
export const CALENDARSERVER_NAMESPACE = "http://calendarserver.org/ns/"

/** Any XML prefix, or none: the group is empty for an unprefixed name. */
const PREFIX = "(?:[A-Za-z_][\\w.-]*:)?"

/**
 * Build a pattern matching one element with any prefix, capturing its inner XML.
 *
 * Deliberately non-greedy and namespace-blind: a CalDAV response nests the same
 * names at several depths (`<response>` contains `<propstat>` contains `<prop>`
 * contains `<getetag>`), so a capture that spanned siblings would return one
 * value for a whole response and every entry would look identical.
 */
function elementPattern(name: string, flags = "is"): RegExp {
  return new RegExp(`<${PREFIX}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${PREFIX}${name}\\s*>`, flags)
}

/** Escape the five XML predefined entities and drop characters XML forbids. */
export function escapeXml(value: string): string {
  const cleaned = [...value].filter((character) => {
    const code = character.codePointAt(0)!
    // XML 1.0 §2.2: #x9, #xA, #xD, #x20-#xD7FF, and above. Everything else in C0
    // (and DEL) has no representation at all, not even as a numeric entity, so a
    // value carrying one produces a body no conforming parser accepts.
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
  }).join("")
  return cleaned
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

/**
 * Convert an ISO 8601 date string to the CalDAV value form, `YYYYMMDDTHHMMSSZ`.
 *
 * @throws {TypeError} when the input is not a parseable date. The maths lives in
 * `ical.ts`, which delegates the serialisation to `@ts-libs/time/ics-core`.
 */
export function toCalDavTime(value: string): string {
  try {
    return toCalDavDate(value)
  } catch (cause) {
    throw new TypeError(`not a valid date: ${JSON.stringify(value)}: ${String(cause)}`)
  }
}

/**
 * PROPFIND body listing the calendar collections under a URL.
 *
 * Sent with `Depth: 1`; asks for `getctag` because a client that only compares
 * ETags has to refetch every resource to notice a deletion.
 */
export function propfindCalendars(): string {
  return `${XML_PROLOG}
<D:propfind xmlns:D="DAV:"
            xmlns:C="urn:ietf:params:xml:ns:caldav"
            xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <C:supported-calendar-component-set/>
    <CS:getctag/>
  </D:prop>
</D:propfind>`
}

/**
 * PROPFIND body asking for `calendar-home-set`.
 *
 * Sent with `Depth: 0` on the server root. The property is CalDAV-specific, so
 * a server that does not implement it answers `404` for the property rather than
 * for the request — which is why the client treats "no `calendar-home-set` in
 * the body" and not "non-2xx" as the trigger for its `/username/` fallback.
 */
export function propfindCalendarHomeSet(): string {
  return `${XML_PROLOG}
<D:propfind xmlns:D="DAV:"
            xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <C:calendar-home-set/>
    <D:displayname/>
  </D:prop>
</D:propfind>`
}

/** Optional server-side filters for {@link reportTodos}. */
export interface TodoReportFilters {
  /** `STATUS` text match; `ALL` is treated as no filter, as in the source. */
  status?: string
  /** `SUMMARY` text match. */
  text?: string
  /** Upper bound on `DUE`; the range starts at the Unix epoch. */
  dueBefore?: string
}

/** Optional server-side filters for {@link reportEvents}. */
export interface EventReportFilters {
  /** Lower bound on `DTSTART`; defaults to the Unix epoch. */
  dateFrom?: string
  /** Upper bound on `DTSTART`; defaults to 2099-12-31. */
  dateTo?: string
  /** `SUMMARY` text match. */
  text?: string
}

/**
 * Wrap component filters into the CalDAV `filter` element.
 *
 * A filterless `comp-filter` is self-closing on purpose: `<C:comp-filter
 * name="VTODO"/>` means "any VTODO", whereas an empty element pair means the
 * same thing but is more bytes on a metered connection.
 */
function calendarQuery(
  component: ComponentType.VTODO | ComponentType.VEVENT,
  filters: string[],
): string {
  const name = ComponentTypeLabel[component]
  const inner = filters.length === 0
    ? `<C:comp-filter name="${name}"/>`
    : `<C:comp-filter name="${name}">${filters.join("")}</C:comp-filter>`
  return `${XML_PROLOG}
<C:calendar-query xmlns:D="DAV:"
                  xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">${inner}</C:comp-filter>
  </C:filter>
</C:calendar-query>`
}

/** A `prop-filter` carrying a caseless `text-match`. */
function textMatchFilter(property: string, value: string): string {
  return `<C:prop-filter name="${escapeXml(property)}">` +
    `<C:text-match collation="i;ascii-casemap">${escapeXml(value)}</C:text-match>` +
    `</C:prop-filter>`
}

/**
 * REPORT body — `calendar-query` for `VTODO`, with optional server-side filters.
 *
 * Priority is deliberately absent: CalDAV has no numeric range filter, so
 * priority is filtered client-side after the response (see `query.ts`). Sending
 * a `text-match` on `PRIORITY` would compare numbers as strings and drop `PRIORITY:10`.
 */
export function reportTodos(filters: TodoReportFilters = {}): string {
  const clauses: string[] = []
  if (filters.status && filters.status !== "ALL") {
    clauses.push(textMatchFilter("STATUS", filters.status))
  }
  if (filters.text) clauses.push(textMatchFilter("SUMMARY", filters.text))
  if (filters.dueBefore) {
    clauses.push(
      `<C:prop-filter name="DUE"><C:time-range start="19700101T000000Z" end="${
        toCalDavTime(filters.dueBefore)
      }"/></C:prop-filter>`,
    )
  }
  return calendarQuery(ComponentType.VTODO, clauses)
}

/**
 * REPORT body — `calendar-query` for `VEVENT`, with an optional date range.
 *
 * The range is applied to `DTSTART` only. RFC 4791 §9.9 defines a `time-range`
 * as an overlap against the component's own duration; a client that wants
 * "events happening today" and sends `DTSTART` bounds will miss an event that
 * started yesterday, which is why the range is capped at 2099 rather than left
 * open and why callers filter the result again if they need exact overlap.
 */
export function reportEvents(filters: EventReportFilters = {}): string {
  const clauses: string[] = []
  if (filters.dateFrom || filters.dateTo) {
    const start = filters.dateFrom ? toCalDavTime(filters.dateFrom) : "19700101T000000Z"
    const end = filters.dateTo ? toCalDavTime(filters.dateTo) : "20991231T235959Z"
    clauses.push(
      `<C:prop-filter name="DTSTART"><C:time-range start="${start}" end="${end}"/></C:prop-filter>`,
    )
  }
  if (filters.text) clauses.push(textMatchFilter("SUMMARY", filters.text))
  return calendarQuery(ComponentType.VEVENT, clauses)
}

/** Fields of a `MKCALENDAR` request body. */
export interface MakeCalendarOptions {
  /** `DAV:displayname`. Required, escaped. */
  displayName: string
  /**
   * Components the new collection should advertise. An **empty** array emits an
   * explicitly empty `supported-calendar-component-set`, which RFC 4791 §5.2.3
   * defines as "no component is accepted"; a server that then reports the same
   * empty set back must be believed rather than second-guessed with a default.
   */
  components?: readonly (ComponentType.VTODO | ComponentType.VEVENT | ComponentType.VJOURNAL)[]
  /** `CS:calendar-color`, e.g. `#FF0000FF`. */
  color?: string
  /** `DAV:description`. */
  description?: string
}

/** MKCALENDAR body creating a new calendar collection (RFC 4791 §5.3.1). */
export function mkcalendar(options: MakeCalendarOptions): string {
  const components = (options.components ?? []).map((component) =>
    `<C:comp name="${ComponentTypeLabel[component]}"/>`
  ).join("")
  const color = options.color
    ? `<CS:calendar-color>${escapeXml(options.color)}</CS:calendar-color>`
    : ""
  const description = options.description
    ? `<D:description>${escapeXml(options.description)}</D:description>`
    : ""
  return `${XML_PROLOG}
<C:mkcalendar xmlns:D="DAV:"
              xmlns:C="urn:ietf:params:xml:ns:caldav"
              xmlns:CS="http://calendarserver.org/ns/">
  <D:set>
    <D:prop>
      <D:displayname>${escapeXml(options.displayName)}</D:displayname>
      <C:supported-calendar-component-set>${components}</C:supported-calendar-component-set>${
    color ? `\n      ${color}` : ""
  }${description ? `\n      ${description}` : ""}
    </D:prop>
  </D:set>
</C:mkcalendar>`
}

/** Properties a {@link proppatchCalendar} call can change. */
export interface ProppatchOptions {
  /** `DAV:displayname`. */
  displayName?: string
  /** `CS:calendar-color`. */
  color?: string
  /** `DAV:description`. */
  description?: string
}

/**
 * PROPPATCH body updating calendar properties.
 *
 * @throws {TypeError} when no property is supplied: an empty `D:prop` is a
 * no-op request that some servers answer `403`, and a caller that asks for
 * nothing has a bug worth surfacing at the call site.
 */
export function proppatchCalendar(options: ProppatchOptions): string {
  const props: string[] = []
  if (options.displayName) {
    props.push(`<D:displayname>${escapeXml(options.displayName)}</D:displayname>`)
  }
  if (options.color) {
    props.push(`<CS:calendar-color>${escapeXml(options.color)}</CS:calendar-color>`)
  }
  if (options.description) {
    props.push(`<D:description>${escapeXml(options.description)}</D:description>`)
  }
  if (props.length === 0) {
    throw new TypeError("proppatchCalendar requires at least one property to set")
  }
  return `${XML_PROLOG}
<D:propertyupdate xmlns:D="DAV:"
                  xmlns:CS="http://calendarserver.org/ns/">
  <D:set>
    <D:prop>
      ${props.join("\n      ")}
    </D:prop>
  </D:set>
</D:propertyupdate>`
}

/**
 * Read the first occurrence of an element's inner text, prefix-blind.
 *
 * This is the single implementation of the source's duplicated
 * `extractTagFlex` (client.ts) and `extractTagSimple` (query.ts). The name kept
 * is neither: `extractElementText` says what it does, and the old names are
 * deleted rather than aliased, because an alias preserves the duplication.
 *
 * @returns the trimmed inner text, or `undefined` when the element is absent.
 */
export function extractElementText(xml: string, name: string): string | undefined {
  const match = elementPattern(name).exec(xml)
  return match ? match[1]!.trim() : undefined
}

/** Read the inner XML of every occurrence of an element, prefix-blind. */
export function extractElementBlocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(elementPattern(name).source, "gi"))].map((match) => match[1]!)
}

/**
 * Resolve an `href` against the base URL the request was made to.
 *
 * Three shapes appear in the wild: an absolute URL (some servers echo the
 * request URL), an absolute path (`/remote.php/dav/calendars/user/`), and a
 * relative path. Each server's own prefix matters, which is why an absolute path
 * is resolved against the base's **origin** and not its path. The source had two
 * copies of this, `resolveUrl` and `resolveUrlFlex`, byte-identical but for the
 * parameter names; this is the single one.
 *
 * @throws {TypeError} when `baseUrl` is not a valid absolute URL.
 */
export function resolveUrl(href: string, baseUrl: string): string {
  const trimmed = href.trim()
  if (trimmed === "") return baseUrl
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new TypeError(`baseUrl is not an absolute URL: ${JSON.stringify(baseUrl)}`)
  }
  try {
    return new URL(trimmed, base).toString()
  } catch {
    throw new TypeError(`href is not resolvable against ${baseUrl}: ${JSON.stringify(href)}`)
  }
}

/** True when a multi-status `propstat` block reports a failure for its property. */
function isFailedPropstat(block: string): boolean {
  const status = extractElementText(block, "status")
  if (status === undefined) return false
  return !/\s2\d\d[\s.]/.test(status)
}

/** True when a `propstat` block reports `404 Not Found` for its properties. */
function isMissingPropstat(block: string): boolean {
  const status = extractElementText(block, "status")
  return status !== undefined && /\s404[\s.]/.test(status)
}

/**
 * Detect a calendar collection from one `<response>` block's `resourcetype`.
 *
 * `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` is the
 * documented marker. The test is on the *empty element* `<C:calendar`, not on the
 * substring `<calendar`, because a collection carrying only a
 * `CS:calendar-color` property has the substring and is not a calendar.
 */
export function hasCalendarResourceType(block: string): boolean {
  const resourcetype = extractElementText(block, "resourcetype")
  if (resourcetype === undefined) return false
  return /<[^>]*\bcalendar\b[^>]*\/?>/i.test(resourcetype)
}

/**
 * Read the components a block's `supported-calendar-component-set` lists.
 *
 * `declared` is true for both an explicitly empty set
 * (`<C:supported-calendar-component-set/>` and its expanded form), because the
 * two mean the same thing: RFC 4791 §5.2.3 states which components the
 * collection accepts, and "none" is a legal answer a client must not override.
 */
export function readSupportedComponents(block: string): {
  components: ComponentType[]
  declared: boolean
} {
  const set = extractElementText(block, "supported-calendar-component-set")
  const selfClosing = new RegExp(
    `<${PREFIX}supported-calendar-component-set(?:\\s[^>]*)?/>`,
    "is",
  ).test(block)
  const declared = set !== undefined || selfClosing
  const components: ComponentType[] = []
  for (const match of block.matchAll(/<[^>]*\bcomp\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>/gi)) {
    const name = match[1]!.toUpperCase()
    if (name === "VEVENT") components.push(ComponentType.VEVENT)
    else if (name === "VTODO") components.push(ComponentType.VTODO)
    else if (name === "VJOURNAL") components.push(ComponentType.VJOURNAL)
  }
  return { components, declared }
}

/**
 * Parse a PROPFIND multi-status body into {@link Calendar} values.
 *
 * @returns a failure when the body has no `<response>` block at all, which is a
 * transport or protocol fault rather than an empty account — the distinction the
 * source lost by returning `[]` either way.
 *
 * Interop rules applied here:
 *
 *  - namespace prefixes are ignored, so `<D:response>`, `<d:response>` and
 *    `<response>` all count;
 *  - a `response` whose own `<status>` is a failure, or whose only properties
 *    arrive in a failed `propstat`, is skipped instead of being parsed into a
 *    calendar with no name;
 *  - an **explicitly empty** `supported-calendar-component-set` is trusted and
 *    yields no components, rather than being replaced with `[VEVENT, VTODO]`;
 *  - a missing component set is the one case that falls back to a default, and
 *    the default is recorded for the caller in `warnings`.
 */
export function parseCalendarPropfind(
  xml: string,
  baseUrl: string,
): CalDavResult<{ calendars: Calendar[]; warnings: string[] }> {
  if (typeof xml !== "string" || xml.trim() === "") {
    return fail(CalDavErrorCode.INVALID_ARGUMENT, "PROPFIND response body is empty")
  }
  const blocks = extractElementBlocks(xml, "response")
  if (blocks.length === 0) {
    return fail(
      CalDavErrorCode.PARSE,
      "PROPFIND response has no <response> element; the server did not answer as a WebDAV multi-status",
    )
  }

  const calendars: Calendar[] = []
  const warnings: string[] = []
  for (const block of blocks) {
    const ownStatus = extractElementText(block, "status")
    if (ownStatus !== undefined && !/\s2\d\d[\s.]/.test(ownStatus)) continue

    const href = extractElementText(block, "href")
    if (href === undefined || href === "") continue

    const propstats = extractElementBlocks(block, "propstat")
    const usable = propstats.filter((propstat) => !isFailedPropstat(propstat))
    const scope = usable.length > 0 ? usable.join("") : block
    if (propstats.length > 0 && usable.length === 0) {
      // Every property errored: a per-resource failure inside a 207. Skipping it
      // keeps a broken member from being reported as a calendar with no name.
      const status = extractElementText(propstats[0]!, "status") ?? "unknown status"
      if (isMissingPropstat(propstats[0]!)) continue
      warnings.push(`skipped ${href}: properties failed with ${status}`)
      continue
    }

    const isCalendarResource = hasCalendarResourceType(scope)
    const { components, declared } = readSupportedComponents(scope)
    if (!isCalendarResource && !declared) continue

    const displayName = extractElementText(scope, "displayname") || lastPathSegment(href) ||
      "Unnamed"
    if (!declared && isCalendarResource) {
      warnings.push(
        `${displayName} declares no supported-calendar-component-set; assumed VEVENT and VTODO`,
      )
    }
    let url: string
    try {
      url = resolveUrl(href, baseUrl)
    } catch (cause) {
      warnings.push(`skipped ${href}: ${String(cause)}`)
      continue
    }
    calendars.push({
      url,
      displayName,
      components: declared ? components : [ComponentType.VEVENT, ComponentType.VTODO],
      color: extractElementText(scope, "calendar-color"),
      description: extractElementText(scope, "description"),
      ctag: extractElementText(scope, "getctag"),
    })
  }
  return ok({ calendars, warnings })
}

/** Last non-empty path segment of an href, URL-decoded for display. */
function lastPathSegment(href: string): string {
  const segments = href.split("?")[0]!.split("/").filter((segment) => segment !== "")
  const last = segments[segments.length - 1]
  if (last === undefined) return ""
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * Read `UID` → `getetag` pairs from a `calendar-query` response.
 *
 * The key is derived from the resource's filename with its `.ics` suffix removed,
 * which is what CalDAV servers use (RFC 4791 §5.3.2 leaves the resource name to
 * the client). An entry is only recorded when both an `href` and a `getetag`
 * arrived, so a resource the server failed to report keeps an empty ETag instead
 * of a stale one.
 */
export function extractEtags(xml: string): Map<string, string> {
  const etags = new Map<string, string>()
  for (const block of extractElementBlocks(xml, "response")) {
    const ownStatus = extractElementText(block, "status")
    if (ownStatus !== undefined && !/\s2\d\d[\s.]/.test(ownStatus)) continue
    const href = extractElementText(block, "href")
    const etag = extractElementText(block, "getetag")
    if (href === undefined || etag === undefined || etag === "") continue
    etags.set(resourceName(href), normalizeEtag(etag))
  }
  return etags
}

/** The resource name of an href: last path segment, `.ics` suffix removed. */
export function resourceName(href: string): string {
  const segment = lastPathSegment(href.split("?")[0]!)
  let decoded = segment
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    // A malformed escape is not worth failing the whole response over; the raw
    // segment still identifies the resource consistently within one response.
  }
  return decoded.replace(/\.ics$/i, "")
}

/**
 * Normalise an ETag for use in `If-Match`.
 *
 * RFC 7232 defines an ETag as a **quoted** opaque string, and RFC 4791 §8.6
 * servers may or may not quote it in the response. Both `W/"abc"` and `"abc"`
 * must be sent back exactly as received, so the only normalisation applied is
 * stripping surrounding whitespace — the source passed the raw value through,
 * which happened to work but also let a trailing newline from a folded header
 * reach the request.
 */
export function normalizeEtag(etag: string): string {
  return etag.trim()
}

/**
 * Read the resources a `calendar-query` response carries, with their calendar
 * data and ETags, so a caller can parse several components against one response.
 *
 * A `response` whose `<status>` is a failure is returned in `failures` rather
 * than dropped: a 207 multi-status is how a server reports "the collection was
 * queried, this member errored", and a caller that cannot see that cannot decide
 * whether the answer is trustworthy.
 */
export function readReportResources(xml: string): {
  resources: { href: string; etag: string; calendarData: string }[]
  failures: { href: string; status: string }[]
} {
  const resources: { href: string; etag: string; calendarData: string }[] = []
  const failures: { href: string; status: string }[] = []
  for (const block of extractElementBlocks(xml, "response")) {
    const href = extractElementText(block, "href") ?? ""
    const ownStatus = extractElementText(block, "status")
    if (ownStatus !== undefined && !/\s2\d\d[\s.]/.test(ownStatus)) {
      failures.push({ href, status: ownStatus })
      continue
    }
    const etag = extractElementText(block, "getetag")
    const calendarData = extractElementText(block, "calendar-data")
    if (etag === undefined && calendarData === undefined) continue
    resources.push({
      href,
      etag: etag === undefined ? "" : normalizeEtag(etag),
      calendarData: decodeXmlEntities(calendarData ?? ""),
    })
  }
  return { resources, failures }
}

/**
 * Decode the five XML predefined entities plus numeric character references.
 *
 * A `calendar-data` payload is XML-escaped iCalendar text, so `&amp;` has to
 * become `&` before the iCalendar parser runs — otherwise a `SUMMARY` holding a
 * comma-separated list arrives with `&amp;` in it. Numeric references are
 * decoded too, because a server may escape a character with no named entity.
 */
export function decodeXmlEntities(value: string): string {
  return value.replaceAll(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        const entities: Record<string, string> = {
          amp: "&",
          lt: "<",
          gt: ">",
          quot: '"',
          apos: "'",
        }
        return entities[named]!
      }
      const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    },
  )
}
