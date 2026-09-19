/**
 * CalDAV/WebDAV request-body builders and response readers, as strings.
 *
 * Ported from `caldav-mcp/caldav/xml.ts` plus the response parsing half of
 * `client.ts` (issue #13). No XML library, on either side: the builders emit
 * literal strings and the readers match elements with a namespace-prefix-
 * agnostic pattern. A server may use any prefix or none at all — Radicale writes
 * `xmlns="DAV:"` with unprefixed children and Apple's CalendarServer writes
 * `D:`/`C:`/`CS:` — so every pattern here accepts
 * `<response>`, `<D:response>` and `<d:response>` alike. See `caldav/README.md`
 * for the interop notes this encodes.
 *
 * Bugs fixed at extraction time (source line numbers in the PR body):
 *
 *  - the response pattern was `/<(?:D:)?response>/i`, hard-coded to the single
 *    prefix `D:`, so `<A:response>` parsed to zero calendars. The source had a
 *    correct pattern in `query.ts` (`extractTagSimple`) and a narrower one in
 *    `client.ts`; the single correct implementation is here. Measured on the
 *    source: `<d:response>` and an unprefixed `<response>` both parsed, because
 *    of the `i` flag and the optional group — only a non-`D` prefix broke.
 *  - `escapeXml` left an XML-invalid C0 control character in place, so a
 *    `displayName` carrying a `\u0000` produced a body no server can parse. It
 *    also let a lone surrogate through its `code >= 32` test; that is repaired
 *    too, by the XML 1.0 `Char` rule this module now implements in one place.
 *  - the resource-type test was `/<[^>]*\bcalendar\b[^>]*\/?>/i`, which matches
 *    any `calendar-*` element inside a `resourcetype` — `<calendar-color>`
 *    prefixed or unprefixed, `<calendar-description>`, `<calendar-home-set>` —
 *    and therefore reports a plain collection as a calendar.
 *  - the response parser read the first `<status>` **anywhere** inside a
 *    `<response>`, including the one nested in a `<propstat>`. WebDAV groups a
 *    response's properties by status and does not order the groups, so a server
 *    answering `404` for an unsupported `CS:getctag` before the `200` group made
 *    `listCalendars()` return zero calendars with no warning — a regression
 *    against the source, whose `<status>` pattern was anchored to the response's
 *    own element. The status now comes from the response level when present,
 *    else from the group that carries the requested property, never from
 *    whichever `<status>` appears first. The same reading at `extractEtags` and
 *    `readReportResources` dropped a readable resource's `calendar-data`.
 *  - `decodeXmlEntities` handed every numeric reference to
 *    `String.fromCodePoint`, so `&#x110000;` inside a `calendar-data` element
 *    threw `RangeError` out of `readReportResources`, `CalDavClient.readReport`
 *    and `QueryEngine.queryTodos`.
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

/**
 * True when `code` is an XML 1.0 **Char** (XML 1.0 §2.2).
 *
 * `Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]`
 *
 * The excluded values are not merely "above `#x10FFFF`": they also include the
 * surrogate range, which in a JS string is not a character at all but half of a
 * pair, the C0 controls other than tab/CR/LF, DEL, and the two non-characters
 * `#xFFFE`/`#xFFFF`. A code point outside this set has no representation in XML
 * 1.0 — not even as a numeric character reference — so a body carrying one is a
 * body no conforming parser accepts.
 */
export function isXmlChar(code: number): boolean {
  if (code === 9 || code === 10 || code === 13) return true
  if (code >= 32 && code <= 0xd7ff) return true
  if (code >= 0xe000 && code <= 0xfffd) return true
  return code >= 0x10000 && code <= 0x10ffff
}

/**
 * The code units this module refuses to carry in either direction.
 *
 * The two non-characters `#xFFFE`/`#xFFFF` and the C0 controls other than
 * tab/CR/LF are outside XML 1.0's **Char** production (§2.2), so a literal one is
 * as unacceptable as a NUL and neither has a numeric reference to escape to.
 *
 * **DEL does not belong to that set, and the pattern includes it anyway.** `#x7F`
 * is inside `Char` (`[#x20-#xD7FF]`), so XML 1.0 gives it a representation: the
 * treatment below is a deliberate deviation, not a consequence of the `Char`
 * rule. `escapeXml("a\u007Fb")` is `"ab"` and `decodeXmlEntities("&#x7F;")` is
 * `U+FFFD` — a legal character dropped or substituted with nothing in the result
 * to say so. Behaviour is pinned as it stands (see the `&#x7F;` case in
 * `xml.test.ts`, which rests on the same mistaken premise); correcting it is a
 * parked follow-up, not part of the credential work.
 */
// The control-character range is the point of this pattern, as in `net/url-shape`.
// deno-lint-ignore no-control-regex
const ILLEGAL_CODE_UNIT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g

/** The literal XML 1.0 §2.2 has for a code point with no representation of its own. */
export const XML_ILLEGAL_REPLACEMENT = "\uFFFD"

/**
 * True for a high code unit: the first half of a surrogate pair.
 *
 * `0xD800-0xDBFF` and `0xDC00-0xDFFF` are written out rather than named as
 * exported constants, because the only thing a CalDAV body ever needs from them
 * is the pair check below.
 */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** True for a low code unit: the second half of a surrogate pair. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Replace every unpaired surrogate code unit with {@link XML_ILLEGAL_REPLACEMENT}.
 *
 * A JS string can hold half a surrogate pair, which is not a character at all:
 * XML 1.0 has no representation for it, and `String.prototype.replaceAll` throws
 * `RangeError` when handed one — so the repair cannot be a regex replacement
 * either. A lone surrogate code *unit* in the input string is invisible to a
 * Unicode-mode `/[\uD800-\uDFFF]/gu` class, because such a class matches code
 * *points* and never a code unit that belongs to no code point. The pair check is
 * therefore an explicit scan.
 */
function replaceLoneSurrogates(value: string): string {
  const out: string[] = []
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (isHighSurrogate(code)) {
      if (isLowSurrogate(value.charCodeAt(index + 1))) {
        out.push(value[index]!, value[index + 1]!)
        index++
        continue
      }
      out.push(XML_ILLEGAL_REPLACEMENT)
      continue
    }
    if (isLowSurrogate(code)) {
      out.push(XML_ILLEGAL_REPLACEMENT)
      continue
    }
    out.push(value[index]!)
  }
  return out.join("")
}

/** Drop every literal code unit XML 1.0 forbids, leaving valid pairs untouched. */
function stripIllegalXmlCharacters(value: string): string {
  return replaceLoneSurrogates(value.replace(ILLEGAL_CODE_UNIT, ""))
}

/**
 * Replace every code point XML 1.0 has no representation for with `U+FFFD`.
 *
 * The decode-side twin of {@link stripIllegalXmlCharacters}, and the difference
 * between the two is deliberate. `escapeXml` *emits* text and drops what it
 * cannot write, because a request body must stay valid and there is nothing else
 * to do with a NUL. `decodeXmlEntities` *reports* what a server sent, so dropping
 * a byte there would turn a corrupt payload into a plausible-looking one; the
 * `U+FFFD` is the one code point that stays legal in XML *and* says "this was
 * not what the server sent".
 */
function replaceIllegalXmlCharacters(value: string): string {
  return replaceLoneSurrogates(value.replace(ILLEGAL_CODE_UNIT, XML_ILLEGAL_REPLACEMENT))
}

/**
 * Escape the five predefined entities and remove every character XML 1.0 forbids.
 *
 * Rule, in one line: the output is `value` with each character that is **not** an
 * XML 1.0 `Char` ({@link isXmlChar}) removed, and each of `& < > " '` replaced by
 * its predefined entity.
 *
 * Dropping rather than substituting is deliberate for the characters XML 1.0
 * gives **no** representation at all — a body carrying one is a body no
 * conforming parser accepts, so emitting nothing is the only option that produces
 * a valid request. An unpaired surrogate is *replaced* with `U+FFFD` instead of
 * dropped: a lone surrogate is already a value the caller could not have meant,
 * and silently shortening the string hides more than it protects. Note the
 * consequence for a caller: a `displayname` of `"a\u0000b"` is sent as `"ab"`,
 * and nothing reports the loss.
 *
 * One character is removed that XML 1.0 does **not** forbid: DEL (`#x7F`), which
 * is inside `Char`. The deviation is inherited from the `ILLEGAL_CODE_UNIT`
 * pattern and is documented there; this JSDoc's rule sentence is therefore
 * narrower than the code — the code also removes DEL.
 *
 * @param value Text to place in an XML body.
 * @returns Markup-safe text containing no non-`Char` code point.
 */
export function escapeXml(value: string): string {
  const cleaned = stripIllegalXmlCharacters(value)
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

/** True when a `status` line reports anything but a 2xx. */
function isFailureStatus(status: string): boolean {
  return !/\s2\d\d[\s.]/.test(status)
}

/**
 * A `propstat` broken into the properties it answers for and its own status.
 *
 * `names` are local names with any namespace prefix stripped, because a server
 * may write `<d:getetag>` and the caller asks for `getetag`.
 */
interface PropstatBlock {
  names: Set<string>
  status: string | undefined
}

/** Local name of an element: everything after the last `:`, when there is one. */
function localName(name: string): string {
  const colon = name.indexOf(":")
  return colon === -1 ? name : name.slice(colon + 1)
}

/**
 * The `propstat` block that answers for `name`, or `""` when none does.
 *
 * A group whose own status is a failure is not an answer even when the empty
 * element is written inside it — `<D:getetag/>` under `404 Not Found` says the
 * property is absent, not that it is present and empty. When no present group
 * answers, the whole response block is returned so a body without any `propstat`
 * (a flat `<response><getetag>…`) still reads.
 */
function propstatAnswering(response: string, name: string): string {
  const answering = extractElementBlocks(response, "propstat").filter((propstat) => {
    const status = ownStatuses(propstat)[0]
    if (status !== undefined && isFailureStatus(status)) return false
    return propertyIn(propstat, name)
  })
  return answering.join("") || response
}

/** The status lines belonging *directly* to a block, in document order. */
function ownStatuses(block: string): string[] {
  return [
    ...block.matchAll(
      new RegExp(`<${PREFIX}status(?:\\s[^>]*)?>([\\s\\S]*?)</${PREFIX}status\\s*>`, "gis"),
    ),
  ]
    .map((match) => match[1]!.trim())
}

/** Any `prop` element, namespaced or not: the full form captures its inner XML. */
function propElementPattern(): RegExp {
  return new RegExp(
    `<${PREFIX}prop(?:\\s[^>]*)?>([\\s\\S]*?)</${PREFIX}prop\\s*>|<${PREFIX}prop(?:\\s[^>]*)?/>`,
    "gis",
  )
}

/**
 * The names of the property elements inside a `<prop>`'s inner XML.
 *
 * Two shapes count, and both must: `<D:getetag>"x"</D:getetag>` and the
 * **self-closing** `<D:getetag/>` a server writes when the property is present
 * but carries no value of its own — which is exactly how a real server writes
 * the property whose status the group is reporting. A name ends at whitespace,
 * `/` or `>`, so `<D:getetag-foo>` is a different name and a closing tag
 * (`</D:prop>`) is not a name at all.
 */
function propertyNames(propXml: string): Set<string> {
  return new Set(
    [...propXml.matchAll(new RegExp(`<${PREFIX}([A-Za-z_][\\w.-]*)[\\s/>]`, "g"))]
      .map((inner) => localName(inner[1]!)),
  )
}

/**
 * Split a `<response>` block's `propstat` children into names and status.
 *
 * The `<prop>` boundary is matched as an **element**, never as the literal
 * string `</prop>`. A server writes `</D:prop>`, so the literal split this
 * replaced never matched a real body: `status` came back `undefined` for every
 * group, rules 2 and 3 of {@link responseStatusFor} were inert, and a member
 * whose own group answered `calendar-data` with `404`/`403`/`500` was dropped
 * from both `resources` and `failures` by {@link readReportResources}.
 *
 * The `<status>` search is restricted to what follows the group's own `<prop>`,
 * so it cannot reach into a sibling: a `propstat` never nests another one, and
 * the remainder is that group's own XML. A group with a self-closing
 * `<D:prop/>` has no names and a status that still counts.
 */
function propstatBlocks(response: string): PropstatBlock[] {
  const blocks: PropstatBlock[] = []
  for (const match of response.matchAll(elementPattern("propstat", "gi"))) {
    const body = match[1]!
    // The last `prop` wins, as the `lastIndexOf` this replaced did: a `prop`
    // never nests another `prop`, so the last one separates the property list
    // from the status that follows it.
    let propXml = ""
    let afterProp = body
    for (const prop of body.matchAll(propElementPattern())) {
      propXml = prop[1] ?? ""
      afterProp = body.slice(prop.index! + prop[0].length)
    }
    blocks.push({ names: propertyNames(propXml), status: ownStatuses(afterProp)[0] })
  }
  return blocks
}

/** The `<status>` line of a block itself: everything outside its `propstat` children. */
function ownStatus(response: string): string | undefined {
  let outer = ""
  let cursor = 0
  for (const match of response.matchAll(elementPattern("propstat", "gi"))) {
    outer += response.slice(cursor, match.index)
    cursor = match.index! + match[0].length
  }
  outer += response.slice(cursor)
  return ownStatuses(outer)[0]
}

/**
 * Status that governs `name` for one `<response>` block.
 *
 * WebDAV splits a response into one `propstat` per status group, and the groups
 * may arrive in any order: a server that does not implement `CS:getctag` answers
 * with a `404` `propstat` for that property and a `200` `propstat` for the rest,
 * and nothing requires the `200` one to come first. Reading the first `<status>`
 * anywhere in the block therefore reads a *sibling* group's status — it made
 * `parseCalendarPropfind` drop every calendar whose `getctag` was not
 * implemented, so `listCalendars()` returned zero calendars with no warning.
 *
 * Precedence, in order:
 *
 *  1. the `<status>` the `<response>` itself carries, which RFC 4918 §14.24
 *     defines as the status of the request as a whole;
 *  2. the status of the `propstat` whose `<prop>` contains `name` — the group
 *     that actually answers for the property the caller asked about;
 *  3. when no group mentions `name` at all, the first `propstat` status, which
 *     is what a single-group response carries and preserves the previous reading
 *     for that case.
 *
 * @returns the status line, or `undefined` when the block carries none, which
 * RFC 4918 §14.22 makes equivalent to a success.
 */
function responseStatusFor(response: string, name: string): string | undefined {
  const responseStatus = ownStatus(response)
  if (responseStatus !== undefined) return responseStatus

  const propstats = propstatBlocks(response)
  for (const propstat of propstats) {
    if (propstat.names.has(name) && propstat.status !== undefined) return propstat.status
  }
  return propstats.find((propstat) => propstat.status !== undefined)?.status
}

/**
 * Rule 2 of {@link responseStatusFor} alone: the status of the group that
 * answers for `name`, with no fallback to a group that answers for nothing.
 *
 * For a reader that asks about **one** property, rule 3 is a safe reading of a
 * single-group response. For a reader that asks about *several* — a PROPFIND
 * member, whose response carries a group per status — rule 3 hands back the
 * status of whichever group came first, and `listCalendars()` then loses a
 * calendar depending on the server's group order. That is the order dependence
 * `responseStatusFor` exists to remove, so this reader does not use rule 3.
 *
 * @returns the answering group's status, or `undefined` when no group mentions
 * `name` or the mentioning group carries no status of its own.
 */
function groupStatusFor(response: string, name: string): string | undefined {
  return propstatBlocks(response)
    .find((propstat) => propstat.names.has(name) && propstat.status !== undefined)
    ?.status
}

/**
 * True when `block` carries an element with this local name, whatever its prefix,
 * empty or not.
 *
 * A shape check only: it must be applied to the `propstat` groups whose status
 * answered for the property, never to a whole `<response>`, or an empty element
 * in a failed group would be read as "the property is present, read its value
 * from the group that answers for it".
 */
function propertyIn(block: string, name: string): boolean {
  return new RegExp(`<${PREFIX}${name}(?:\\s[^>]*)?/?>`, "i").test(block)
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
  return calendarElementPattern().test(resourcetype)
}

/**
 * Match a `calendar` element by name, never a `calendar-*` neighbour.
 *
 * Two boundaries, and both are load-bearing:
 *
 *  - the name ends at `\s`, `/>` or `>` — `` does **not** end it, because `-`
 *    is not a word character, so `/<[^>]*\bcalendar\b[^>]*\/?>/i` matches
 *    `<C:calendar-color>` and `<C:calendar-description>` the moment either
 *    appears inside the `resourcetype`;
 *  - the name starts at `<` or at a prefix's `:`. A bare `calendar` substring
 *    also matches the tail of `supported-calendar-component-set`.
 */
function calendarElementPattern(): RegExp {
  return /<(?:[^<>:\s]*:)?calendar(?=[\s/>])/i
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
    // Rule 1 alone: the `<status>` a `<response>` itself carries is the status
    // of the request *for that member* (RFC 4918 §14.24). The group-level
    // answer is read below and **reported**, never turned into a silent drop —
    // a member whose `resourcetype` group failed while another group answered
    // `supported-calendar-component-set` is still a collection the server
    // declares as a calendar, and losing it here would be the quiet data loss
    // this reader exists to avoid.
    const responseStatus = ownStatus(block)
    if (responseStatus !== undefined && isFailureStatus(responseStatus)) continue

    const resourcetypeStatus = groupStatusFor(block, "resourcetype")

    const href = extractElementText(block, "href")
    if (href === undefined || href === "") continue

    const propstats = extractElementBlocks(block, "propstat")
    const succeeded = propstats.filter((propstat) => {
      const status = ownStatuses(propstat)[0]
      return status === undefined || !isFailureStatus(status)
    })
    if (propstats.length > 0 && succeeded.length === 0) {
      // Every property errored: a per-resource failure inside a 207. Skipping it
      // keeps a broken member from being reported as a calendar with no name.
      const status = ownStatuses(propstats[0]!)[0] ?? "unknown status"
      if (/\s404[\s.]/.test(status)) continue
      warnings.push(`skipped ${href}: properties failed with ${status}`)
      continue
    }

    // Properties are read from the groups that answered 2xx, and only from them:
    // a `404 propstat` for `getctag` says nothing about the `resourcetype` that
    // arrived in the group beside it, so it must not be handed to the readers as
    // if it carried properties at all. A response with no `propstat` at all is
    // read flat, which is the shape a simple server emits.
    const scope = succeeded.length > 0 ? succeeded.join("") : block

    const isCalendarResource = hasCalendarResourceType(scope)
    const { components, declared } = readSupportedComponents(scope)
    if (!isCalendarResource && !declared) continue

    const displayName = extractElementText(scope, "displayname") || lastPathSegment(href) ||
      "Unnamed"
    if (resourcetypeStatus !== undefined && isFailureStatus(resourcetypeStatus)) {
      // The group that answers for `resourcetype` — RFC 4791 §5.2's marker of a
      // calendar collection — reported a failure, yet another group declared
      // `supported-calendar-component-set`. The member is kept on that declared
      // set, and the disagreement is reported: silently dropping it would lose a
      // calendar, silently keeping it would hide an inconsistent server.
      warnings.push(
        `${href}: resourcetype answered ${resourcetypeStatus}; kept on its declared component set`,
      )
    }
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
    const blockStatus = responseStatusFor(block, "getetag")
    if (blockStatus !== undefined && isFailureStatus(blockStatus)) continue
    const href = extractElementText(block, "href")
    const etag = extractElementText(propstatAnswering(block, "getetag"), "getetag")
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
 *
 * The status used for that decision is the one governed by `calendar-data`,
 * resolved per response by {@link responseStatusFor}. Reading the first
 * `<status>` in the block at random read whichever `propstat` happened to come
 * first, so a server that answered `<D:getetag/>` with `404 Not Found` before the
 * group carrying the payload lost the whole resource — it was reported as a
 * failure and its `calendar-data` was never read.
 *
 * The payload itself is read from the group that *answers* for `calendar-data`,
 * so a present-but-empty element in a failed group cannot stand in for it.
 */
export function readReportResources(xml: string): {
  resources: { href: string; etag: string; calendarData: string }[]
  failures: { href: string; status: string }[]
} {
  const resources: { href: string; etag: string; calendarData: string }[] = []
  const failures: { href: string; status: string }[] = []
  for (const block of extractElementBlocks(xml, "response")) {
    const href = extractElementText(block, "href") ?? ""
    const status = responseStatusFor(block, "calendar-data")
    if (status !== undefined && isFailureStatus(status)) {
      failures.push({ href, status })
      continue
    }
    const scope = propstatAnswering(block, "calendar-data")
    const etag = extractElementText(scope, "getetag")
    const calendarData = extractElementText(scope, "calendar-data")
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
 *
 * **The rule, and it is total: this function never throws, and its result never
 * contains a code point that is not an XML 1.0 `Char` ({@link isXmlChar}).**
 * Every reference whose value falls outside that set — `&#x110000;` (above
 * `#x10FFFF`), `&#xD800;` (a surrogate), `&#xFFFF;` (a non-character), `&#x0;`,
 * `&#x8;`, `&#x7F;` — becomes {@link XML_ILLEGAL_REPLACEMENT} (`U+FFFD`), as does
 * an unpaired surrogate sitting in the surrounding text with no reference
 * involved.
 *
 * Why total rather than guarded: the input is untrusted network bytes, and the
 * previous implementation handed every reference to `String.fromCodePoint`, so a
 * single `&#x110000;` inside a `calendar-data` element threw `RangeError: Invalid
 * code point 1114112` straight out of `readReportResources`,
 * `CalDavClient.readReport` and `QueryEngine.queryTodos`. A public API must not
 * carry a throw on its input path that the caller cannot avoid by inspecting the
 * input.
 *
 * Why substitute rather than leave the reference undecoded: a value that decodes
 * to something with no XML representation is corrupt, and leaving the raw
 * `&#x110000;` would push that decision onto whichever layer reads the value next
 * — including the iCalendar parser, which would meet a literal `&` it never asked
 * for. `U+FFFD` is the one code point that says "corrupt" in a form every
 * downstream layer already handles. The cost is that corruption is silent: a
 * caller that needs to know must look for `U+FFFD` in the result.
 *
 * Scope note: only character references are decoded. `CDATA` sections are left
 * literal, which is why `parseCalendarPropfind` does not entity-decode property
 * text at all.
 *
 * @param value XML text to decode.
 * @returns Text carrying only legal XML 1.0 characters.
 */
export function decodeXmlEntities(value: string): string {
  const decoded = value.replaceAll(
    /&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
    (_whole, decimal: string | undefined, hex: string | undefined, named: string | undefined) => {
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
      // `isXmlChar` rejects NaN as well: every comparison against NaN is false,
      // so a reference that parsed to nothing takes the `U+FFFD` branch.
      return isXmlChar(code) ? String.fromCodePoint(code) : XML_ILLEGAL_REPLACEMENT
    },
  )
  // The text around the references is untrusted too: it can carry a bare NUL or
  // half a surrogate pair with no reference involved. `replace`, not `strip`:
  // see the note on `replaceIllegalXmlCharacters`.
  return replaceIllegalXmlCharacters(decoded)
}
