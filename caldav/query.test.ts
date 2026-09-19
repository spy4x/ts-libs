// Behaviour tests for the query fan-out and the aggregators.
//
// The clock is always injected and the transport is always a stub, so nothing
// here depends on the host timezone or on a network. The aggregation tests use
// tasks constructed directly, not tasks parsed out of a document, so a bug in
// the iCalendar reader cannot make an aggregation assertion pass or fail for the
// wrong reason.

import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { CalDavClient } from "./client.ts"
import {
  aggregateEvents,
  aggregateTodos,
  calendarNameFromUrl,
  EVENT_LIMIT,
  filterByPriority,
  QueryEngine,
  TODO_LIMIT,
} from "./query.ts"
import type { Event, Todo } from "./types.ts"
import { CalDavErrorCode, RelatedType, TodoStatus } from "./types.ts"
import {
  FAKE_PASSWORD,
  FAKE_SERVER,
  FAKE_USERNAME,
  FIXED_NOW,
  response,
  type ScriptedResponse,
  type StubTransport,
  stubTransport,
} from "./test-doubles.ts"

const TASKS_URL = "https://caldav.example.com/user/calendars/tasks/"
const WORK_URL = "https://caldav.example.com/user/calendars/work/"

/** A multi-status PROPFIND body advertising the given calendars. */
function calendarsBody(calendars: { href: string; name: string; components: string[] }[]): string {
  const blocks = calendars.map((calendar) =>
    `<D:response><D:href>${calendar.href}</D:href><D:propstat><D:prop>` +
    `<D:displayname>${calendar.name}</D:displayname>` +
    `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>` +
    `<C:supported-calendar-component-set>${
      calendar.components.map((name) => `<C:comp name="${name}"/>`).join("")
    }</C:supported-calendar-component-set>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  ).join("")
  return `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${blocks}</D:multistatus>`
}

/** Wrap one iCalendar resource into a `calendar-query` multi-status body. */
function reportBody(resources: { href: string; etag: string; ical: string }[]): string {
  const blocks = resources.map((resource) =>
    `<D:response><D:href>${resource.href}</D:href><D:propstat><D:prop>` +
    `<D:getetag>${resource.etag}</D:getetag>` +
    `<C:calendar-data>${escapeForXml(resource.ical)}</C:calendar-data>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  ).join("")
  return `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${blocks}</D:multistatus>`
}

/** Escape an iCalendar document the way a server embeds it in `calendar-data`. */
function escapeForXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("\r\n", "&#13;&#10;")
}

/** A VTODO document with the given UID and overrides. */
function todoIcal(uid: string, extra: string[] = []): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VTODO",
    `UID:${uid}`,
    "SUMMARY:Task " + uid,
    ...extra,
    "END:VTODO",
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n"
}

/** Build an engine over a scripted transport. */
function engine(
  script: ScriptedResponse[],
  options: { now?: Date } = {},
): { engine: QueryEngine; transport: StubTransport } {
  const transport = stubTransport(script)
  const client = new CalDavClient({
    baseUrl: `${FAKE_SERVER}/`,
    username: FAKE_USERNAME,
    password: FAKE_PASSWORD,
    fetch: transport.fetch,
  })
  return { engine: new QueryEngine({ client, now: options.now ?? FIXED_NOW }), transport }
}

/** Script a home-set discovery, a calendar listing and two REPORTs, in that order. */
function twoCalendarScript(
  tasksReport: ScriptedResponse,
  workReport: ScriptedResponse,
): ScriptedResponse[] {
  return [
    response(207, homeSetBody()),
    response(
      207,
      calendarsBody([
        { href: "/user/calendars/tasks/", name: "Tasks", components: ["VTODO"] },
        { href: "/user/calendars/work/", name: "Work", components: ["VTODO"] },
      ]),
    ),
    tasksReport,
    workReport,
  ]
}

/** A home-set PROPFIND body pointing at `/user/calendars/`. */
function homeSetBody(): string {
  return `<?xml version="1.0" encoding="utf-8" ?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">` +
    `<D:response><D:href>/user/</D:href><D:propstat><D:prop>` +
    `<C:calendar-home-set><D:href>/user/calendars/</D:href></C:calendar-home-set>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>`
}

/** A task with only the fields an aggregation test cares about. */
function task(overrides: Partial<Todo> = {}): Todo {
  return {
    summary: "s",
    status: TodoStatus.NEEDS_ACTION,
    statusLabel: "NEEDS-ACTION",
    url: "https://caldav.example.com/user/calendars/tasks/a.ics",
    etag: '"e1"',
    calendarName: "Tasks",
    uid: "a",
    ...overrides,
  }
}

/** An event with only the fields an aggregation test cares about. */
function event(overrides: Partial<Event> = {}): Event {
  return {
    summary: "e",
    start: "2026-07-04T09:00:00Z",
    end: "2026-07-04T10:00:00Z",
    url: "https://caldav.example.com/user/calendars/work/e.ics",
    etag: '"e1"',
    calendarName: "Work",
    uid: "e",
    ...overrides,
  }
}

Deno.test("queryTodos fans out over both calendars and returns every task", async () => {
  const { engine: query, transport } = engine(
    twoCalendarScript(
      response(
        207,
        reportBody([{ href: "/user/calendars/tasks/a.ics", etag: '"e-a"', ical: todoIcal("a") }]),
      ),
      response(
        207,
        reportBody([{ href: "/user/calendars/work/b.ics", etag: '"e-b"', ical: todoIcal("b") }]),
      ),
    ),
  )
  const result = await query.queryTodos()
  assert(result.success)
  assertEquals(result.output.total, 2)
  assertEquals(result.output.todos.map((todo) => todo.summary).sort(), ["Task a", "Task b"])
  assertEquals(result.output.failures, undefined)
  assertEquals(transport.requests.map((request) => request.url), [
    `${FAKE_SERVER}/`,
    `${FAKE_SERVER}/user/calendars/`,
    TASKS_URL,
    WORK_URL,
  ])
})

Deno.test("queryTodos isolates one failing calendar and still returns the other's tasks", async () => {
  const { engine: query } = engine(
    twoCalendarScript(
      response(500, "", { statusText: "Internal Server Error" }),
      response(
        207,
        reportBody([{ href: "/user/calendars/work/b.ics", etag: '"e-b"', ical: todoIcal("b") }]),
      ),
    ),
  )
  const result = await query.queryTodos()
  assert(result.success)
  assertEquals(result.output.total, 1)
  assertEquals(result.output.todos[0]!.calendarName, "Work")
  assertEquals(result.output.failures?.length, 1)
  assertEquals(result.output.failures?.[0]?.calendarName, "Tasks")
  assertEquals(result.output.failures?.[0]?.error.status, 500)
})

Deno.test("queryTodos reports a partial failure for every calendar, not silence", async () => {
  const { engine: query } = engine(
    twoCalendarScript(
      { throws: new TypeError("connection reset") },
      { throws: new TypeError("connection reset") },
    ),
  )
  const result = await query.queryTodos()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.TRANSPORT)
  // The partial aggregate is still handed back, so a caller that ignores
  // `success` is not left guessing why the list is empty.
  assertEquals(result.output?.todos, [])
  assertEquals(result.output?.failures?.length, 2)
})

Deno.test("queryTodos distinguishes an empty calendar from a failed one", async () => {
  const { engine: query } = engine(
    twoCalendarScript(
      response(
        207,
        `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"></D:multistatus>`,
      ),
      response(503, "", { statusText: "Service Unavailable" }),
    ),
  )
  const result = await query.queryTodos()
  assert(result.success)
  assertEquals(result.output.total, 0)
  assertEquals(result.output.failures?.length, 1)
  assertEquals(result.output.failures?.[0]?.error.code, CalDavErrorCode.HTTP_STATUS)
})

Deno.test("queryTodos requires no listCalendars call when a URL is given explicitly", async () => {
  const { engine: query, transport } = engine([
    response(
      207,
      reportBody([{ href: "/user/calendars/tasks/a.ics", etag: '"e-a"', ical: todoIcal("a") }]),
    ),
  ])
  const result = await query.queryTodos({ calendarUrl: TASKS_URL })
  assert(result.success)
  assertEquals(transport.requests.length, 1)
  assertEquals(transport.requests[0]!.url, TASKS_URL)
  assertEquals(result.output.todos[0]!.calendarName, "tasks")
})

Deno.test("queryTodos attaches the ETag the REPORT reported to each task", async () => {
  const { engine: query } = engine([
    response(
      207,
      reportBody([
        { href: "/user/calendars/tasks/a.ics", etag: '"etag-a"', ical: todoIcal("a") },
        { href: "/user/calendars/tasks/b%20c.ics", etag: 'W/"etag-b"', ical: todoIcal("b c") },
      ]),
    ),
  ])
  const result = await query.queryTodos({ calendarUrl: TASKS_URL })
  assert(result.success)
  assertEquals(result.output.todos.map((todo) => todo.etag), ['"etag-a"', 'W/"etag-b"'])
})

Deno.test("queryTodos applies the priority filter client-side", async () => {
  const { engine: query } = engine([
    response(
      207,
      reportBody([
        { href: "/c/a.ics", etag: '"1"', ical: todoIcal("a", ["PRIORITY:1"]) },
        { href: "/c/b.ics", etag: '"2"', ical: todoIcal("b", ["PRIORITY:5"]) },
        { href: "/c/c.ics", etag: '"3"', ical: todoIcal("c", ["PRIORITY:9"]) },
        { href: "/c/d.ics", etag: '"4"', ical: todoIcal("d") },
      ]),
    ),
  ])
  const result = await query.queryTodos({ calendarUrl: TASKS_URL, priority: { min: 2, max: 6 } })
  assert(result.success)
  assertEquals(result.output.todos.map((todo) => todo.summary), ["Task b"])
  assertEquals(result.output.total, 1)
})

Deno.test("queryTodos passes the server-side filters into the REPORT body", async () => {
  const { engine: query, transport } = engine([
    response(207, `<D:multistatus xmlns:D="DAV:"></D:multistatus>`),
  ])
  await query.queryTodos({
    calendarUrl: TASKS_URL,
    status: "IN-PROCESS",
    text: "report",
    dueBefore: "2026-07-04T00:00:00Z",
  })
  const body = transport.requests[0]!.body!
  assertStringIncludes(body, '<C:text-match collation="i;ascii-casemap">IN-PROCESS</C:text-match>')
  assertStringIncludes(body, "report")
  assertStringIncludes(body, 'end="20260704T000000Z"')
  assertEquals(body.includes("PRIORITY"), false)
})

Deno.test("queryTodos returns an empty success when no calendar advertises VTODO", async () => {
  const { engine: query } = engine([
    response(207, homeSetBody()),
    response(
      207,
      calendarsBody([{ href: "/user/calendars/work/", name: "Work", components: ["VEVENT"] }]),
    ),
  ])
  const result = await query.queryTodos()
  assert(result.success)
  assertEquals(result.output.total, 0)
  assertEquals(result.output.failures, undefined)
})

Deno.test("queryTodos fails when the calendar listing itself fails", async () => {
  const { engine: query } = engine([
    response(207, homeSetBody()),
    response(401, "", { statusText: "Unauthorized" }),
    response(401, "", { statusText: "Unauthorized" }),
  ])
  const result = await query.queryTodos()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.UNAUTHORIZED)
  assertEquals(result.error.status, 401)
  // Both requests that can fail here are retried against the `/username/`
  // fallback, so the failure carries the URL the last attempt used.
  assertEquals(result.error.url, `${FAKE_SERVER}/user%40example.com/`)
  // The listing's failure carries its own partial `{calendars, warnings}`.
  // Forwarding it as this result's `output` would hand a caller an object with no
  // `todos` field at all, typed as if it had one, so the output must be absent.
  assertEquals(result.output, undefined)
})

Deno.test("queryEvents fails the same way when the calendar listing fails", async () => {
  const { engine: query } = engine([
    response(207, homeSetBody()),
    response(403, "", { statusText: "Forbidden" }),
    response(403, "", { statusText: "Forbidden" }),
  ])
  const result = await query.queryEvents()
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.UNAUTHORIZED)
  assertEquals(result.output, undefined)
})

Deno.test("a whole-fan-out failure keeps a well-shaped partial aggregate", async () => {
  // The other half of the same rule: when the *query* lost every calendar, the
  // partial output is this stage's own and does have the declared shape, so it
  // travels.
  const { engine: query, transport } = engine([
    response(207, homeSetBody()),
    response(
      207,
      calendarsBody([{ href: "/user/calendars/tasks/", name: "Tasks", components: ["VTODO"] }]),
    ),
    response(500, "", { statusText: "Internal Server Error" }),
  ])
  const result = await query.queryTodos()
  assert(!result.success)
  assertEquals(transport.requests.length, 3)
  assertEquals(result.output?.todos, [])
  assertEquals(result.output?.total, 0)
  assertEquals(result.output?.failures?.length, 1)
  assertEquals(result.output?.byPriority, { high: 0, medium: 0, low: 0, none: 0 })
})

Deno.test("getTodo drops the fetched resource's partial body when the parse fails", async () => {
  // `getIcalResource` hands back `{data, etag}` on failure paths it never
  // reaches, and the engine must not forward that as a `Todo | null` output.
  const { engine: query } = engine([response(200, "not an iCalendar document")])
  const result = await query.getTodo(`${TASKS_URL}a.ics`)
  assert(!result.success)
  assertEquals(result.output, undefined)
})

Deno.test("a calendar whose every resource failed is reported as a calendar failure", async () => {
  const { engine: query } = engine([
    response(
      207,
      `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/c/a.ics</D:href>` +
        `<D:status>HTTP/1.1 500 Internal Server Error</D:status></D:response></D:multistatus>`,
    ),
  ])
  const result = await query.queryTodos({ calendarUrl: TASKS_URL })
  assert(!result.success)
  assertEquals(result.output?.failures?.length, 1)
  assertStringIncludes(result.output!.failures![0]!.error.message, "every resource failed")
})

Deno.test("queryEvents fans out, extracts ETags and falls back to DTSTART for the end", async () => {
  const ical = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Standup",
    "DTSTART:2026-07-02T09:00:00Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n") + "\r\n"
  const { engine: query } = engine([
    response(207, reportBody([{ href: "/c/e1.ics", etag: '"evt-1"', ical }])),
  ])
  const result = await query.queryEvents({ calendarUrl: WORK_URL })
  assert(result.success)
  assertEquals(result.output.total, 1)
  assertEquals(result.output.upcoming, 1)
  assertEquals(result.output.events[0]!.etag, '"evt-1"')
  assertEquals(result.output.events[0]!.end, "2026-07-02T09:00:00Z")
})

Deno.test("queryEvents isolates a failing calendar", async () => {
  const eventIcal = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:e1",
    "SUMMARY:Home event",
    "DTSTART:2026-07-02T09:00:00Z",
    "DTEND:2026-07-02T10:00:00Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  const transport = stubTransport([
    response(207, homeSetBody()),
    response(
      207,
      calendarsBody([
        { href: "/user/calendars/work/", name: "Work", components: ["VEVENT"] },
        { href: "/user/calendars/home/", name: "Home", components: ["VEVENT"] },
      ]),
    ),
    response(500, "", { statusText: "Internal Server Error" }),
    response(
      207,
      reportBody([{ href: "/user/calendars/home/e.ics", etag: '"1"', ical: eventIcal }]),
    ),
  ])
  const client = new CalDavClient({
    baseUrl: `${FAKE_SERVER}/`,
    username: FAKE_USERNAME,
    password: FAKE_PASSWORD,
    fetch: transport.fetch,
  })
  const result = await new QueryEngine({ client, now: FIXED_NOW }).queryEvents()
  assert(result.success)
  assertEquals(result.output.total, 1)
  assertEquals(result.output.upcoming, 1)
  assertEquals(result.output.events[0]!.calendarName, "Home")
  assertEquals(result.output.failures, [{
    calendarName: "Work",
    url: WORK_URL,
    error: {
      code: CalDavErrorCode.HTTP_STATUS,
      message: "REPORT VEVENT failed: 500 Internal Server Error",
      status: 500,
      url: WORK_URL,
    },
  }])
})

Deno.test("getTodo returns ok(null) for a 404 and a failure for a transport error", async () => {
  const missing = await engine([response(404, "", { statusText: "Not Found" })])
    .engine.getTodo(`${TASKS_URL}a.ics`)
  assert(missing.success)
  assertEquals(missing.output, null)

  const broken = await engine([{ throws: new Error("socket hang up") }]).engine.getTodo(
    `${TASKS_URL}a.ics`,
  )
  assert(!broken.success)
  assertEquals(broken.error.code, CalDavErrorCode.TRANSPORT)
})

Deno.test("getTodo reads a single resource and its ETag header", async () => {
  const { engine: query } = engine([
    response(200, todoIcal("a", ["STATUS:IN-PROCESS", "DUE;VALUE=DATE:2026-07-02"]), {
      headers: { ETag: '"single-etag"' },
    }),
  ])
  const result = await query.getTodo(`${TASKS_URL}a.ics`)
  assert(result.success)
  assertEquals(result.output?.uid, "a")
  assertEquals(result.output?.status, TodoStatus.IN_PROCESS)
  assertEquals(result.output?.due, "2026-07-02")
  assertEquals(result.output?.etag, '"single-etag"')
  assertEquals(result.output?.calendarName, "tasks")
})

Deno.test("getTodo fails on an unreadable body instead of returning null", async () => {
  const { engine: query } = engine([response(200, "not an iCalendar document")])
  const result = await query.getTodo(`${TASKS_URL}a.ics`)
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.PARSE)
})

Deno.test("createTodo PUTs the built document and returns the resource URL and ETag", async () => {
  const { engine: query, transport } = engine([
    response(201, "", { statusText: "Created", headers: { ETag: '"new"' } }),
  ])
  const result = await query.createTodo(TASKS_URL, { summary: "Write the test" })
  assert(result.success)
  assertEquals(result.output.etag, '"new"')
  assertStringIncludes(result.output.url, TASKS_URL)
  assertEquals(result.output.url.endsWith(".ics"), true)
  assertStringIncludes(transport.requests[0]!.body!, "SUMMARY:Write the test")
  assertEquals(transport.requests[0]!.headers["if-match"], undefined)
})

Deno.test("createTodo reports a builder argument fault instead of throwing", async () => {
  const { engine: query } = engine([])
  const result = await query.createTodo(TASKS_URL, { summary: "  " })
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.INVALID_ARGUMENT)
  assertStringIncludes(result.error.message, "summary is required")
})

Deno.test("updateTodo GETs, rewrites with the same UID and sends If-Match", async () => {
  const { engine: query, transport } = engine([
    response(200, todoIcal("a"), { headers: { ETag: '"e1"' } }),
    response(204, "", { headers: { ETag: '"e2"' } }),
  ])
  const result = await query.updateTodo(`${TASKS_URL}a.ics`, '"e1"', { summary: "Renamed" })
  assert(result.success)
  assertEquals(result.output.etag, '"e2"')
  assertEquals(transport.requests[1]!.method, "PUT")
  assertEquals(transport.requests[1]!.headers["if-match"], '"e1"')
  assertStringIncludes(transport.requests[1]!.body!, "UID:a")
  assertStringIncludes(transport.requests[1]!.body!, "SUMMARY:Renamed")
})

Deno.test("updateTodo reports PRECONDITION_FAILED when the resource moved on", async () => {
  const { engine: query } = engine([
    response(200, todoIcal("a"), { headers: { ETag: '"e1"' } }),
    response(412, "", { statusText: "Precondition Failed" }),
  ])
  const result = await query.updateTodo(`${TASKS_URL}a.ics`, '"stale"', { summary: "Renamed" })
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.PRECONDITION_FAILED)
  assertEquals(result.error.status, 412)
})

Deno.test("updateTodo reports NOT_FOUND when the resource is gone", async () => {
  const { engine: query } = engine([response(404, "", { statusText: "Not Found" })])
  const result = await query.updateTodo(`${TASKS_URL}gone.ics`, '"e1"', { summary: "x" })
  assert(!result.success)
  assertEquals(result.error.code, CalDavErrorCode.NOT_FOUND)
})

Deno.test("deleteTodo and deleteEvent send DELETE with If-Match", async () => {
  const { engine: query, transport } = engine([response(204, ""), response(204, "")])
  const todo = await query.deleteTodo(`${TASKS_URL}a.ics`, '"e1"')
  const event = await query.deleteEvent(`${WORK_URL}e.ics`, '"e2"')
  assert(todo.success)
  assert(event.success)
  assertEquals(transport.requests.map((request) => request.method), ["DELETE", "DELETE"])
  assertEquals(transport.requests.map((request) => request.headers["if-match"]), ['"e1"', '"e2"'])
})

Deno.test("aggregateTodos counts statuses by the label the server reported", () => {
  const aggregate = aggregateTodos([
    task({ uid: "a", statusLabel: "NEEDS-ACTION" }),
    task({ uid: "b", statusLabel: "NEEDS-ACTION" }),
    task({ uid: "c", statusLabel: "COMPLETED" }),
    task({ uid: "d", statusLabel: "X-CUSTOM" }),
  ], FIXED_NOW)
  assertEquals(aggregate.byStatus, { "NEEDS-ACTION": 2, COMPLETED: 1, "X-CUSTOM": 1 })
  assertEquals(aggregate.total, 4)
  assertEquals(aggregate.uids, ["a", "b", "c", "d"])
})

Deno.test("aggregateTodos bands priority 1-3, 4-6, 7-9 and none", () => {
  const aggregate = aggregateTodos([
    task({ uid: "1", priority: 1 }),
    task({ uid: "2", priority: 3 }),
    task({ uid: "3", priority: 4 }),
    task({ uid: "4", priority: 6 }),
    task({ uid: "5", priority: 7 }),
    task({ uid: "6", priority: 9 }),
    task({ uid: "7" }),
  ], FIXED_NOW)
  assertEquals(aggregate.byPriority, { high: 2, medium: 2, low: 2, none: 1 })
})

Deno.test("aggregateTodos counts a task due before now as overdue and keeps counts at the boundary", () => {
  const aggregate = aggregateTodos([
    task({ uid: "before", due: "2026-07-01T11:59:59Z" }),
    task({ uid: "equal", due: "2026-07-01T12:00:00Z" }),
    task({ uid: "after", due: "2026-07-01T12:00:01Z" }),
  ], FIXED_NOW)
  // Strictly before: a task due exactly now is not yet late.
  assertEquals(aggregate.overdue, 1)
})

Deno.test("aggregateTodos does not count a completed or cancelled task as overdue", () => {
  const aggregate = aggregateTodos([
    task({
      uid: "done",
      due: "2026-06-01T00:00:00Z",
      status: TodoStatus.COMPLETED,
      statusLabel: "COMPLETED",
    }),
    task({
      uid: "cancelled",
      due: "2026-06-01T00:00:00Z",
      status: TodoStatus.CANCELLED,
      statusLabel: "CANCELLED",
    }),
    task({
      uid: "in-process",
      due: "2026-06-01T00:00:00Z",
      status: TodoStatus.IN_PROCESS,
      statusLabel: "IN-PROCESS",
    }),
  ], FIXED_NOW)
  assertEquals(aggregate.overdue, 1)
})

Deno.test("aggregateTodos truncates at TODO_LIMIT and flags it", () => {
  const tasks = Array.from(
    { length: TODO_LIMIT + 1 },
    (_, index) => task({ uid: `u${index}`, url: `https://caldav.example.com/c/u${index}.ics` }),
  )
  const aggregate = aggregateTodos(tasks, FIXED_NOW)
  assertEquals(aggregate.total, TODO_LIMIT + 1)
  assertEquals(aggregate.truncated, true)
  assertEquals(aggregate.todos.length, TODO_LIMIT)
  assertEquals(aggregate.byStatus["NEEDS-ACTION"], TODO_LIMIT + 1)
})

Deno.test("aggregateTodos does not flag truncation exactly at TODO_LIMIT", () => {
  const tasks = Array.from({ length: TODO_LIMIT }, (_, index) => task({ uid: `u${index}` }))
  const aggregate = aggregateTodos(tasks, FIXED_NOW)
  assertEquals(aggregate.truncated, false)
  assertEquals(aggregate.todos.length, TODO_LIMIT)
})

Deno.test("aggregateTodos honours an injected limit and keeps total authoritative", () => {
  const aggregate = aggregateTodos(
    [task({ uid: "a" }), task({ uid: "b" }), task({ uid: "c" })],
    FIXED_NOW,
    2,
  )
  assertEquals(aggregate.todos.length, 2)
  assertEquals(aggregate.total, 3)
  assertEquals(aggregate.truncated, true)
})

Deno.test("aggregateEvents counts an event starting exactly now as upcoming and truncates", () => {
  const events = Array.from(
    { length: EVENT_LIMIT + 2 },
    (_, index) => event({ uid: `e${index}`, start: "2026-07-01T12:00:00Z" }),
  )
  const aggregate = aggregateEvents(events, FIXED_NOW)
  assertEquals(aggregate.upcoming, EVENT_LIMIT + 2)
  assertEquals(aggregate.truncated, true)
  assertEquals(aggregate.events.length, EVENT_LIMIT)
})

Deno.test("aggregateEvents never counts an unreadable start as upcoming", () => {
  const aggregate = aggregateEvents([event({ start: "" })], FIXED_NOW)
  assertEquals(aggregate.upcoming, 0)
  assertEquals(aggregate.total, 1)
})

Deno.test("filterByPriority treats an omitted bound as open", () => {
  const tasks = [
    task({ uid: "a", priority: 1 }),
    task({ uid: "b", priority: 5 }),
    task({ uid: "c" }),
  ]
  assertEquals(filterByPriority(tasks, { max: 5 }).map((entry) => entry.uid), ["a", "b"])
  assertEquals(filterByPriority(tasks, { min: 5 }).map((entry) => entry.uid), ["b"])
  assertEquals(filterByPriority(tasks, {}).map((entry) => entry.uid), ["a", "b"])
})

Deno.test("calendarNameFromUrl reads the last path segment", () => {
  assertEquals(calendarNameFromUrl(TASKS_URL), "tasks")
  assertEquals(calendarNameFromUrl(`${TASKS_URL}a.ics`), "tasks")
  assertEquals(calendarNameFromUrl(`${TASKS_URL}sub/`), "sub")
  assertEquals(calendarNameFromUrl("https://caldav.example.com/"), "caldav.example.com")
})

Deno.test("summarized todos carry the status label, the ETag and the related edges", async () => {
  const { engine: query } = engine([
    response(
      207,
      reportBody([{
        href: "/c/a.ics",
        etag: '"e1"',
        ical: todoIcal("a", [
          "STATUS:IN-PROCESS",
          "RELATED-TO;RELTYPE=PARENT:p1",
          "RELATED-TO;RELTYPE=PARENT:p1",
        ]),
      }]),
    ),
  ])
  const result = await query.queryTodos({ calendarUrl: TASKS_URL })
  assert(result.success)
  assertEquals(result.output.todos[0]!.status, "IN-PROCESS")
  assertEquals(result.output.todos[0]!.etag, '"e1"')
  assertEquals(result.output.todos[0]!.relatedTo, [{ uid: "p1", reltype: RelatedType.PARENT }])
  assertEquals(result.output.byStatus, { "IN-PROCESS": 1 })
})
