import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import {
  createDevtoArticle,
  DEVTO_MAX_PAGES,
  type DevtoArticleInput,
  findDevtoArticleByCanonical,
} from "./devto.ts"

const KEY = "s3cr3t-DEVTO-key"

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: unknown
}

/** A fetch stub that records every call and answers the n-th call with `respond(n)`. */
const stub = (respond: (n: number, url: string) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return Promise.resolve(respond(calls.length, String(input)))
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

const ARTICLE: DevtoArticleInput = {
  title: "Hello",
  body_markdown: "# Hello",
  canonical_url: "https://seedsaas.com/blog/hello",
  published: true,
}

const created = () => json({ id: 42, url: "https://dev.to/seed/hello-1a2b", title: "Hello" }, 201)

Deno.test("posts the article with the api-key and Forem v1 headers and returns id and url", async () => {
  const { calls, fetcher } = stub(created)
  const result = await createDevtoArticle({
    apiKey: KEY,
    article: {
      ...ARTICLE,
      description: "Intro",
      tags: ["deno", "saas"],
      main_image: "https://seedsaas.com/og.png",
    },
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { id: 42, url: "https://dev.to/seed/hello-1a2b" },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://dev.to/api/articles")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].headers.get("api-key"), KEY)
  assertEquals(calls[0].headers.get("accept"), "application/vnd.forem.api-v1+json")
  assertEquals(calls[0].headers.get("content-type"), "application/json")
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].body, {
    article: {
      title: "Hello",
      body_markdown: "# Hello",
      published: true,
      canonical_url: "https://seedsaas.com/blog/hello",
      description: "Intro",
      tags: "deno, saas",
      main_image: "https://seedsaas.com/og.png",
    },
  })
})

Deno.test("sends only the known article fields, leaving unset optional ones out", async () => {
  const { calls, fetcher } = stub(created)
  await createDevtoArticle({
    apiKey: KEY,
    article: { ...ARTICLE, organization_id: 7 } as DevtoArticleInput,
    fetch: fetcher,
  })
  assertEquals(Object.keys((calls[0].body as { article: object }).article), [
    "title",
    "body_markdown",
    "published",
    "canonical_url",
  ])
})

Deno.test("retries a 429 after the Retry-After delay, then succeeds", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({ error: "Rate limit reached" }, 429, { "Retry-After": "2" }) : created()
  )
  const { waits, sleep } = recorder()
  const result = await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher, sleep })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(waits, [2000])
})

Deno.test("does not post again after a 5xx, and says the article may exist", async () => {
  const { calls, fetcher } = stub(() => json({ error: "boom" }, 502))
  const { waits, sleep } = recorder()
  const result = await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher, sleep })
  assertEquals(calls.length, 1)
  assertEquals(waits, [])
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "HTTP 502: boom")
  assertStringIncludes(result.error, "may exist")
})

Deno.test("does not post again after a dropped connection", async () => {
  const { calls, fetcher } = stub(() => Promise.reject(new TypeError("connection reset")))
  const result = await createDevtoArticle({
    apiKey: KEY,
    article: ARTICLE,
    fetch: fetcher,
    sleep: recorder().sleep,
  })
  assertEquals(calls.length, 1)
  assertStringIncludes(result.error, "may exist")
})

Deno.test("reports Forem's 422 message without claiming the article may exist", async () => {
  const { fetcher } = stub(() =>
    json({ error: "Canonical url has already been taken", status: 422 }, 422)
  )
  const result = await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher })
  assertStringIncludes(result.error, "HTTP 422: Canonical url has already been taken")
  assert(!result.error.includes("may exist"), result.error)
})

Deno.test("refuses a redirect instead of following it with the key", async () => {
  const { fetcher } = stub(() =>
    new Response(null, { status: 307, headers: { Location: "https://evil.example/" } })
  )
  const result = await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "redirect (307)")
  assert(!result.error.includes("evil.example"))
})

Deno.test("rejects a success answer without a positive integer id and an https url", async () => {
  for (
    const body of [
      { id: "42", url: "https://dev.to/a" },
      { id: 42, url: "javascript:alert(1)" },
      { id: 42, url: "http://dev.to/a" },
      { id: 0, url: "https://dev.to/a" },
      [],
    ]
  ) {
    const { fetcher } = stub(() => json(body, 201))
    const result = await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher })
    assertEquals(result.success, false, JSON.stringify(body))
    assertEquals(result.output, null)
  }
})

Deno.test("refuses a bad key or article without sending a request", async () => {
  const { calls, fetcher } = stub(created)
  const cases: [Parameters<typeof createDevtoArticle>[0], string][] = [
    [{ apiKey: "", article: ARTICLE, fetch: fetcher }, "apiKey"],
    [{ apiKey: "a key", article: ARTICLE, fetch: fetcher }, "apiKey"],
    [{ apiKey: KEY, article: { ...ARTICLE, title: "" }, fetch: fetcher }, "title"],
    [
      { apiKey: KEY, article: { ...ARTICLE, canonical_url: "ftp://x/y" }, fetch: fetcher },
      "canonical_url",
    ],
    [
      { apiKey: KEY, article: { ...ARTICLE, tags: ["a", "b", "c", "d", "e"] }, fetch: fetcher },
      "tags",
    ],
    [{ apiKey: KEY, article: { ...ARTICLE, main_image: "data:x" }, fetch: fetcher }, "main_image"],
  ]
  for (const [options, field] of cases) {
    const result = await createDevtoArticle(options)
    assertEquals(result.success, false)
    assertStringIncludes(result.error, field)
  }
  assertEquals(calls.length, 0)
})

Deno.test("never puts the api key in an error, whatever fails", async () => {
  const answers: (() => Response | Promise<Response>)[] = [
    () => json({ error: `invalid api-key ${KEY}\n` }, 401),
    () => Promise.reject(new TypeError(`fetch failed for api-key ${KEY}`)),
    () => json({ error: KEY }, 500),
    () => new Response(`not json ${KEY}`, { status: 201 }),
    () => json({ id: KEY, url: KEY }, 201),
  ]
  for (const answer of answers) {
    const { fetcher } = stub(answer)
    const sleep = recorder().sleep
    const results = [
      await createDevtoArticle({ apiKey: KEY, article: ARTICLE, fetch: fetcher, sleep }),
      await findDevtoArticleByCanonical({
        apiKey: KEY,
        canonicalUrl: ARTICLE.canonical_url,
        fetch: fetcher,
        sleep,
      }),
    ]
    for (const result of results) {
      assertEquals(result.success, false)
      assert(!JSON.stringify(result).includes(KEY), JSON.stringify(result))
    }
  }
})

const entry = (id: number, canonical: string | null) => ({
  id,
  url: `https://dev.to/seed/post-${id}`,
  canonical_url: canonical,
  title: `Post ${id}`,
})

Deno.test("pages through the key's articles until it finds the canonical address", async () => {
  const { calls, fetcher } = stub((n) =>
    json(
      n === 1
        ? [entry(1, "https://seedsaas.com/blog/other"), entry(2, null)]
        : [entry(3, "HTTPS://SeedSaaS.com/blog/hello")],
    )
  )
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: "https://seedsaas.com/blog/hello",
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { id: 3, url: "https://dev.to/seed/post-3" },
    error: "",
  })
  assertEquals(calls.map((call) => call.url), [
    "https://dev.to/api/articles/me/all?page=1&per_page=1000",
    "https://dev.to/api/articles/me/all?page=2&per_page=1000",
  ])
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].headers.get("api-key"), KEY)
  assertEquals(calls[0].headers.get("accept"), "application/vnd.forem.api-v1+json")
})

Deno.test("answers null once an empty page shows no article has the address", async () => {
  const { calls, fetcher } = stub((n) => json(n === 1 ? [entry(1, "https://a.example/")] : []))
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: "https://seedsaas.com/blog/hello",
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: null, error: "" })
  assertEquals(calls.length, 2)
})

Deno.test("fails rather than skipping a malformed article on a page", async () => {
  const { fetcher } = stub(() =>
    json([entry(1, "https://a.example/"), { id: "x", canonical_url: ARTICLE.canonical_url }])
  )
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: ARTICLE.canonical_url,
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "not a list of articles")
})

Deno.test("retries a 5xx and a dropped connection during the lookup", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1
      ? json({ error: "down" }, 503)
      : n === 2
      ? Promise.reject(new TypeError("reset"))
      : json([entry(9, ARTICLE.canonical_url)])
  )
  const { waits, sleep } = recorder()
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: ARTICLE.canonical_url,
    fetch: fetcher,
    sleep,
  })
  assertEquals(result.output, { id: 9, url: "https://dev.to/seed/post-9" })
  assertEquals(calls.length, 3)
  assertEquals(waits.length, 2)
})

Deno.test("gives up with a failure after the page limit, never with not found", async () => {
  const { calls, fetcher } = stub((n) => json([entry(n, "https://a.example/")]))
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: ARTICLE.canonical_url,
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertEquals(calls.length, DEVTO_MAX_PAGES)
})

Deno.test("refuses a canonicalUrl that is not http or https without a request", async () => {
  const { calls, fetcher } = stub(() => json([]))
  const result = await findDevtoArticleByCanonical({
    apiKey: KEY,
    canonicalUrl: "not a url",
    fetch: fetcher,
  })
  assertStringIncludes(result.error, "canonicalUrl")
  assertEquals(calls.length, 0)
})
