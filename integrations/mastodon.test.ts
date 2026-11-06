import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { postMastodonStatus, readMastodonStatusResults } from "./mastodon.ts"

const TOKEN = "s3cr3t-MASTODON-token"
const INSTANCE = "https://social.example.com"

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: unknown
}

/** A fetch stub that records every call and answers the n-th call with `respond(n)`. */
const stub = (respond: (n: number) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return Promise.resolve(respond(calls.length))
  }) as typeof fetch
  return { calls, fetcher }
}

const recorder = () => {
  const waits: number[] = []
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const created = () =>
  json({
    id: "109",
    url: "https://social.example.com/@seed/109",
    uri: "https://social.example.com/users/seed/statuses/109",
  })

const POST = {
  instanceUrl: INSTANCE,
  accessToken: TOKEN,
  status: "New post: https://example.com/blog/hello",
  idempotencyKey: "post-0192",
}

Deno.test("posts the status with the bearer token and idempotency key and returns id and url", async () => {
  const { calls, fetcher } = stub(created)
  const result = await postMastodonStatus({
    ...POST,
    language: "en",
    visibility: "unlisted",
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { id: "109", url: "https://social.example.com/@seed/109" },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://social.example.com/api/v1/statuses")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`)
  assertEquals(calls[0].headers.get("idempotency-key"), "post-0192")
  assertEquals(calls[0].headers.get("content-type"), "application/json")
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].body, {
    status: "New post: https://example.com/blog/hello",
    visibility: "unlisted",
    language: "en",
  })
})

Deno.test("leaves unset visibility and language out of the body", async () => {
  const { calls, fetcher } = stub(created)
  await postMastodonStatus({ ...POST, fetch: fetcher })
  assertEquals(calls[0].body, { status: POST.status })
})

Deno.test("retries a 5xx with the same idempotency key, then succeeds", async () => {
  const { calls, fetcher } = stub((n) => n === 1 ? json({ error: "boom" }, 502) : created())
  const { sleep } = recorder()
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(calls.map((call) => call.headers.get("idempotency-key")), ["post-0192", "post-0192"])
})

Deno.test("retries a transport failure, since the key makes a repeat harmless", async () => {
  let n = 0
  const fetcher =
    (() =>
      ++n === 1
        ? Promise.reject(new TypeError("reset"))
        : Promise.resolve(created())) as typeof fetch
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep: recorder().sleep })
  assertEquals(result.success, true)
  assertEquals(n, 2)
})

Deno.test("after repeated 5xx says the status may exist and to reuse the key", async () => {
  const { calls, fetcher } = stub(() => json({ error: "boom" }, 503))
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep: recorder().sleep })
  assertEquals(result.success, false)
  assertEquals(calls.length, 3)
  assertStringIncludes(result.error, "may exist, retry with the same idempotencyKey")
})

Deno.test("waits the Retry-After of a 429 before posting again", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({ error: "Too many requests" }, 429, { "Retry-After": "3" }) : created()
  )
  const { waits, sleep } = recorder()
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(waits, [3000])
})

Deno.test("does not retry a 422 and reports Mastodon's error without the token", async () => {
  const { calls, fetcher } = stub(() =>
    json({ error: `Validation failed: text too long for ${TOKEN}` }, 422)
  )
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep: recorder().sleep })
  assertEquals(calls.length, 1)
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "HTTP 422: Validation failed")
  assertStringIncludes(result.error, "<REDACTED:TOKEN>")
  assert(!result.error.includes(TOKEN))
  assert(!result.error.includes("may exist"))
})

Deno.test("refuses a redirect instead of following it", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 307, headers: { location: "https://evil.example.net/" } })
  )
  const result = await postMastodonStatus({ ...POST, fetch: fetcher })
  assertEquals(calls.length, 1)
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "redirect (307)")
  assert(!result.error.includes("evil"))
})

Deno.test("keeps the token and URL out of a transport error", async () => {
  const fetcher =
    (() => Promise.reject(new TypeError(`failed ${INSTANCE}?t=${TOKEN}`))) as typeof fetch
  const result = await postMastodonStatus({ ...POST, fetch: fetcher, sleep: recorder().sleep })
  assertEquals(result.success, false)
  assert(!result.error.includes(TOKEN))
  assert(!result.error.includes("social.example.com"))
})

Deno.test("fails on an answer with no status id", async () => {
  const { fetcher } = stub(() => json({ ok: true }))
  const result = await postMastodonStatus({ ...POST, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "no status id")
})

Deno.test("refuses a status url that is not https", async () => {
  const { fetcher } = stub(() =>
    json({ id: "109", url: "http://social.example.com/@seed/109", uri: "x" })
  )
  const result = await postMastodonStatus({ ...POST, fetch: fetcher })
  assertEquals(result, {
    success: false,
    output: null,
    error: "mastodon status 109 has no https url",
  })
})

Deno.test("refuses an instanceUrl that is not a bare https origin, without a request", async () => {
  const { calls, fetcher } = stub(created)
  for (
    const instanceUrl of ["http://social.example.com", "https://social.example.com/api", "nope"]
  ) {
    const result = await postMastodonStatus({ ...POST, instanceUrl, fetch: fetcher })
    assertStringIncludes(result.error, "instanceUrl must be an https origin")
  }
  assertEquals(calls.length, 0)
})

Deno.test("reads favourites as reactions and replies as comments, keeping reblogs apart", async () => {
  const { calls, fetcher } = stub(() =>
    json({ id: "109", favourites_count: 7, reblogs_count: 3, replies_count: 2 })
  )
  const result = await readMastodonStatusResults({
    instanceUrl: INSTANCE,
    statusId: "109",
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { views: null, reactions: 7, comments: 2, score: null, favourites: 7, reblogs: 3 },
    error: "",
  })
  assertEquals(calls[0].url, "https://social.example.com/api/v1/statuses/109")
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].headers.get("authorization"), null)
})

Deno.test("sends the token when reading with one", async () => {
  const { calls, fetcher } = stub(() =>
    json({ favourites_count: 0, reblogs_count: 0, replies_count: 0 })
  )
  await readMastodonStatusResults({
    instanceUrl: INSTANCE,
    accessToken: TOKEN,
    statusId: "109",
    fetch: fetcher,
  })
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`)
})

Deno.test("retries a 5xx on a read", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({}, 500) : json({ favourites_count: 1, reblogs_count: 0, replies_count: 0 })
  )
  const result = await readMastodonStatusResults({
    instanceUrl: INSTANCE,
    statusId: "109",
    fetch: fetcher,
    sleep: recorder().sleep,
  })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
})

Deno.test("fails a read whose counts are missing", async () => {
  const { fetcher } = stub(() => json({ id: "109", favourites_count: "7" }))
  const result = await readMastodonStatusResults({
    instanceUrl: INSTANCE,
    statusId: "109",
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "no valid counts")
})

Deno.test("refuses a status id that could change the path", async () => {
  const { calls, fetcher } = stub(created)
  const result = await readMastodonStatusResults({
    instanceUrl: INSTANCE,
    statusId: "../accounts/1",
    fetch: fetcher,
  })
  assertStringIncludes(result.error, "statusId")
  assertEquals(calls.length, 0)
})
