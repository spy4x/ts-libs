// Behaviour tests for the CalDAV request bodies and the response readers.
//
// The readers are exercised against **hand-written** multi-status fixtures, never
// against this package's own builders: a reader tested only on its own writer's
// output would pass even if both sides agreed on a wrong namespace or a wrong
// nesting. Builder output is checked structurally (balanced markup, via
// `assertWellFormedXml`) and on literal substrings.

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import {
  CALDAV_NAMESPACE,
  CALENDARSERVER_NAMESPACE,
  decodeXmlEntities,
  escapeXml,
  extractElementBlocks,
  extractElementText,
  extractEtags,
  hasCalendarResourceType,
  mkcalendar,
  normalizeEtag,
  parseCalendarPropfind,
  propfindCalendarHomeSet,
  propfindCalendars,
  proppatchCalendar,
  readReportResources,
  readSupportedComponents,
  reportEvents,
  reportTodos,
  resolveUrl,
  resourceName,
  XML_PROLOG,
} from "./xml.ts"
import { ComponentType } from "./types.ts"
import { assertWellFormedXml } from "./test-doubles.ts"

const BASE = "https://caldav.example.com/"

/** One `<response>` block, with a prefix the caller chooses. */
function responseBlock(options: {
  prefix?: string
  href: string
  displayName?: string
  components?: string[] | null
  color?: string
  ctag?: string
  status?: string
}): string {
  const p = options.prefix ?? "D:"
  const components = options.components === null || options.components === undefined
    ? ""
    : `<${p}supported-calendar-component-set>` +
      options.components.map((name) => `<${p}comp name="${name}"/>`).join("") +
      `</${p}supported-calendar-component-set>`
  const displayName = options.displayName === undefined
    ? ""
    : `<${p}displayname>${options.displayName}</${p}displayname>`
  const color = options.color === undefined
    ? ""
    : `<CS:calendar-color>${options.color}</CS:calendar-color>`
  const ctag = options.ctag === undefined ? "" : `<CS:getctag>${options.ctag}</CS:getctag>`
  return `<${p}response>${options.status ?? ""}<${p}href>${options.href}</${p}href>` +
    `<${p}propstat><${p}prop><${p}resourcetype><${p}collection/><C:calendar/></${p}resourcetype>` +
    `${displayName}${components}${color}${ctag}</${p}prop>` +
    `<${p}status>HTTP/1.1 200 OK</${p}status></${p}propstat></${p}response>`
}

/** Wrap blocks in a multi-status envelope with the given namespace declarations. */
function multistatus(
  blocks: string,
  declarations = 'xmlns:D="DAV:" xmlns:C="' + CALDAV_NAMESPACE + '"',
): string {
  return `<?xml version="1.0" encoding="utf-8" ?><D:multistatus ${declarations}>${blocks}</D:multistatus>`
}

Deno.test("propfindCalendars emits balanced XML with a literal property list", () => {
  const body = propfindCalendars()
  assertWellFormedXml(body)
  assert(body.startsWith(XML_PROLOG))
  assertStringIncludes(body, '<D:propfind xmlns:D="DAV:"')
  assertStringIncludes(body, `<C:supported-calendar-component-set/>`)
  assertStringIncludes(body, "<CS:getctag/>")
  assertStringIncludes(body, "<D:resourcetype/>")
})

Deno.test("propfindCalendarHomeSet asks for the home set at Depth 0", () => {
  const body = propfindCalendarHomeSet()
  assertWellFormedXml(body)
  assertStringIncludes(body, "<C:calendar-home-set/>")
  assertStringIncludes(body, "<D:displayname/>")
  assertEquals(body.includes("supported-calendar-component-set"), false)
})

Deno.test("reportTodos emits an unfiltered VTODO query as a self-closing comp-filter", () => {
  const body = reportTodos()
  assertWellFormedXml(body)
  assertStringIncludes(
    body,
    '<C:comp-filter name="VCALENDAR"><C:comp-filter name="VTODO"/></C:comp-filter>',
  )
  assertStringIncludes(body, "<D:getetag/>")
  assertStringIncludes(body, "<C:calendar-data/>")
})

Deno.test("reportTodos escapes a text filter and treats ALL as no filter", () => {
  const body = reportTodos({ status: "NEEDS-ACTION", text: 'a & "b" <c>' })
  assertWellFormedXml(body)
  assertStringIncludes(
    body,
    '<C:prop-filter name="STATUS"><C:text-match collation="i;ascii-casemap">NEEDS-ACTION</C:text-match></C:prop-filter>',
  )
  assertStringIncludes(body, "a &amp; &quot;b&quot; &lt;c&gt;")
  assertEquals(reportTodos({ status: "ALL" }).includes("text-match"), false)
})

Deno.test("reportTodos renders a dueBefore bound as a CalDAV time-range", () => {
  const body = reportTodos({ dueBefore: "2026-07-04T09:00:00Z" })
  assertWellFormedXml(body)
  assertStringIncludes(body, '<C:time-range start="19700101T000000Z" end="20260704T090000Z"/>')
})

Deno.test("reportTodos rejects an unparseable date instead of emitting Invalid Date text", () => {
  assertThrows(() => reportTodos({ dueBefore: "not a date" }), TypeError)
})

Deno.test("reportEvents defaults the range bounds and escapes the text filter", () => {
  const body = reportEvents({ dateFrom: "2026-07-01T00:00:00Z" })
  assertWellFormedXml(body)
  assertStringIncludes(body, 'start="20260701T000000Z" end="20991231T235959Z"')
  assertStringIncludes(body, '<C:comp-filter name="VEVENT">')
  assertStringIncludes(reportEvents({ dateTo: "2026-07-31T00:00:00Z" }), 'start="19700101T000000Z"')
})

Deno.test("mkcalendar emits a MKCALENDAR body with a declared empty component set", () => {
  const body = mkcalendar({ displayName: "Tasks" })
  assertWellFormedXml(body)
  assertStringIncludes(body, "<C:mkcalendar")
  assertStringIncludes(body, "<D:displayname>Tasks</D:displayname>")
  assertStringIncludes(
    body,
    "<C:supported-calendar-component-set></C:supported-calendar-component-set>",
  )
  assertEquals(body.includes("calendar-color"), false)
})

Deno.test("mkcalendar emits an explicit component set and a color", () => {
  const body = mkcalendar({
    displayName: "Tasks & Notes",
    components: [ComponentType.VTODO, ComponentType.VEVENT],
    color: "#FF0000FF",
    description: "a < b",
  })
  assertWellFormedXml(body)
  assertStringIncludes(body, '<C:comp name="VTODO"/><C:comp name="VEVENT"/>')
  assertStringIncludes(body, `<CS:calendar-color>#FF0000FF</CS:calendar-color>`)
  assertStringIncludes(body, "<D:description>a &lt; b</D:description>")
})

Deno.test("proppatchCalendar emits only the supplied properties", () => {
  const body = proppatchCalendar({ displayName: "Renamed" })
  assertWellFormedXml(body)
  assertStringIncludes(body, "<D:propertyupdate")
  assertStringIncludes(body, "<D:displayname>Renamed</D:displayname>")
  assertStringIncludes(body, `${CALENDARSERVER_NAMESPACE}`)
  assertEquals(body.includes("description"), false)
})

Deno.test("proppatchCalendar rejects a request with no property to set", () => {
  assertThrows(() => proppatchCalendar({}), TypeError)
})

Deno.test("escapeXml escapes the five predefined entities and drops XML-invalid controls", () => {
  assertEquals(escapeXml(`<&>"'`), "&lt;&amp;&gt;&quot;&apos;")
  assertEquals(escapeXml("a\u0000b\u0008c"), "abc")
  assertEquals(escapeXml("tab\tkept"), "tab\tkept")
})

Deno.test("parseCalendarPropfind reads a prefixed multi-status response", () => {
  const xml = multistatus(
    responseBlock({
      href: "/user/calendars/tasks/",
      displayName: "Tasks",
      components: ["VTODO"],
      color: "#FF0000FF",
      ctag: "ctag-1",
    }),
    `xmlns:D="DAV:" xmlns:C="${CALDAV_NAMESPACE}" xmlns:CS="${CALENDARSERVER_NAMESPACE}"`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars, [{
    url: "https://caldav.example.com/user/calendars/tasks/",
    displayName: "Tasks",
    components: [ComponentType.VTODO],
    color: "#FF0000FF",
    description: undefined,
    ctag: "ctag-1",
  }])
})

Deno.test("parseCalendarPropfind ignores namespace prefixes entirely", () => {
  const href = "/user/calendars/tasks/"
  const lowercase = multistatus(
    `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname>` +
      `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>` +
      `<c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>` +
      `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
    `xmlns:d="DAV:" xmlns:c="${CALDAV_NAMESPACE}"`,
  )
  const unprefixed = multistatus(
    `<response><href>${href}</href><propstat><prop><displayname>Tasks</displayname>` +
      `<resourcetype><collection/><calendar xmlns="${CALDAV_NAMESPACE}"/></resourcetype>` +
      `<supported-calendar-component-set><comp xmlns="${CALDAV_NAMESPACE}" name="VTODO"/></supported-calendar-component-set>` +
      `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`,
    `xmlns="DAV:"`,
  )
  const noisy = multistatus(
    `<A:response xmlns:A="DAV:" xmlns:B="${CALDAV_NAMESPACE}"><A:href>${href}</A:href>` +
      `<A:propstat><A:prop><A:displayname>Tasks</A:displayname>` +
      `<A:resourcetype><A:collection/><B:calendar/></A:resourcetype>` +
      `<B:supported-calendar-component-set><B:comp name="VTODO"/></B:supported-calendar-component-set>` +
      `</A:prop><A:status>HTTP/1.1 200 OK</A:status></A:propstat></A:response>`,
  )

  for (const xml of [lowercase, unprefixed, noisy]) {
    const parsed = parseCalendarPropfind(xml, BASE)
    assert(parsed.success, `failed to parse: ${xml.slice(0, 80)}`)
    assertEquals(parsed.output.calendars.length, 1, `failed to parse: ${xml.slice(0, 80)}`)
    assertEquals(parsed.output.calendars[0]!.displayName, "Tasks")
    assertEquals(parsed.output.calendars[0]!.components, [ComponentType.VTODO])
  }
})

Deno.test("parseCalendarPropfind trusts an explicitly empty component set", () => {
  const empty = multistatus(
    `<D:response><D:href>/user/calendars/empty/</D:href><D:propstat><D:prop>` +
      `<D:displayname>Empty</D:displayname>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<C:supported-calendar-component-set></C:supported-calendar-component-set>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(empty, BASE)
  assert(parsed.success)
  // Trusting the server here is load-bearing: substituting [VEVENT, VTODO] would
  // send a VTODO REPORT to a collection that accepts neither.
  assertEquals(parsed.output.calendars[0]!.components, [])
})

Deno.test("parseCalendarPropfind trusts a self-closing empty component set", () => {
  const empty = multistatus(
    `<D:response><D:href>/user/calendars/empty/</D:href><D:propstat><D:prop>` +
      `<D:displayname>Empty</D:displayname>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<C:supported-calendar-component-set/>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(empty, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars[0]!.components, [])
})

Deno.test("parseCalendarPropfind falls back to VEVENT and VTODO only when the set is absent", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/calendars/tasks/</D:href><D:propstat><D:prop>` +
      `<D:displayname>Tasks</D:displayname>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars[0]!.components, [ComponentType.VEVENT, ComponentType.VTODO])
  assertEquals(parsed.output.warnings.length, 1)
  assertStringIncludes(parsed.output.warnings[0]!, "no supported-calendar-component-set")
})

Deno.test("parseCalendarPropfind skips a principal collection without a calendar resourcetype", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/</D:href><D:propstat><D:prop>` +
      `<D:displayname>user</D:displayname>` +
      `<D:resourcetype><D:collection/><D:principal/></D:resourcetype>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars, [])
})

Deno.test("parseCalendarPropfind does not mistake a calendar-color for a calendar resourcetype", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/plain/</D:href><D:propstat><D:prop>` +
      `<D:displayname>Plain</D:displayname>` +
      `<D:resourcetype><D:collection/></D:resourcetype>` +
      `<CS:calendar-color>#00FF00FF</CS:calendar-color>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
    `xmlns:D="DAV:" xmlns:CS="${CALENDARSERVER_NAMESPACE}"`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars, [])
})

Deno.test("parseCalendarPropfind reads every response block in a two-calendar body", () => {
  const xml = multistatus(
    responseBlock({ href: "/user/calendars/a/", displayName: "A", components: ["VTODO"] }) +
      responseBlock({ href: "/user/calendars/b/", displayName: "B", components: ["VEVENT"] }),
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars.map((calendar) => calendar.displayName), ["A", "B"])
  assertEquals(parsed.output.calendars.map((calendar) => calendar.url), [
    "https://caldav.example.com/user/calendars/a/",
    "https://caldav.example.com/user/calendars/b/",
  ])
})

Deno.test("parseCalendarPropfind reads an absolute href and an absolute URL href alike", () => {
  const xml = multistatus(
    responseBlock({
      href: "https://caldav.example.com/user/calendars/abs/",
      displayName: "Abs",
      components: ["VTODO"],
    }) +
      responseBlock({ href: "/user/calendars/root/", displayName: "Root", components: ["VTODO"] }),
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars.map((calendar) => calendar.url), [
    "https://caldav.example.com/user/calendars/abs/",
    "https://caldav.example.com/user/calendars/root/",
  ])
})

Deno.test("parseCalendarPropfind skips a response whose own status is a failure", () => {
  const xml = multistatus(
    responseBlock({
      href: "/user/calendars/broken/",
      displayName: "Broken",
      components: ["VTODO"],
      status: "<D:status>HTTP/1.1 500 Internal Server Error</D:status>",
    }) +
      responseBlock({ href: "/user/calendars/ok/", displayName: "OK", components: ["VTODO"] }),
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars.map((calendar) => calendar.displayName), ["OK"])
})

Deno.test("parseCalendarPropfind skips a resource whose only propstat reports 404", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/calendars/gone/</D:href><D:propstat><D:prop>` +
      `<C:supported-calendar-component-set/>` +
      `</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars, [])
})

Deno.test("parseCalendarPropfind fails when the body carries no response element", () => {
  const parsed = parseCalendarPropfind("<html><body>502 Bad Gateway</body></html>", BASE)
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "no <response> element")
})

Deno.test("parseCalendarPropfind fails on an empty body rather than reporting no calendars", () => {
  const parsed = parseCalendarPropfind("", BASE)
  assert(!parsed.success)
  assertStringIncludes(parsed.error.message, "empty")
})

Deno.test("parseCalendarPropfind reads CDATA and a whitespace-wrapped value", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/calendars/a/</D:href><D:propstat><D:prop>` +
      `<D:displayname><![CDATA[Tasks & Notes]]></D:displayname>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<C:supported-calendar-component-set>\n      <C:comp name="VTODO"/>\n    </C:supported-calendar-component-set>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars[0]!.displayName, "<![CDATA[Tasks & Notes]]>")
  assertEquals(parsed.output.calendars[0]!.components, [ComponentType.VTODO])
})

Deno.test("parseCalendarPropfind reads an entity-escaped value", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/calendars/a/</D:href><D:propstat><D:prop>` +
      `<D:displayname>Tasks &amp; Notes</D:displayname>` +
      `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
      `<C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars[0]!.displayName, "Tasks &amp; Notes")
  assertEquals(decodeXmlEntities(parsed.output.calendars[0]!.displayName), "Tasks & Notes")
})

Deno.test("parseCalendarPropfind reads an extra xmlns declaration without losing the block", () => {
  const xml = multistatus(
    responseBlock({ href: "/user/calendars/a/", displayName: "A", components: ["VTODO"] }),
    `xmlns:D="DAV:" xmlns:C="${CALDAV_NAMESPACE}" xmlns:x="urn:example:extra"`,
  )
  const parsed = parseCalendarPropfind(xml, BASE)
  assert(parsed.success)
  assertEquals(parsed.output.calendars.length, 1)
})

Deno.test("readSupportedComponents reports whether the server declared the set", () => {
  assertEquals(readSupportedComponents("<C:supported-calendar-component-set/>"), {
    components: [],
    declared: true,
  })
  assertEquals(
    readSupportedComponents(
      "<C:supported-calendar-component-set></C:supported-calendar-component-set>",
    ),
    {
      components: [],
      declared: true,
    },
  )
  assertEquals(readSupportedComponents('<D:prop><C:comp name="VJOURNAL"/></D:prop>'), {
    components: [ComponentType.VJOURNAL],
    declared: false,
  })
})

Deno.test("hasCalendarResourceType requires an empty calendar element, not a substring", () => {
  assertEquals(
    hasCalendarResourceType("<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>"),
    true,
  )
  assertEquals(hasCalendarResourceType("<D:resourcetype><D:collection/></D:resourcetype>"), false)
  assertEquals(hasCalendarResourceType("<CS:calendar-color>#FF0000FF</CS:calendar-color>"), false)
})

Deno.test("extractElementText reads the first occurrence and ignores prefixes", () => {
  assertEquals(extractElementText("<D:href>/a/</D:href>", "href"), "/a/")
  assertEquals(extractElementText("<href>/a/</href>", "href"), "/a/")
  assertEquals(extractElementText("<d:href>/a/</d:href>", "href"), "/a/")
  assertEquals(extractElementText("<href>  /a/  </href>", "href"), "/a/")
  assertEquals(extractElementText("<href>/a/</href><href>/b/</href>", "href"), "/a/")
  assertEquals(extractElementText("<other>x</other>", "href"), undefined)
})

Deno.test("extractElementBlocks returns every block, not the first for all entries", () => {
  const xml = "<response><href>/a/</href></response><response><href>/b/</href></response>"
  assertEquals(extractElementBlocks(xml, "response").length, 2)
  assertEquals(extractElementText(extractElementBlocks(xml, "response")[1]!, "href"), "/b/")
})

Deno.test("resolveUrl handles absolute URLs, absolute paths and relative paths", () => {
  assertEquals(
    resolveUrl("/user/calendars/a/", BASE),
    "https://caldav.example.com/user/calendars/a/",
  )
  assertEquals(
    resolveUrl("https://other.example.org/a/", BASE),
    "https://other.example.org/a/",
  )
  assertEquals(
    resolveUrl("a/", "https://caldav.example.com/user/"),
    "https://caldav.example.com/user/a/",
  )
  assertEquals(resolveUrl("", BASE), BASE)
})

Deno.test("resolveUrl rejects a base URL that is not absolute", () => {
  assertThrows(() => resolveUrl("/a/", "not-a-url"), TypeError)
})

Deno.test("extractEtags keys by resource name and skips a failed response", () => {
  const xml = multistatus(
    `<D:response><D:href>/user/calendars/tasks/a.ics</D:href><D:propstat><D:prop>` +
      `<D:getetag>"etag-a"</D:getetag>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
      `<D:response><D:href>/user/calendars/tasks/b%20c.ics</D:href><D:propstat><D:prop>` +
      `<D:getetag>W/"etag-b"</D:getetag>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
      `<D:response><D:href>/user/calendars/tasks/gone.ics</D:href>` +
      `<D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
  )
  const etags = extractEtags(xml)
  assertEquals(etags.get("a"), '"etag-a"')
  assertEquals(etags.get("b c"), 'W/"etag-b"')
  assertEquals(etags.has("gone"), false)
})

Deno.test("resourceName strips the .ics suffix and decodes the path segment", () => {
  assertEquals(resourceName("/user/calendars/tasks/a.ics"), "a")
  assertEquals(resourceName("/user/calendars/tasks/a%40b.ics"), "a@b")
  assertEquals(resourceName("/user/calendars/tasks/a.ics?x=1"), "a")
})

Deno.test("normalizeEtag trims whitespace but keeps the weak marker and quotes", () => {
  assertEquals(normalizeEtag('  W/"abc"\n'), 'W/"abc"')
  assertEquals(normalizeEtag('"abc"'), '"abc"')
})

Deno.test("readReportResources separates a failed member from a readable one", () => {
  const xml = multistatus(
    `<D:response><D:href>/c/a.ics</D:href><D:propstat><D:prop>` +
      `<D:getetag>"e1"</D:getetag><C:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR&#13;&#10;</C:calendar-data>` +
      `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
      `<D:response><D:href>/c/b.ics</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`,
  )
  const { resources, failures } = readReportResources(xml)
  assertEquals(resources.length, 1)
  assertEquals(resources[0]!.etag, '"e1"')
  assertStringIncludes(resources[0]!.calendarData, "BEGIN:VCALENDAR\r\n")
  assertEquals(failures, [{ href: "/c/b.ics", status: "HTTP/1.1 404 Not Found" }])
})

Deno.test("decodeXmlEntities decodes named and numeric references", () => {
  assertEquals(decodeXmlEntities("a &amp; b &lt;c&gt; &#13;&#10; &#x41;"), "a & b <c> \r\n A")
  assertEquals(decodeXmlEntities("no entities &unknown; here"), "no entities &unknown; here")
})
