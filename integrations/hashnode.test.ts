import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import {
  findHashnodePostBySlug,
  HASHNODE_API,
  publishHashnodePost,
  type PublishHashnodePostOptions,
  readHashnodePostResults,
} from "./hashnode.ts"

const TOKEN = "s3cr3t-HASHNODE-token"
const PUBLICATION = "65a1b2c3d4e5f60718293a4b"

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: { query: string; variables: Record<string, unknown> }
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
      body: JSON.parse(String(init?.body)),
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

const POST: Omit<PublishHashnodePostOptions, "fetch"> = {
  token: TOKEN,
  publicationId: PUBLICATION,
  title: "Hello",
  contentMarkdown: "# Hello",
  originalArticleURL: "https://seedsaas.com/blog/hello",
}

const published = () =>
  json({
    data: { publishPost: { post: { id: "p1", url: "https://seed.hashnode.dev/hello" } } },
  })

Deno.test("publishes through the publishPost mutation with the raw token and returns id and url", async () => {
  const { calls, fetcher } = stub(published)
  const result = await publishHashnodePost({
    ...POST,
    slug: "hello",
    subtitle: "Intro",
    coverImageURL: "https://seedsaas.com/og.png",
    tags: ["deno", "saas"],
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { id: "p1", url: "https://seed.hashnode.dev/hello" },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, HASHNODE_API)
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].headers.get("authorization"), TOKEN)
  assertEquals(calls[0].headers.get("content-type"), "application/json")
  assertEquals(calls[0].redirect, "manual")
  assertStringIncludes(calls[0].body.query, "publishPost(input: $input)")
  assertEquals(calls[0].body.variables, {
    input: {
      publicationId: PUBLICATION,
      title: "Hello",
      contentMarkdown: "# Hello",
      originalArticleURL: "https://seedsaas.com/blog/hello",
      slug: "hello",
      subtitle: "Intro",
      coverImage: "https://seedsaas.com/og.png",
      tags: [{ slug: "deno" }, { slug: "saas" }],
    },
  })
})

Deno.test("leaves unset optional post fields out of the mutation input", async () => {
  const { calls, fetcher } = stub(published)
  await publishHashnodePost({ ...POST, fetch: fetcher })
  assertEquals(Object.keys(calls[0].body.variables.input as object), [
    "publicationId",
    "title",
    "contentMarkdown",
    "originalArticleURL",
  ])
})

Deno.test("fails on GraphQL errors in a 200 answer, without claiming the post may exist", async () => {
  const { fetcher } = stub(() =>
    json({
      errors: [{
        message: "Publication does not have an active Pro plan.",
        extensions: { code: "FORBIDDEN" },
      }],
      data: null,
    })
  )
  const result = await publishHashnodePost({ ...POST, fetch: fetcher })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "hashnode answered with errors: Publication does not have")
  assert(!result.error.includes("may exist"))
})

Deno.test("says the post may exist after a GraphQL INTERNAL_SERVER_ERROR", async () => {
  const { calls, fetcher } = stub(() =>
    json({ errors: [{ message: "boom", extensions: { code: "INTERNAL_SERVER_ERROR" } }] })
  )
  const result = await publishHashnodePost({ ...POST, fetch: fetcher })
  assertEquals(calls.length, 1)
  assertStringIncludes(result.error, "the post may exist")
})

Deno.test("retries a 429 after the Retry-After delay, then publishes", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({}, 429, { "Retry-After": "3" }) : published()
  )
  const { waits, sleep } = recorder()
  const result = await publishHashnodePost({ ...POST, fetch: fetcher, sleep })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(waits, [3000])
})

Deno.test("does not publish again after a 5xx or a dropped connection", async () => {
  for (const respond of [() => json({}, 502), () => Promise.reject(new TypeError("reset"))]) {
    const { calls, fetcher } = stub(respond)
    const result = await publishHashnodePost({
      ...POST,
      fetch: fetcher,
      sleep: () => Promise.resolve(),
    })
    assertEquals(calls.length, 1)
    assertStringIncludes(result.error, "the post may exist, look it up before posting again")
  }
})

Deno.test("refuses a redirect instead of following it with the token", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 301, headers: { location: "https://evil.example/" } })
  )
  const result = await publishHashnodePost({ ...POST, fetch: fetcher })
  assertEquals(calls.length, 1)
  assertEquals(result.error, "hashnode answered with a redirect (301)")
})

Deno.test("rejects a publish answer without an id and an https url", async () => {
  for (const post of [null, { id: "p1" }, { id: "p1", url: "http://seed.hashnode.dev/x" }]) {
    const { fetcher } = stub(() => json({ data: { publishPost: { post } } }))
    const result = await publishHashnodePost({ ...POST, fetch: fetcher })
    assertEquals(result.success, false)
    assertStringIncludes(result.error, "may exist")
  }
})

Deno.test("refuses a bad token or post without sending a request", async () => {
  const { calls, fetcher } = stub(published)
  const bad: Partial<PublishHashnodePostOptions>[] = [
    { token: "" },
    { token: "has space" },
    { publicationId: "nope" },
    { title: "" },
    { originalArticleURL: "ftp://x" },
    { coverImageURL: "javascript:alert(1)" },
    { tags: Array.from({ length: 16 }, (_, i) => `t${i}`) },
    { slug: "has space" },
  ]
  for (const change of bad) {
    const result = await publishHashnodePost({ ...POST, ...change, fetch: fetcher })
    assertEquals(result.success, false, JSON.stringify(change))
  }
  assertEquals(calls.length, 0)
})

Deno.test("never puts the token in an error, whatever fails", async () => {
  const answers = [
    () => json({ errors: [{ message: `bad token ${TOKEN}` }] }),
    () => json({ errors: [{ message: `bad token ${TOKEN}` }] }, 401),
    () => Promise.reject(new TypeError(`connect failed with ${TOKEN}`)),
    () => new Response(`not json ${TOKEN}`, { status: 200 }),
  ]
  for (const respond of answers) {
    const { fetcher } = stub(respond)
    const sleep = () => Promise.resolve()
    for (
      const result of [
        await publishHashnodePost({ ...POST, fetch: fetcher, sleep }),
        await findHashnodePostBySlug({
          token: TOKEN,
          host: "blog.seed.dev",
          slug: "a",
          fetch: fetcher,
          sleep,
        }),
        await readHashnodePostResults({ token: TOKEN, id: "p1", fetch: fetcher, sleep }),
      ]
    ) {
      assertEquals(result.success, false)
      assert(!JSON.stringify(result).includes(TOKEN), result.error)
    }
  }
})

Deno.test("finds a post by publication host and slug", async () => {
  const { calls, fetcher } = stub(() =>
    json({
      data: {
        publication: { id: PUBLICATION, post: { id: "p1", url: "https://blog.seed.dev/a" } },
      },
    })
  )
  const result = await findHashnodePostBySlug({ host: "blog.seed.dev", slug: "a", fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { id: "p1", url: "https://blog.seed.dev/a" },
    error: "",
  })
  assertEquals(calls[0].headers.has("authorization"), false)
  assertStringIncludes(calls[0].body.query, "publication(host: $host)")
  assertEquals(calls[0].body.variables, { host: "blog.seed.dev", slug: "a" })
})

Deno.test("finds a post by publication id with the token", async () => {
  const { calls, fetcher } = stub(() =>
    json({ data: { publication: { id: PUBLICATION, post: null } } })
  )
  const result = await findHashnodePostBySlug({
    token: TOKEN,
    publicationId: PUBLICATION,
    slug: "a",
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: null, error: "" })
  assertEquals(calls[0].headers.get("authorization"), TOKEN)
  assertStringIncludes(calls[0].body.query, "publication(id: $id)")
  assertEquals(calls[0].body.variables, { id: PUBLICATION, slug: "a" })
})

Deno.test("fails rather than answering not found for a missing publication or a malformed post", async () => {
  for (
    const data of [
      { publication: null },
      { publication: { id: PUBLICATION, post: { id: "p1" } } },
      {},
    ]
  ) {
    const { fetcher } = stub(() => json({ data }))
    const result = await findHashnodePostBySlug({
      host: "blog.seed.dev",
      slug: "a",
      fetch: fetcher,
    })
    assertEquals(result.success, false, JSON.stringify(data))
  }
})

Deno.test("retries a 5xx and a dropped connection during the lookup", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1
      ? json({}, 503)
      : n === 2
      ? Promise.reject(new TypeError("reset"))
      : json({ data: { publication: { id: PUBLICATION, post: null } } })
  )
  const { waits, sleep } = recorder()
  const result = await findHashnodePostBySlug({
    host: "blog.seed.dev",
    slug: "a",
    fetch: fetcher,
    sleep,
  })
  assertEquals(result.success, true)
  assertEquals(calls.length, 3)
  assertEquals(waits.length, 2)
})

Deno.test("refuses a lookup with both, or neither, host and publicationId", async () => {
  const { calls, fetcher } = stub(published)
  const options = [
    { slug: "a" },
    { host: "blog.seed.dev", publicationId: PUBLICATION, slug: "a" },
    { host: "https://blog.seed.dev/", slug: "a" },
    { host: "blog.seed.dev", slug: "" },
  ]
  for (const option of options) {
    const result = await findHashnodePostBySlug(
      { ...option, fetch: fetcher } as Parameters<typeof findHashnodePostBySlug>[0],
    )
    assertEquals(result.success, false, JSON.stringify(option))
  }
  assertEquals(calls.length, 0)
})

const stats = {
  id: "p1",
  url: "https://blog.seed.dev/a",
  views: 120,
  reactionCount: 7,
  responseCount: 2,
}

Deno.test("reads a post's results by id in the shared results shape", async () => {
  const { calls, fetcher } = stub(() => json({ data: { post: stats } }))
  const result = await readHashnodePostResults({ id: "p1", fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: {
      id: "p1",
      url: "https://blog.seed.dev/a",
      views: 120,
      reactions: 7,
      comments: 2,
      score: null,
    },
    error: "",
  })
  assertStringIncludes(calls[0].body.query, "post(id: $id)")
  assertEquals(calls[0].body.variables, { id: "p1" })
})

Deno.test("reads results by host and slug, and answers null views when Hashnode has none", async () => {
  const { calls, fetcher } = stub(() =>
    json({ data: { publication: { id: PUBLICATION, post: { ...stats, views: null } } } })
  )
  const result = await readHashnodePostResults({ host: "blog.seed.dev", slug: "a", fetch: fetcher })
  assertEquals(result.output?.views, null)
  assertEquals(result.output?.reactions, 7)
  assertEquals(calls[0].body.variables, { host: "blog.seed.dev", slug: "a" })
})

Deno.test("fails to read results for an unknown or malformed post", async () => {
  for (const data of [{ post: null }, { post: { ...stats, reactionCount: "7" } }]) {
    const { fetcher } = stub(() => json({ data }))
    const result = await readHashnodePostResults({ id: "p1", fetch: fetcher })
    assertEquals(result.success, false, JSON.stringify(data))
  }
})
