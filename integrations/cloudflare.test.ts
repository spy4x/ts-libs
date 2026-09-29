import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { PURGE_BATCH_SIZE, purgeUrls } from "./cloudflare.ts"

const TOKEN = "cf-secret-token-0123456789"

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

const urlsOf = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `https://example.com/a${i}.png`)

const zoneThenOk = (call: Call): Response =>
  call.url.includes("/zones?name=")
    ? json({ success: true, result: [{ id: "zone1" }] })
    : json({ success: true, result: { id: "purge1" } })

Deno.test("purges 61 urls in calls of 30, 30 and 1 after one zone lookup", async () => {
  const { calls, fetcher } = stub(zoneThenOk)
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(61),
    fetch: fetcher,
  })
  assertEquals(PURGE_BATCH_SIZE, 30)
  assertEquals(result, { success: true, output: "purged 61 URL(s)", error: "" })
  assertEquals(calls.length, 4)
  assertEquals(calls[0].url, "https://api.cloudflare.com/client/v4/zones?name=example.com")
  assertEquals(calls[0].authorization, `Bearer ${TOKEN}`)
  const posts = calls.slice(1)
  for (const post of posts) {
    assertEquals(post.method, "POST")
    assertEquals(post.url, "https://api.cloudflare.com/client/v4/zones/zone1/purge_cache")
  }
  assertEquals(
    posts.map((post) => (post.body as { files: string[] }).files.length),
    [30, 30, 1],
  )
  assertEquals((posts[2].body as { files: string[] }).files, [urlsOf(61)[60]])
})

Deno.test("skips the zone lookup when a zone id is given", async () => {
  const { calls, fetcher } = stub(zoneThenOk)
  const result = await purgeUrls({
    token: TOKEN,
    zoneId: "abc123",
    urls: urlsOf(2),
    fetch: fetcher,
  })
  assert(result.success)
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://api.cloudflare.com/client/v4/zones/abc123/purge_cache")
})

Deno.test("fails naming the zone when no zone matches", async () => {
  const { calls, fetcher } = stub(() => json({ success: true, result: [] }))
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "missing.example",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "missing.example")
  assertStringIncludes(result.error, "no such zone")
  assertEquals(calls.length, 1)
})

Deno.test("reports an HTTP error with Cloudflare's codes and how many urls were purged", async () => {
  const { calls, fetcher } = stub((call, index) =>
    index === 2
      ? json({ success: false, errors: [{ code: 1015, message: "rate limited" }] }, 429)
      : zoneThenOk(call)
  )
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(61),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertEquals(result.output, "")
  assertStringIncludes(result.error, "after 30 of 61")
  assertStringIncludes(result.error, "HTTP 429: 1015 rate limited")
  assertEquals(calls.length, 3)
})

Deno.test("treats a 200 answer with success false as a failure", async () => {
  const { fetcher } = stub((call) =>
    call.url.includes("/zones?name=") ? zoneThenOk(call) : json({
      success: false,
      errors: [{ code: 1200, message: "invalid file url" }],
    })
  )
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "HTTP 200: 1200 invalid file url")
})

Deno.test("fails when a request stalls past the timeout, without waiting long", async () => {
  const fetcher =
    ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(1),
    fetch: fetcher,
    requestTimeoutMs: 20,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "timed out after 20 ms")
})

Deno.test("passes a per-request abort signal to every call", async () => {
  const signals: (AbortSignal | null | undefined)[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init?.signal)
    return Promise.resolve(zoneThenOk({ url: String(input) } as Call))
  }) as typeof fetch
  await purgeUrls({ token: TOKEN, zoneName: "example.com", urls: urlsOf(31), fetch: fetcher })
  assertEquals(signals.length, 3)
  assert(signals.every((signal) => signal instanceof AbortSignal))
  assertEquals(new Set(signals).size, 3)
})

Deno.test("never puts the token in an error or output, whatever fails", async () => {
  const responders: ((call: Call) => Response | Promise<Response>)[] = [
    () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403),
    () => json({ success: true, result: [] }),
    () => {
      throw new TypeError(`bad header Bearer ${TOKEN}`)
    },
    () => Promise.reject(new Error(`connect failed with ${TOKEN}`)),
    zoneThenOk,
  ]
  for (const respond of responders) {
    const { fetcher } = stub(respond)
    const result = await purgeUrls({
      token: TOKEN,
      zoneName: "example.com",
      urls: urlsOf(1),
      fetch: fetcher,
    })
    assertEquals(result.error.includes(TOKEN), false, result.error)
    assertEquals(result.output.includes(TOKEN), false, result.output)
    assertEquals(result.error.includes("Bearer"), false, result.error)
  }
})

Deno.test("a transport throw is a failure result, not an exception", async () => {
  const { fetcher } = stub(() => {
    throw new TypeError("network down")
  })
  const result = await purgeUrls({
    token: TOKEN,
    zoneId: "z",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "request failed")
})

Deno.test("succeeds with nothing to do and no request for an empty url list", async () => {
  const { calls, fetcher } = stub(zoneThenOk)
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: [],
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: "nothing to purge", error: "" })
  assertEquals(calls.length, 0)
})

Deno.test("rejects an empty token, missing or both zone fields, and blank urls", async () => {
  const { calls, fetcher } = stub(zoneThenOk)
  const base = { token: TOKEN, urls: urlsOf(1), fetch: fetcher }
  const cases = [
    { ...base, token: "  ", zoneId: "z" },
    { ...base },
    { ...base, zoneName: "example.com", zoneId: "z" },
    { ...base, zoneName: " " },
    { ...base, zoneId: "z", urls: [""] },
    { ...base, zoneId: "z", urls: [" "] },
    { ...base, zoneId: "z", requestTimeoutMs: 0 },
  ]
  for (const options of cases) {
    const result = await purgeUrls(options)
    assertEquals(result.success, false)
    assertStringIncludes(result.error, "invalid options")
  }
  assertEquals(calls.length, 0)
})

Deno.test("redacts the token and control characters from a Cloudflare error message", async () => {
  const message = `Invalid header\nBearer ${TOKEN}\u001b[31m fake line`
  const { fetcher } = stub((call) =>
    call.url.includes("/zones?name=")
      ? zoneThenOk(call)
      : json({ success: false, errors: [{ code: 6111, message }] }, 400)
  )
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertEquals(result.error.includes(TOKEN), false, result.error)
  assertStringIncludes(result.error, "Bearer <REDACTED:TOKEN>")
  assertEquals(/\p{Cc}/u.test(result.error), false, result.error)
})

Deno.test("redacts the token from a zone lookup error too", async () => {
  const { fetcher } = stub(() =>
    json({ success: false, errors: [{ code: 1, message: `echo ${TOKEN}` }] }, 403)
  )
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.error.includes(TOKEN), false, result.error)
  assertStringIncludes(result.error, "<REDACTED:TOKEN>")
})

Deno.test("caps each Cloudflare message and the number of messages", async () => {
  const errors = Array.from({ length: 9 }, (_, i) => ({ code: i, message: "x".repeat(5000) }))
  const { fetcher } = stub(() => json({ success: false, errors }, 400))
  const result = await purgeUrls({ token: TOKEN, zoneId: "z", urls: urlsOf(1), fetch: fetcher })
  assertEquals(result.success, false)
  assert(result.error.length < 1500, `error is ${result.error.length} characters`)
  assertEquals(result.error.includes("8 x"), false)
})

Deno.test("reports only the status when the answer body is over the size cap", async () => {
  const huge = JSON.stringify({ errors: [{ code: 1, message: "y".repeat(200_000) }] })
  const { fetcher } = stub(() => new Response(huge, { status: 500 }))
  const result = await purgeUrls({ token: TOKEN, zoneId: "z", urls: urlsOf(1), fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "HTTP 500")
  assert(result.error.length < 120, `error is ${result.error.length} characters`)
})

Deno.test("returns a failure instead of throwing for options that are not an object", async () => {
  for (const options of [null, undefined, "x", 5]) {
    const result = await purgeUrls(options as unknown as Parameters<typeof purgeUrls>[0])
    assertEquals(result.success, false)
    assertStringIncludes(result.error, "invalid options")
  }
})

Deno.test("encodes the zone name in the lookup url", async () => {
  const { calls, fetcher } = stub(zoneThenOk)
  await purgeUrls({ token: TOKEN, zoneName: "a&b=c.example", urls: urlsOf(1), fetch: fetcher })
  assertEquals(
    calls[0].url,
    "https://api.cloudflare.com/client/v4/zones?name=a%26b%3Dc.example",
  )
})

Deno.test("fails as ambiguous when the name lookup returns more than one zone", async () => {
  const { calls, fetcher } = stub(() =>
    json({ success: true, result: [{ id: "one" }, { id: "two" }] })
  )
  const result = await purgeUrls({
    token: TOKEN,
    zoneName: "example.com",
    urls: urlsOf(1),
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "example.com")
  assertStringIncludes(result.error, "ambiguous")
  assertEquals(calls.length, 1)
})
