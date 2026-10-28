import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { checkUmami, createUmamiLink, umamiLinkUrl } from "./umami.ts"

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
