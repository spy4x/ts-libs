// Behaviour tests for the fetch-based client.
//
// No network: the transport is a stub, and every response is a literal written
// by hand. Where a request body matters, the assertion is on the recorded
// request (method, `Depth`, `If-Match`, body substring) rather than on a count.

import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { CalDavClient, httpError } from "./client.ts"
import { CalDavErrorCode, ComponentType } from "./types.ts"
import {
  FAKE_PASSWORD,
  FAKE_SERVER,
  FAKE_USERNAME,
  response,
  type StubTransport,
  stubTransport,
} from "./test-doubles.ts"

/** A multi-status body with no response blocks. */
const EMPTY_MULTISTATUS =
  `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:"></D:multistatus>`

const HOME_SET_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/user/</D:href>
    <D:propstat>
      <D:prop>
        <C:calendar-home-set><D:href>/user/calendars/</D:href></C:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

/** A multi-status body announcing one VTODO calendar at `/user/calendars/tasks/`. */
const CALENDARS_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/user/calendars/tasks/</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>Tasks</D:displayname>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
        <CS:getctag>ctag-1</CS:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

/** A multi-status body with no `calendar-home-set` property at all. */
const NO_HOME_SET_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/user/</D:href>
    <D:propstat>
      <D:prop/>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`

/** Build a client over a scripted transport. */
function client(transport: StubTransport): CalDavClient {
  return new CalDavClient({
    baseUrl: `${FAKE_SERVER}/`,
    username: FAKE_USERNAME,
    password: FAKE_PASSWORD,
    fetch: transport.fetch,
  })
}

Deno.test("listCalendars discovers the home set and lists a calendar", async () => {
  const transport = stubTransport([
    response(207, HOME_SET_BODY),
    response(207, CALENDARS_BODY),
  ])
  const result = await client(transport).listCalendars()
  assert(result.success)
  assertEquals(result.output.calendars.length, 1)
  assertEquals(result.output.calendars[0], {
    url: "https://caldav.example.com/user/calendars/tasks/",
    displayName: "Tasks",
    components: [ComponentType.VTODO],
    color: undefined,
    description: undefined,
    ctag: "ctag-1",
  })
  assertEquals(result.output.warnings, [])
  assertEquals(transport.requests.map((request) => request.url), [
    "https://caldav.example.com/",
    "https://caldav.example.com/user/calendars/",
  ])
  assertEquals(transport.requests.map((request) => request.method), ["PROPFIND", "PROPFIND"])
  assertEquals(transport.requests.map((request) => request.headers["depth"]), ["0", "1"])
})

Deno.test("the client sends Basic auth from its options, never from the environment", async () => {
  const transport = stubTransport([response(207, HOME_SET_BODY), response(207, CALENDARS_BODY)])
  await client(transport).listCalendars()
  const expected = `Basic ${btoa(`${FAKE_USERNAME}:${FAKE_PASSWORD}`)}`
  assertEquals(transport.requests[0]!.headers["authorization"], expected)
  assertEquals(transport.requests[0]!.headers["content-type"], "application/xml; charset=utf-8")
  assertStringIncludes(transport.requests[0]!.body!, "<D:propfind")
})

Deno.test("listCalendars falls back to /{username}/ when no home-set element is present", async () => {
  const transport = stubTransport([
    response(207, NO_HOME_SET_BODY),
    response(207, CALENDARS_BODY),
  ])
  const result = await client(transport).listCalendars()
  assert(result.success)
  assertEquals(result.output.calendars.length, 1)
  assertEquals(transport.requests[1]!.url, "https://caldav.example.com/user%40example.com/")
  assertEquals(result.output.warnings.length, 1)
  assertStringIncludes(result.output.warnings[0]!, "no calendar-home-set")
})

Deno.test("listCalendars falls back to /{username}/ when discovery is refused", async () => {
  const transport = stubTransport([
    response(404, "", { statusText: "Not Found" }),
    response(207, CALENDARS_BODY),
  ])
  const result = await client(transport).listCalendars()
  assert(result.success)
  assertEquals(result.output.calendars.length, 1)
  assertEquals(transport.requests[1]!.url, "https://caldav.example.com/user%40example.com/")
  assertStringIncludes(result.output.warnings[0]!, "PROPFIND calendar-home-set failed: 404")
})

Deno.test("listCalendars retries the listing against /{username}/ when the home set fails", async () => {
  const transport = stubTransport([
    response(207, HOME_SET_BODY),
    response(403, "", { statusText: "Forbidden" }),
    response(207, CALENDARS_BODY),
  ])
  const result = await client(transport).listCalendars()
  assert(result.success)
  assertEquals(result.output.calendars.length, 1)
  assertEquals(transport.requests[2]!.url, "https://caldav.example.com/user%40example.com/")
  assertStringIncludes(result.output.warnings.at(-1)!, "retrying against")
})

Deno.test("listCalendars fails when both the home set and the fallback fail", async () => {
  const transport = stubTransport([
    response(207, HOME_SET_BODY),
    response(503, "", { statusText: "Service Unavailable" }),
    response(503, "", { statusText: "Service Unavailable" }),
  ])
  const result = await client(transport).listCalendars()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.HTTP_STATUS)
  assertEquals(result.error.status, 503)
  // A partial answer is still handed back, so a caller that ignores `success`
  // sees an empty list rather than a crash.
  assertEquals(result.output?.calendars, [])
  assertEquals(result.output?.warnings.length, 1)
})

Deno.test("listCalendars reports a transport failure as TRANSPORT, not as no calendars", async () => {
  // Two rejections: the home-set attempt, then the /username/ retry that
  // discovery's transport failure triggers.
  const transport = stubTransport([
    { throws: new TypeError("connection refused") },
    { throws: new TypeError("connection refused") },
  ])
  const result = await client(transport).listCalendars()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.TRANSPORT)
  assertStringIncludes(result.error.message, "connection refused")
  assertStringIncludes(result.output!.warnings[0]!, "connection refused")
})

Deno.test("listCalendars reports a 401 as UNAUTHORIZED", async () => {
  const transport = stubTransport([
    response(401, "", { statusText: "Unauthorized" }),
    response(401, "", { statusText: "Unauthorized" }),
  ])
  const result = await client(transport).listCalendars()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.UNAUTHORIZED)
  assertEquals(result.error.status, 401)
})

Deno.test("listCalendars succeeds with no calendars when the server advertises none", async () => {
  const transport = stubTransport([
    response(207, HOME_SET_BODY),
    response(
      207,
      `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/user/</D:href>` +
        `<D:propstat><D:prop><D:resourcetype><D:collection/><D:principal/></D:resourcetype></D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`,
    ),
  ])
  const result = await client(transport).listCalendars()
  assert(result.success)
  assertEquals(result.output.calendars, [])
})

Deno.test("queryTodos REPORTs with Depth 1 and returns the multi-status body", async () => {
  const transport = stubTransport([response(207, CALENDARS_BODY)])
  const result = await client(transport).queryTodos(
    "https://caldav.example.com/user/calendars/tasks/",
    {
      status: "NEEDS-ACTION",
    },
  )
  assert(result.success)
  assertStringIncludes(result.output, "<D:multistatus")
  assertEquals(transport.requests[0]!.method, "REPORT")
  assertEquals(transport.requests[0]!.headers["depth"], "1")
  assertStringIncludes(transport.requests[0]!.body!, 'name="VTODO"')
  assertStringIncludes(transport.requests[0]!.body!, "NEEDS-ACTION")
})

Deno.test("queryEvents REPORTs a VEVENT calendar-query", async () => {
  const transport = stubTransport([response(207, EMPTY_MULTISTATUS)])
  const result = await client(transport).queryEvents(
    "https://caldav.example.com/user/calendars/work/",
    {
      dateFrom: "2026-07-01T00:00:00Z",
    },
  )
  assert(result.success)
  assertEquals(transport.requests[0]!.method, "REPORT")
  assertStringIncludes(transport.requests[0]!.body!, 'name="VEVENT"')
})

Deno.test("queryTodos surfaces a REPORT failure with its status and URL", async () => {
  const transport = stubTransport([response(500, "", { statusText: "Internal Server Error" })])
  const result = await client(transport).queryTodos(
    "https://caldav.example.com/user/calendars/tasks/",
  )
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.HTTP_STATUS)
  assertEquals(result.error.status, 500)
  assertEquals(result.error.url, "https://caldav.example.com/user/calendars/tasks/")
})

Deno.test("putIcal sends If-Match and returns the new ETag", async () => {
  const transport = stubTransport([
    response(204, "", { headers: { ETag: '"new-etag"' } }),
  ])
  const result = await client(transport).putIcal(
    "https://caldav.example.com/user/calendars/tasks/a.ics",
    "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    '"old-etag"',
  )
  assert(result.success)
  assertEquals(result.output.etag, '"new-etag"')
  assertEquals(result.output.url, "https://caldav.example.com/user/calendars/tasks/a.ics")
  assertEquals(transport.requests[0]!.headers["if-match"], '"old-etag"')
  assertEquals(transport.requests[0]!.headers["content-type"], "text/calendar; charset=utf-8")
  assertStringIncludes(transport.requests[0]!.body!, "BEGIN:VCALENDAR")
})

Deno.test("putIcal omits If-Match for a create and reports an empty ETag", async () => {
  const transport = stubTransport([response(201, "", { statusText: "Created" })])
  const result = await client(transport).putIcal(
    "https://caldav.example.com/user/calendars/tasks/b.ics",
    "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
  )
  assert(result.success)
  assertEquals(result.output.etag, "")
  assertEquals(transport.requests[0]!.headers["if-match"], undefined)
})

Deno.test("putIcal surfaces a stale If-Match as PRECONDITION_FAILED", async () => {
  const transport = stubTransport([response(412, "", { statusText: "Precondition Failed" })])
  const result = await client(transport).putIcal(
    "https://caldav.example.com/user/calendars/tasks/a.ics",
    "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
    '"stale"',
  )
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.PRECONDITION_FAILED)
  assertEquals(result.error.status, 412)
})

Deno.test("deleteResource sends DELETE with If-Match and succeeds on 204", async () => {
  const transport = stubTransport([response(204, "")])
  const result = await client(transport).deleteResource(
    "https://caldav.example.com/user/calendars/tasks/a.ics",
    '"etag-a"',
  )
  assert(result.success)
  assertEquals(transport.requests[0]!.method, "DELETE")
  assertEquals(transport.requests[0]!.headers["if-match"], '"etag-a"')
})

Deno.test("deleteResource reports a 404 as NOT_FOUND", async () => {
  const transport = stubTransport([response(404, "", { statusText: "Not Found" })])
  const result = await client(transport).deleteResource(
    "https://caldav.example.com/user/calendars/tasks/missing.ics",
  )
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.NOT_FOUND)
})

Deno.test("deleteResource reports a network error as TRANSPORT", async () => {
  const transport = stubTransport([{ throws: new Error("tls handshake failed") }])
  const result = await client(transport).deleteResource(
    "https://caldav.example.com/user/calendars/tasks/a.ics",
  )
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.TRANSPORT)
  assertStringIncludes(result.error.message, "tls handshake failed")
})

Deno.test("getIcalResource returns the body and the ETag header", async () => {
  const transport = stubTransport([
    response(200, "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", { headers: { ETag: '"e1"' } }),
  ])
  const result = await client(transport).getIcalResource(
    "https://caldav.example.com/user/calendars/tasks/a.ics",
  )
  assert(result.success)
  assertEquals(result.output.etag, '"e1"')
  assertStringIncludes(result.output.data, "BEGIN:VCALENDAR")
})

Deno.test("getIcalResource distinguishes a 404 from a transport failure", async () => {
  const missing = await client(stubTransport([response(404, "", { statusText: "Not Found" })]))
    .getIcalResource("https://caldav.example.com/user/calendars/tasks/gone.ics")
  assert(!missing.success)
  assertEquals(missing.error.code, CalDavErrorCode.NOT_FOUND)

  const broken = await client(stubTransport([{ throws: new Error("dns failure") }]))
    .getIcalResource("https://caldav.example.com/user/calendars/tasks/a.ics")
  assert(!broken.success)
  assertEquals(broken.error.code, CalDavErrorCode.TRANSPORT)
})

Deno.test("makeCalendar posts MKCALENDAR to an encoded collection name", async () => {
  const transport = stubTransport([response(201, "", { statusText: "Created" })])
  const result = await client(transport).makeCalendar(
    "https://caldav.example.com/user/calendars/",
    {
      displayName: "Work & Play",
      components: [ComponentType.VTODO],
    },
  )
  assert(result.success)
  assertEquals(result.output.url, "https://caldav.example.com/user/calendars/Work%20%26%20Play/")
  assertEquals(transport.requests[0]!.method, "MKCALENDAR")
  assertStringIncludes(transport.requests[0]!.body!, "<C:mkcalendar")
})

Deno.test("updateCalendar PROPPATCHes the supplied properties", async () => {
  const transport = stubTransport([response(207, EMPTY_MULTISTATUS)])
  const result = await client(transport).updateCalendar(
    "https://caldav.example.com/user/calendars/tasks/",
    { color: "#0000FFFF" },
  )
  assert(result.success)
  assertEquals(transport.requests[0]!.method, "PROPPATCH")
  assertStringIncludes(
    transport.requests[0]!.body!,
    "<CS:calendar-color>#0000FFFF</CS:calendar-color>",
  )
})

Deno.test("a multi-status REPORT body with a per-resource error is readable", async () => {
  const transport = stubTransport([
    response(
      207,
      `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
        `<D:response><D:href>/c/ok.ics</D:href><D:propstat><D:prop><D:getetag>"e1"</D:getetag>` +
        `<C:calendar-data>BEGIN:VCALENDAR&#13;&#10;BEGIN:VTODO&#13;&#10;UID:ok&#13;&#10;SUMMARY:s&#13;&#10;END:VTODO&#13;&#10;END:VCALENDAR&#13;&#10;</C:calendar-data>` +
        `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>` +
        `<D:response><D:href>/c/broken.ics</D:href><D:status>HTTP/1.1 500 Internal Server Error</D:status></D:response>` +
        `</D:multistatus>`,
    ),
  ])
  const result = await client(transport).queryTodos(
    "https://caldav.example.com/user/calendars/tasks/",
  )
  assert(result.success)
  const read = client(transport).readReport(result.output)
  assertEquals(read.resources.length, 1)
  assertEquals(read.failures, [{
    href: "/c/broken.ics",
    status: "HTTP/1.1 500 Internal Server Error",
  }])
})

Deno.test("client rejects an unusable base URL at construction", () => {
  let thrown: unknown
  try {
    new CalDavClient({
      baseUrl: "",
      username: FAKE_USERNAME,
      password: FAKE_PASSWORD,
      fetch: stubTransport([]).fetch,
    })
  } catch (cause) {
    thrown = cause
  }
  assert(thrown instanceof TypeError)
})

Deno.test("authorizationHeader is public so a sibling module needs no private access", () => {
  const instance = client(stubTransport([]))
  assertEquals(instance.authorizationHeader(), `Basic ${btoa(`${FAKE_USERNAME}:${FAKE_PASSWORD}`)}`)
  assertEquals(instance.user, FAKE_USERNAME)
  assertEquals(instance.rootUrl, FAKE_SERVER)
})

Deno.test("authorizationHeader is absent when no username is configured", () => {
  const instance = new CalDavClient({
    baseUrl: FAKE_SERVER,
    username: "",
    password: "",
    fetch: stubTransport([]).fetch,
  })
  assertEquals(instance.authorizationHeader(), undefined)
})

Deno.test("httpError maps the statuses a caller can act on to distinct codes", () => {
  const codes = [401, 404, 412, 500].map((status) =>
    httpError("PUT", "https://caldav.example.com/a.ics", response(status)).error.code
  )
  assertEquals(codes, [
    CalDavErrorCode.UNAUTHORIZED,
    CalDavErrorCode.NOT_FOUND,
    CalDavErrorCode.PRECONDITION_FAILED,
    CalDavErrorCode.HTTP_STATUS,
  ])
})

Deno.test("icalUid reads the UID of the component the document actually contains", () => {
  const document = [
    "BEGIN:VCALENDAR",
    "BEGIN:VTODO",
    "UID:real-uid",
    "SUMMARY:s",
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n")
  assertEquals(CalDavClient.icalUid(document), "real-uid")
  assertEquals(CalDavClient.icalUid("not a calendar"), undefined)
})
