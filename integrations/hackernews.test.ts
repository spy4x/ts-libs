import { assertEquals, assertStringIncludes } from "@std/assert"
import {
  findHackerNewsStoriesByUrl,
  HACKERNEWS_SEARCH_LIMIT,
  readHackerNewsItemResults,
} from "./hackernews.ts"

interface Call {
  url: string
  method: string
  redirect: RequestRedirect | undefined
}

/** A fetch stub that records every call and answers the n-th call with `respond(n)`. */
const stub = (respond: (n: number) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", redirect: init?.redirect })
    return Promise.resolve(respond(calls.length))
  }) as typeof fetch
  return { calls, fetcher }
}

/** A sleeper that records each wait instead of waiting. */
const recorder = () => {
  const waits: number[] = []
  return { waits, sleep: (ms: number) => (waits.push(ms), Promise.resolve()) }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const hit = (id: number, url: string | null, extra: Record<string, unknown> = {}) => ({
  objectID: String(id),
  url,
  points: 120,
  num_comments: 45,
  created_at: "2026-10-09T13:03:48Z",
  title: `Story ${id}`,
  ...extra,
})

Deno.test("reads a story's points and comment count by id from the Algolia search", async () => {
  const { calls, fetcher } = stub(() => json({ hits: [hit(50019911, "https://a.example/")] }))
  const result = await readHackerNewsItemResults({ id: 50019911, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { views: null, reactions: null, comments: 45, score: 120 },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(
    calls[0].url,
    "https://hn.algolia.com/api/v1/search?tags=story,story_50019911&hitsPerPage=1",
  )
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].redirect, "manual")
})

Deno.test("takes the story id from a news.ycombinator.com item address", async () => {
  const { calls, fetcher } = stub(() => json({ hits: [hit(123, null)] }))
  const result = await readHackerNewsItemResults({
    url: "https://news.ycombinator.com/item?id=123",
    fetch: fetcher,
  })
  assertEquals(result.output?.score, 120)
  assertStringIncludes(calls[0].url, "story_123&")
})

Deno.test("refuses a bad id or address without a request", async () => {
  const { calls, fetcher } = stub(() => json({ hits: [] }))
  const bad = [
    { id: 0 },
    { id: "12a" },
    { url: "https://example.com/item?id=1" },
    { url: "https://news.ycombinator.com/user?id=pg" },
    {},
    { id: 1, url: "https://news.ycombinator.com/item?id=1" },
  ]
  for (const options of bad) {
    const result = await readHackerNewsItemResults({ ...options, fetch: fetcher })
    assertStringIncludes(result.error, "invalid options", JSON.stringify(options))
  }
  assertEquals(calls.length, 0)
})

Deno.test("answers null when the index has no such story", async () => {
  const { fetcher } = stub(() => json({ hits: [] }))
  const result = await readHackerNewsItemResults({ id: 5, fetch: fetcher })
  assertEquals(result, { success: true, output: null, error: "" })
})

Deno.test("fails on a malformed answer instead of reporting numbers", async () => {
  const answers = [
    () => json({ hits: [hit(5, null, { points: "120" })] }),
    () => json({ nope: true }),
    () => new Response("not json", { status: 200 }),
  ]
  for (const answer of answers) {
    const { fetcher } = stub(answer)
    const result = await readHackerNewsItemResults({ id: 5, fetch: fetcher })
    assertEquals(result.success, false)
  }
})

Deno.test("refuses a redirect instead of following it", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })
  )
  const result = await readHackerNewsItemResults({ id: 5, fetch: fetcher })
  assertStringIncludes(result.error, "redirect")
  assertEquals(calls.length, 1)
})

Deno.test("retries a 429 after Retry-After and a 5xx, three attempts at most", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({}, 429, { "Retry-After": "3" }) : json({}, 503)
  )
  const { waits, sleep } = recorder()
  const result = await readHackerNewsItemResults({ id: 5, fetch: fetcher, sleep })
  assertStringIncludes(result.error, "hacker news answered HTTP 503")
  assertEquals(calls.length, 3)
  assertEquals(waits[0], 3_000)
})

Deno.test("does not retry a 4xx other than 429", async () => {
  const { calls, fetcher } = stub(() => json({}, 400))
  const result = await readHackerNewsItemResults({ id: 5, fetch: fetcher, sleep: recorder().sleep })
  assertStringIncludes(result.error, "HTTP 400")
  assertEquals(calls.length, 1)
})

Deno.test("finds the stories of an address, ignoring scheme, trailing slash and utm tags", async () => {
  const { calls, fetcher } = stub(() =>
    json({
      hits: [
        hit(1, "http://seedsaas.com/blog/hello/?utm_source=hn"),
        hit(2, "https://seedsaas.com/blog/hello-world"),
        hit(3, "https://seedsaas.com/blog/hello#intro", { points: null, num_comments: null }),
        hit(4, null),
      ],
    })
  )
  const result = await findHackerNewsStoriesByUrl({
    url: "https://seedsaas.com/blog/hello?utm_medium=social",
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: [
      {
        id: 1,
        url: "https://news.ycombinator.com/item?id=1",
        points: 120,
        comments: 45,
        createdAt: "2026-10-09T13:03:48.000Z",
      },
      {
        id: 3,
        url: "https://news.ycombinator.com/item?id=3",
        points: null,
        comments: null,
        createdAt: "2026-10-09T13:03:48.000Z",
      },
    ],
    error: "",
  })
  const sent = new URL(calls[0].url)
  assertEquals(`${sent.origin}${sent.pathname}`, "https://hn.algolia.com/api/v1/search")
  assertEquals(sent.searchParams.get("query"), "seedsaas.com/blog/hello")
  assertEquals(sent.searchParams.get("restrictSearchableAttributes"), "url")
  assertEquals(sent.searchParams.get("tags"), "story")
  assertEquals(sent.searchParams.get("hitsPerPage"), String(HACKERNEWS_SEARCH_LIMIT))
})

Deno.test("keeps query parameters other than utm tags when matching", async () => {
  const { fetcher } = stub(() =>
    json({ hits: [hit(1, "https://a.example/p?id=1"), hit(2, "https://a.example/p?id=2")] })
  )
  const result = await findHackerNewsStoriesByUrl({
    url: "https://a.example/p?id=2",
    fetch: fetcher,
  })
  assertEquals(result.output?.map((story) => story.id), [2])
})

Deno.test("fails on a matching story with an unreadable date", async () => {
  const { fetcher } = stub(() =>
    json({ hits: [hit(1, "https://a.example/", { created_at: "x" })] })
  )
  const result = await findHackerNewsStoriesByUrl({ url: "https://a.example/", fetch: fetcher })
  assertStringIncludes(result.error, "no valid date")
})

Deno.test("refuses a url that is not http or https without a request", async () => {
  const { calls, fetcher } = stub(() => json({ hits: [] }))
  const result = await findHackerNewsStoriesByUrl({ url: "mailto:a@example.com", fetch: fetcher })
  assertStringIncludes(result.error, "http or https")
  assertEquals(calls.length, 0)
})
