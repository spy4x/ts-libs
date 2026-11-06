import { assertEquals, assertStringIncludes } from "@std/assert"
import { findRedditPostsByUrl, readRedditPostResults, REDDIT_INFO_LIMIT } from "./reddit.ts"

const AGENT = "web:seedsaas.com:1.0 (by /u/seed)"

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
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
    })
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

const post = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  num_comments: 7,
  score: 41,
  upvote_ratio: 0.93,
  permalink: `/r/Deno/comments/${id}/my_post/`,
  subreddit: "Deno",
  created_utc: 1_790_000_000,
  title: "My post",
  ...extra,
})

const listing = (...children: unknown[]) => ({
  kind: "Listing",
  data: { children: children.map((data) => ({ kind: "t3", data })) },
})

Deno.test("reads a post's comments, score and upvote ratio through by_id with the user agent", async () => {
  const { calls, fetcher } = stub(() => json(listing(post("1abc2d"))))
  const result = await readRedditPostResults({ id: "t3_1abc2d", userAgent: AGENT, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { views: null, reactions: null, comments: 7, score: 41, upvoteRatio: 0.93 },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://www.reddit.com/by_id/t3_1abc2d.json")
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].headers.get("user-agent"), AGENT)
  assertEquals(calls[0].redirect, "manual")
})

Deno.test("takes the post id from every common Reddit post address", async () => {
  const addresses = [
    "https://www.reddit.com/r/Deno/comments/1abc2d/my_post/",
    "https://old.reddit.com/r/Deno/comments/1ABC2D/",
    "https://reddit.com/comments/1abc2d",
    "https://redd.it/1abc2d",
  ]
  for (const url of addresses) {
    const { calls, fetcher } = stub(() => json(listing(post("1abc2d"))))
    const result = await readRedditPostResults({ url, userAgent: AGENT, fetch: fetcher })
    assertEquals(result.success, true, url)
    assertEquals(calls[0].url, "https://www.reddit.com/by_id/t3_1abc2d.json", url)
  }
})

Deno.test("refuses an address that is not a Reddit post without a request", async () => {
  const { calls, fetcher } = stub(() => json(listing()))
  for (
    const url of ["https://example.com/r/Deno/comments/1abc2d/", "https://www.reddit.com/r/Deno/"]
  ) {
    const result = await readRedditPostResults({ url, userAgent: AGENT, fetch: fetcher })
    assertStringIncludes(result.error, "not a Reddit post address")
  }
  assertEquals(calls.length, 0)
})

Deno.test("answers null when Reddit lists no such post", async () => {
  const { fetcher } = stub(() => json(listing()))
  const result = await readRedditPostResults({ id: "1abc2d", userAgent: AGENT, fetch: fetcher })
  assertEquals(result, { success: true, output: null, error: "" })
})

Deno.test("requires a user agent before sending anything", async () => {
  const { calls, fetcher } = stub(() => json(listing()))
  for (const userAgent of ["", "   ", "bad\nagent", undefined as unknown as string]) {
    const read = await readRedditPostResults({ id: "1abc2d", userAgent, fetch: fetcher })
    assertStringIncludes(read.error, "userAgent")
    const find = await findRedditPostsByUrl({
      url: "https://a.example/",
      userAgent,
      fetch: fetcher,
    })
    assertStringIncludes(find.error, "userAgent")
  }
  assertEquals(calls.length, 0)
})

Deno.test("reports a 403 plainly and does not retry it", async () => {
  const { calls, fetcher } = stub(() => new Response("<html>blocked</html>", { status: 403 }))
  const result = await readRedditPostResults({ id: "1abc2d", userAgent: AGENT, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "reddit answered HTTP 403: Reddit refuses unauthenticated")
  assertEquals(calls.length, 1)
})

Deno.test("retries a 429 after Retry-After and stops after three attempts", async () => {
  const { calls, fetcher } = stub(() => json({}, 429, { "Retry-After": "2" }))
  const { waits, sleep } = recorder()
  const result = await readRedditPostResults({
    id: "1abc2d",
    userAgent: AGENT,
    fetch: fetcher,
    sleep,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "reddit answered HTTP 429: rate limited")
  assertEquals(calls.length, 3)
  assertEquals(waits, [2_000, 2_000])
})

Deno.test("retries a 5xx and a dropped connection, then succeeds", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1
      ? json({}, 502)
      : n === 2
      ? Promise.reject(new TypeError("reset"))
      : json(listing(post("1abc2d")))
  )
  const { sleep } = recorder()
  const result = await readRedditPostResults({
    id: "1abc2d",
    userAgent: AGENT,
    fetch: fetcher,
    sleep,
  })
  assertEquals(result.output?.score, 41)
  assertEquals(calls.length, 3)
})

Deno.test("refuses a redirect instead of following it", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 301, headers: { location: "https://elsewhere.example/" } })
  )
  const result = await readRedditPostResults({ id: "1abc2d", userAgent: AGENT, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "redirect")
  assertEquals(calls.length, 1)
})

Deno.test("fails on a malformed post rather than skipping it", async () => {
  const answers = [
    () => json(listing(post("1abc2d", { score: "41" }))),
    () => json({ data: {} }),
    () => new Response("not json", { status: 200 }),
  ]
  for (const answer of answers) {
    const { fetcher } = stub(answer)
    const result = await readRedditPostResults({ id: "1abc2d", userAgent: AGENT, fetch: fetcher })
    assertEquals(result.success, false)
  }
})

Deno.test("finds every submission of an address through info.json", async () => {
  const { calls, fetcher } = stub(() =>
    json(
      listing(
        post("1abc2d"),
        post("9zz", { subreddit: "webdev", permalink: "/r/webdev/comments/9zz/x/" }),
      ),
    )
  )
  const url = "https://seedsaas.com/blog/hello?utm_source=reddit"
  const result = await findRedditPostsByUrl({ url, userAgent: AGENT, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: [
      {
        id: "1abc2d",
        url: "https://www.reddit.com/r/Deno/comments/1abc2d/my_post/",
        subreddit: "Deno",
        createdAt: "2026-09-21T14:13:20.000Z",
      },
      {
        id: "9zz",
        url: "https://www.reddit.com/r/webdev/comments/9zz/x/",
        subreddit: "webdev",
        createdAt: "2026-09-21T14:13:20.000Z",
      },
    ],
    error: "",
  })
  const sent = new URL(calls[0].url)
  assertEquals(`${sent.origin}${sent.pathname}`, "https://www.reddit.com/api/info.json")
  assertEquals(sent.searchParams.get("url"), url)
  assertEquals(sent.searchParams.get("limit"), String(REDDIT_INFO_LIMIT))
  assertEquals(calls[0].headers.get("user-agent"), AGENT)
})

Deno.test("answers an empty list when nobody submitted the address", async () => {
  const { fetcher } = stub(() => json(listing()))
  const result = await findRedditPostsByUrl({
    url: "https://seedsaas.com/blog/hello",
    userAgent: AGENT,
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: [], error: "" })
})

Deno.test("refuses a url that is not http or https without a request", async () => {
  const { calls, fetcher } = stub(() => json(listing()))
  const result = await findRedditPostsByUrl({
    url: "ftp://a.example/",
    userAgent: AGENT,
    fetch: fetcher,
  })
  assertStringIncludes(result.error, "http or https")
  assertEquals(calls.length, 0)
})
