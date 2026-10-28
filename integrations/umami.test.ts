import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import {
  checkUmami,
  checkUmamiWebsite,
  createUmamiLink,
  readUmamiEventValues,
  readUmamiMetrics,
  readUmamiPageviews,
  readUmamiStats,
  umamiLinkUrl,
} from "./umami.ts"

const TOKEN = "umami-secret-token-0123456789"
const BASE = "https://stats.example.com"
const ID = "019a3b1c-7d2e-7f00-8a00-0123456789ab"

interface Call {
  url: string
  method: string
  body: unknown
  authorization: string | null
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** A fetch stub that records every call and answers from `respond`. */
const stub = (respond: (call: Call, index: number) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    }
    calls.push(call)
    return Promise.resolve(respond(call, calls.length - 1))
  }) as typeof fetch
  return { calls, fetcher }
}

const LINK = {
  id: ID,
  name: "Linen shirt · Zalo group A",
  url: "https://shop.example/shirts/linen?utm_source=zalo-a",
  slug: "k3Jx9_Pq2a",
}

const stored = { ...LINK, userId: "u1", teamId: null, createdAt: "2026-10-28T10:00:00.000Z" }

Deno.test("creates a link with a bearer token and returns what Umami stored", async () => {
  const { calls, fetcher } = stub(() => json(stored))
  const result = await createUmamiLink({
    baseUrl: `${BASE}/`,
    token: TOKEN,
    ...LINK,
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: LINK, error: "" })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].url, `${BASE}/api/links`)
  assertEquals(calls[0].authorization, `Bearer ${TOKEN}`)
  assertEquals(calls[0].body, LINK)
})

Deno.test("keeps a base path, leaves out a missing id and sends the team id", async () => {
  const { calls, fetcher } = stub(() => json(stored))
  const { id: _id, ...withoutId } = LINK
  const result = await createUmamiLink({
    baseUrl: "https://example.com/umami",
    token: TOKEN,
    ...withoutId,
    teamId: "team-1",
    fetch: fetcher,
  })
  assert(result.success)
  assertEquals(calls[0].url, "https://example.com/umami/api/links")
  assertEquals(calls[0].body, { ...withoutId, teamId: "team-1" })
})

Deno.test("counts a refused create as done when the same link already exists under the id", async () => {
  const { calls, fetcher } = stub((call) =>
    call.method === "POST" ? json({ error: { message: "Internal error" } }, 500) : json(stored)
  )
  const result = await createUmamiLink({ baseUrl: BASE, token: TOKEN, ...LINK, fetch: fetcher })
  assertEquals(result, { success: true, output: LINK, error: "" })
  assertEquals(calls.map((call) => `${call.method} ${call.url}`), [
    `POST ${BASE}/api/links`,
    `GET ${BASE}/api/links/${ID}`,
  ])
  assertEquals(calls[1].authorization, `Bearer ${TOKEN}`)
})

Deno.test("fails when the id is taken by a link with another slug", async () => {
  const { fetcher } = stub((call) =>
    call.method === "POST" ? json({}, 500) : json({ ...stored, slug: "other-slug" })
  )
  const result = await createUmamiLink({ baseUrl: BASE, token: TOKEN, ...LINK, fetch: fetcher })
  assertEquals(result.success, false)
  assertEquals(result.output, null)
  assertStringIncludes(result.error, "HTTP 500")
  assertStringIncludes(result.error, "another slug or url")
})

Deno.test("reports the create's failure when nothing exists under the id", async () => {
  const { fetcher } = stub((call) =>
    call.method === "POST"
      ? json({ error: { message: "That slug is already taken." } }, 400)
      : json({ error: { message: "Not found" } }, 404)
  )
  const result = await createUmamiLink({ baseUrl: BASE, token: TOKEN, ...LINK, fetch: fetcher })
  assertEquals(result, {
    success: false,
    output: null,
    error: "create failed (HTTP 400: That slug is already taken.)",
  })
})

Deno.test("does not look for an existing link when no id was given", async () => {
  const { calls, fetcher } = stub(() => json({ error: { message: "Unauthorized" } }, 401))
  const { id: _id, ...withoutId } = LINK
  const result = await createUmamiLink({
    baseUrl: BASE,
    token: TOKEN,
    ...withoutId,
    fetch: fetcher,
  })
  assertEquals(result.error, "create failed (HTTP 401: Unauthorized)")
  assertEquals(calls.length, 1)
})

Deno.test("never puts the token into an error, even when Umami echoes it", async () => {
  const { fetcher } = stub(() =>
    json({ error: { message: `bad token\n${TOKEN} for ${TOKEN.slice(0, 5)}` } }, 403)
  )
  const { id: _id, ...withoutId } = LINK
  const result = await createUmamiLink({
    baseUrl: BASE,
    token: TOKEN,
    ...withoutId,
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assert(!result.error.includes(TOKEN), result.error)
  assertStringIncludes(result.error, "HTTP 403: bad token <REDACTED:TOKEN>")
})

Deno.test("fails on a 200 answer that is not a link", async () => {
  const { fetcher } = stub(() => json({ ok: true }))
  const result = await createUmamiLink({ baseUrl: BASE, token: TOKEN, ...LINK, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "not a link")
})

Deno.test("reports a timeout and a transport error without throwing", async () => {
  const timeout = stub(() => Promise.reject(new DOMException("timed out", "TimeoutError")))
  const timedOut = await createUmamiLink({
    baseUrl: BASE,
    token: TOKEN,
    ...LINK,
    fetch: timeout.fetcher,
    requestTimeoutMs: 1234,
  })
  assertEquals(timedOut.error, "request failed (request timed out after 1234 ms)")

  const broken = stub(() => Promise.reject(new TypeError(`connect failed with ${TOKEN}`)))
  const failed = await createUmamiLink({
    baseUrl: BASE,
    token: TOKEN,
    ...LINK,
    fetch: broken.fetcher,
  })
  assertEquals(failed.success, false)
  assert(!failed.error.includes(TOKEN), failed.error)
})

Deno.test("refuses bad options before sending anything", async () => {
  const { calls, fetcher } = stub(() => json(stored))
  const cases: [Record<string, unknown>, string][] = [
    [{ baseUrl: "ftp://stats.example.com" }, "baseUrl"],
    [{ baseUrl: "https://stats.example.com/?x=1" }, "baseUrl"],
    [{ token: " " }, "token"],
    [{ id: "not-a-uuid" }, "id"],
    [{ name: "" }, "name"],
    [{ name: "x".repeat(101) }, "name"],
    [{ url: "javascript:alert(1)" }, "url"],
    [{ url: `https://shop.example/${"x".repeat(500)}` }, "url"],
    [{ slug: "short" }, "slug"],
    [{ slug: "has/slash-in-it" }, "slug"],
    [{ teamId: "" }, "teamId"],
    [{ requestTimeoutMs: 0 }, "requestTimeoutMs"],
  ]
  for (const [change, field] of cases) {
    const result = await createUmamiLink(
      {
        baseUrl: BASE,
        token: TOKEN,
        ...LINK,
        fetch: fetcher,
        ...change,
      } as Parameters<typeof createUmamiLink>[0],
    )
    assertEquals(result.success, false, field)
    assertStringIncludes(result.error, `invalid options: ${field}`)
  }
  assertEquals(calls.length, 0)
})

Deno.test("checkUmami succeeds only on a heartbeat that says ok", async () => {
  const up = stub(() => json({ ok: true }))
  assertEquals(await checkUmami({ baseUrl: BASE, fetch: up.fetcher }), {
    success: true,
    output: "Umami answers",
    error: "",
  })
  assertEquals(up.calls[0].url, `${BASE}/api/heartbeat`)
  assertEquals(up.calls[0].authorization, null)

  const notOk = stub(() => json({ ok: false }))
  assertEquals((await checkUmami({ baseUrl: BASE, fetch: notOk.fetcher })).success, false)

  const down = stub(() => new Response("Bad gateway", { status: 502 }))
  assertEquals(
    (await checkUmami({ baseUrl: BASE, fetch: down.fetcher })).error,
    "heartbeat failed (HTTP 502)",
  )

  const gone = stub(() => Promise.reject(new TypeError("connection refused")))
  assertEquals((await checkUmami({ baseUrl: BASE, fetch: gone.fetcher })).success, false)
})

Deno.test("umamiLinkUrl is the instance's /q/ address of the slug", () => {
  assertEquals(umamiLinkUrl(`${BASE}/`, "k3Jx9_Pq2a"), `${BASE}/q/k3Jx9_Pq2a`)
  assertEquals(
    umamiLinkUrl("https://example.com/umami", "k3Jx9_Pq2a"),
    "https://example.com/umami/q/k3Jx9_Pq2a",
  )
  assertThrows(() => umamiLinkUrl(BASE, "../admin"), TypeError)
  assertThrows(() => umamiLinkUrl("not a url", "k3Jx9_Pq2a"), TypeError)
})

const WEBSITE = "019a3b1c-7d2e-7f00-8a00-00000000beef"
const PERIOD = { startAt: 1_000, endAt: 2_000 }
const READ = { baseUrl: BASE, token: TOKEN, websiteId: WEBSITE, ...PERIOD }
const TOTALS = { pageviews: 50, visitors: 20, visits: 30, bounces: 4, totaltime: 900 }

Deno.test("readUmamiStats reads the period's totals and the previous period's", async () => {
  const { calls, fetcher } = stub(() =>
    json({ ...TOTALS, comparison: { ...TOTALS, visits: "12" } })
  )
  const result = await readUmamiStats({ ...READ, filters: { utmSource: "zalo-a" }, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { ...TOTALS, comparison: { ...TOTALS, visits: 12 } },
    error: "",
  })
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].authorization, `Bearer ${TOKEN}`)
  assertEquals(
    calls[0].url,
    `${BASE}/api/websites/${WEBSITE}/stats?utmSource=eq.zalo-a&startAt=1000&endAt=2000`,
  )
})

Deno.test("readUmamiStats fails on an answer without the previous period", async () => {
  const { fetcher } = stub(() => json(TOTALS))
  const result = await readUmamiStats({ ...READ, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "not the expected shape")
})

Deno.test("readUmamiMetrics reads a breakdown by type, with a null value as empty", async () => {
  const { calls, fetcher } = stub(() => json([{ x: "order-zalo", y: 3 }, { x: null, y: 1 }]))
  const result = await readUmamiMetrics({ ...READ, type: "event", limit: 50, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: [{ x: "order-zalo", y: 3 }, { x: "", y: 1 }],
    error: "",
  })
  assertEquals(
    calls[0].url,
    `${BASE}/api/websites/${WEBSITE}/metrics?startAt=1000&endAt=2000&type=event&limit=50`,
  )
})

Deno.test("readUmamiPageviews reads both series and the previous period's", async () => {
  const series = { pageviews: [{ x: "2026-10-01 00:00:00", y: 5 }], sessions: [] }
  const { calls, fetcher } = stub(() => json({ ...series, compare: series }))
  const result = await readUmamiPageviews({
    ...READ,
    unit: "day",
    timezone: "Asia/Ho_Chi_Minh",
    compare: true,
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: { ...series, compare: series }, error: "" })
  const url = new URL(calls[0].url)
  assertEquals(url.searchParams.get("unit"), "day")
  assertEquals(url.searchParams.get("timezone"), "Asia/Ho_Chi_Minh")
  assertEquals(url.searchParams.get("compare"), "prev")
})

Deno.test("readUmamiPageviews answers no previous period when none was asked for", async () => {
  const { calls, fetcher } = stub(() => json({ pageviews: [], sessions: [] }))
  const result = await readUmamiPageviews({ ...READ, unit: "day", timezone: "UTC", fetch: fetcher })
  assertEquals(result.output, { pageviews: [], sessions: [], compare: null })
  assertEquals(new URL(calls[0].url).searchParams.has("compare"), false)
})

Deno.test("readUmamiEventValues reads the values of one event's property", async () => {
  const { calls, fetcher } = stub(() => json([{ value: "linen-shirt", total: 4 }]))
  const result = await readUmamiEventValues({
    ...READ,
    eventName: "order-zalo",
    propertyName: "item",
    fetch: fetcher,
  })
  assertEquals(result.output, [{ value: "linen-shirt", total: 4 }])
  const url = new URL(calls[0].url)
  assertEquals(url.pathname, `/api/websites/${WEBSITE}/event-data/values`)
  assertEquals(url.searchParams.get("eventName"), "order-zalo")
  assertEquals(url.searchParams.get("propertyName"), "item")
})

Deno.test("a read failure carries the status and never the token", async () => {
  const { fetcher } = stub(() => json({ error: { message: `bad ${TOKEN}` } }, 401))
  const result = await readUmamiStats({ ...READ, fetch: fetcher })
  assertEquals(result.success, false)
  assert(!result.success && result.status === 401)
  assert(!result.error.includes(TOKEN))
  assertStringIncludes(result.error, "<REDACTED:TOKEN>")
})

Deno.test("a read that cannot reach Umami has no status", async () => {
  const fetcher = (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch
  const result = await readUmamiMetrics({ ...READ, type: "path", fetch: fetcher })
  assert(!result.success && result.status === null)
  assertStringIncludes(result.error, "request failed")
})

Deno.test("a read refuses a website id that is no UUID and a reversed period", async () => {
  const { calls, fetcher } = stub(() => json({}))
  const badId = await readUmamiStats({ ...READ, websiteId: "../me", fetch: fetcher })
  const reversed = await readUmamiStats({ ...READ, startAt: 3_000, fetch: fetcher })
  assertStringIncludes(badId.error, "websiteId must be a UUID")
  assertStringIncludes(reversed.error, "startAt first")
  assertEquals(calls.length, 0)
})

Deno.test("checkUmamiWebsite answers the website's id and name", async () => {
  const { calls, fetcher } = stub(() => json({ id: WEBSITE, name: "Shop", domain: "x" }))
  const result = await checkUmamiWebsite({
    baseUrl: BASE,
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: { id: WEBSITE, name: "Shop" }, error: "" })
  assertEquals(calls[0].url, `${BASE}/api/websites/${WEBSITE}`)
})

Deno.test("checkUmamiWebsite names a refused token", async () => {
  const { calls, fetcher } = stub(() => json({ error: { message: "Unauthorized" } }, 401))
  const result = await checkUmamiWebsite({
    baseUrl: BASE,
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assert(!result.success && result.problem === "token")
  assertEquals(calls.map((call) => new URL(call.url).pathname), [
    `/api/websites/${WEBSITE}`,
    "/api/me",
  ])
})

Deno.test("checkUmamiWebsite names a website the working token cannot see", async () => {
  const { fetcher } = stub((call) =>
    call.url.endsWith("/api/me") ? json({ user: { id: "u1" } }) : json({}, 401)
  )
  const result = await checkUmamiWebsite({
    baseUrl: BASE,
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assert(!result.success && result.problem === "website")
})

Deno.test("checkUmamiWebsite names a missing website for an admin's token", async () => {
  const { fetcher } = stub(() => json(null))
  const result = await checkUmamiWebsite({
    baseUrl: BASE,
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assert(!result.success && result.problem === "website")
})

Deno.test("checkUmamiWebsite calls an outage unreachable without asking about the token", async () => {
  const { calls, fetcher } = stub((call) =>
    call.url.endsWith("/api/me") ? json({ user: { id: "u1" } }) : json({}, 503)
  )
  const result = await checkUmamiWebsite({
    baseUrl: BASE,
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assert(!result.success && result.problem === "unreachable")
  assertEquals(calls.length, 1)
})

Deno.test("a filter is sent as an exact match, even when it looks like an operator", async () => {
  const { calls, fetcher } = stub(() => json([]))
  await readUmamiMetrics({ ...READ, type: "event", filters: { path: "c.shirts" }, fetch: fetcher })
  assertEquals(new URL(calls[0].url).searchParams.get("path"), "eq.c.shirts")
})

Deno.test("a filter with a comma, an empty one or an unknown name is refused unsent", async () => {
  const { calls, fetcher } = stub(() => json([]))
  const comma = await readUmamiMetrics({
    ...READ,
    type: "event",
    filters: { utmSource: "zalo-a,facebook" },
    fetch: fetcher,
  })
  const empty = await readUmamiStats({ ...READ, filters: { utmSource: "" }, fetch: fetcher })
  const unknown = await readUmamiStats({
    ...READ,
    filters: { startAt: "0" } as unknown as Record<"path", string>,
    fetch: fetcher,
  })
  assertStringIncludes(comma.error, "without a comma")
  assertStringIncludes(empty.error, "without a comma")
  assertStringIncludes(unknown.error, "not a filter Umami takes")
  assertEquals(calls.length, 0)
})

Deno.test("a read refuses a bad type, limit, unit, time zone or event name unsent", async () => {
  const { calls, fetcher } = stub(() => json([]))
  const results = await Promise.all([
    readUmamiMetrics({ ...READ, type: "city" as "path", fetch: fetcher }),
    readUmamiMetrics({ ...READ, type: "path", limit: 0, fetch: fetcher }),
    readUmamiMetrics({ ...READ, type: "path", limit: 2.5, fetch: fetcher }),
    readUmamiPageviews({ ...READ, unit: "week" as "day", timezone: "UTC", fetch: fetcher }),
    readUmamiPageviews({ ...READ, unit: "day", timezone: "Mars/Olympus", fetch: fetcher }),
    readUmamiEventValues({ ...READ, eventName: " ", propertyName: "item", fetch: fetcher }),
    readUmamiEventValues({ ...READ, eventName: "order-zalo", propertyName: "", fetch: fetcher }),
  ])
  for (const result of results) assertStringIncludes(result.error, "invalid options")
  assertEquals(calls.length, 0)
})

Deno.test("checkUmamiWebsite calls options that cannot work a settings problem", async () => {
  const { calls, fetcher } = stub(() => json({}))
  const noUrl = await checkUmamiWebsite({
    baseUrl: "ftp://stats.example.com",
    token: TOKEN,
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  const noToken = await checkUmamiWebsite({
    baseUrl: BASE,
    token: " ",
    websiteId: WEBSITE,
    fetch: fetcher,
  })
  assert(!noUrl.success && noUrl.problem === "settings")
  assert(!noToken.success && noToken.problem === "settings")
  assertEquals(calls.length, 0)
})
