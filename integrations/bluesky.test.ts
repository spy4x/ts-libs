import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import {
  type BlueskyBlob,
  type BlueskySession,
  createBlueskySession,
  findBlueskyPostByLink,
  postBlueskyLink,
  readBlueskyPostResults,
  uploadBlueskyBlob,
} from "./bluesky.ts"

const PASSWORD = "abcd-efgh-ijkl-mnop"
const JWT = "eyJ.s3cr3t-ACCESS.jwt"
const DID = "did:plc:abc123"
const LINK = "https://example.com/blog/hello"
const POST_URI = `at://${DID}/app.bsky.feed.post/3kq2rkey`
const SESSION: BlueskySession = {
  service: "https://pds.example.com",
  did: DID,
  handle: "seed.example.com",
  accessJwt: JWT,
}

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: unknown
}

/** A fetch stub that records every call and answers the n-th call with `respond(n, url)`. */
const stub = (respond: (n: number, url: string) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    })
    return Promise.resolve(respond(calls.length, String(input)))
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

const created = () => json({ uri: POST_URI, cid: "bafyrei-cid" })

const CARD = { uri: LINK, title: "Hello", description: "An intro" }
const CREATED_AT = "2026-11-06T10:00:00.000Z"

Deno.test("signs in with the app password and answers did, handle and token", async () => {
  const { calls, fetcher } = stub(() =>
    json({ did: DID, handle: "seed.example.com", accessJwt: JWT, refreshJwt: "r" })
  )
  const result = await createBlueskySession({
    identifier: "seed.example.com",
    appPassword: PASSWORD,
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: {
      service: "https://bsky.social",
      did: DID,
      handle: "seed.example.com",
      accessJwt: JWT,
    },
    error: "",
  })
  assertEquals(calls[0].url, "https://bsky.social/xrpc/com.atproto.server.createSession")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].body, { identifier: "seed.example.com", password: PASSWORD })
})

Deno.test("keeps the app password out of a sign-in error", async () => {
  const { fetcher } = stub(() =>
    json({ error: "AuthenticationRequired", message: `Invalid password ${PASSWORD}` }, 401)
  )
  const result = await createBlueskySession({
    identifier: "seed.example.com",
    appPassword: PASSWORD,
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertStringIncludes(result.error, "HTTP 401: AuthenticationRequired: Invalid password")
  assert(!result.error.includes(PASSWORD))
})

Deno.test("fails a sign-in answer without a token", async () => {
  const { fetcher } = stub(() => json({ did: DID, handle: "seed.example.com" }))
  const result = await createBlueskySession({
    identifier: "seed.example.com",
    appPassword: PASSWORD,
    fetch: fetcher,
  })
  assertEquals(result.error, "bluesky sign-in answer has no did and token")
})

Deno.test("posts a link card with a facet at UTF-8 byte offsets in non-ASCII text", async () => {
  const { calls, fetcher } = stub(created)
  const text = `Привет 👋 — читайте: ${LINK}`
  const result = await postBlueskyLink({
    session: SESSION,
    text,
    link: CARD,
    langs: ["ru"],
    createdAt: CREATED_AT,
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: {
      uri: POST_URI,
      cid: "bafyrei-cid",
      url: `https://bsky.app/profile/${DID}/post/3kq2rkey`,
    },
    error: "",
  })
  assertEquals(calls[0].url, "https://pds.example.com/xrpc/com.atproto.repo.createRecord")
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${JWT}`)
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].body, {
    repo: DID,
    collection: "app.bsky.feed.post",
    record: {
      $type: "app.bsky.feed.post",
      text,
      createdAt: CREATED_AT,
      langs: ["ru"],
      facets: [{
        index: { byteStart: 38, byteEnd: 68 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: LINK }],
      }],
      embed: {
        $type: "app.bsky.embed.external",
        external: { uri: LINK, title: "Hello", description: "An intro" },
      },
    },
  })
})

Deno.test("adds no facet when the link is not in the text, and puts the thumb on the card", async () => {
  const { calls, fetcher } = stub(created)
  const thumb: BlueskyBlob = {
    $type: "blob",
    ref: { $link: "bafkrei-img" },
    mimeType: "image/png",
    size: 1200,
  }
  await postBlueskyLink({
    session: SESSION,
    text: "A new post",
    link: { ...CARD, thumbBlob: thumb },
    createdAt: CREATED_AT,
    fetch: fetcher,
  })
  const record = (calls[0].body as { record: Record<string, unknown> }).record
  assertEquals("facets" in record, false)
  assertEquals("langs" in record, false)
  assertEquals((record.embed as { external: { thumb: unknown } }).external.thumb, thumb)
})

Deno.test("accepts 300 graphemes and refuses 301, counting a combined letter as one", async () => {
  const { calls, fetcher } = stub(created)
  const letter = "é" // two code points, one grapheme
  const ok = await postBlueskyLink({
    session: SESSION,
    text: letter.repeat(300),
    link: CARD,
    fetch: fetcher,
  })
  assertEquals(ok.success, true)
  const tooLong = await postBlueskyLink({
    session: SESSION,
    text: letter.repeat(301),
    link: CARD,
    fetch: fetcher,
  })
  assertStringIncludes(tooLong.error, "over 300 graphemes")
  assertEquals(calls.length, 1)
})

Deno.test("does not post again after a 5xx, and says the post may exist", async () => {
  const { calls, fetcher } = stub(() => json({ error: "InternalServerError" }, 502))
  const result = await postBlueskyLink({
    session: SESSION,
    text: "Hi",
    link: CARD,
    fetch: fetcher,
    sleep: recorder().sleep,
  })
  assertEquals(calls.length, 1)
  assertStringIncludes(result.error, "the post may exist, look it up before posting again")
})

Deno.test("does not post again after a timeout", async () => {
  let n = 0
  const fetcher =
    (() => (n++, Promise.reject(new DOMException("t", "TimeoutError")))) as typeof fetch
  const result = await postBlueskyLink({
    session: SESSION,
    text: "Hi",
    link: CARD,
    fetch: fetcher,
    sleep: recorder().sleep,
  })
  assertEquals(n, 1)
  assertStringIncludes(result.error, "may exist")
})

Deno.test("waits the Retry-After of a 429 before posting again", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({ error: "RateLimitExceeded" }, 429, { "Retry-After": "2" }) : created()
  )
  const { waits, sleep } = recorder()
  const result = await postBlueskyLink({
    session: SESSION,
    text: "Hi",
    link: CARD,
    fetch: fetcher,
    sleep,
  })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(waits, [2000])
})

Deno.test("keeps the access token out of a post error", async () => {
  const { fetcher } = stub(() => json({ error: "ExpiredToken", message: `bad ${JWT}` }, 400))
  const result = await postBlueskyLink({ session: SESSION, text: "Hi", link: CARD, fetch: fetcher })
  assertStringIncludes(result.error, "HTTP 400: ExpiredToken")
  assertStringIncludes(result.error, "<REDACTED:TOKEN>")
  assert(!result.error.includes(JWT))
})

Deno.test("refuses a redirect instead of following it", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 302, headers: { location: "https://evil.example.net/" } })
  )
  const result = await postBlueskyLink({ session: SESSION, text: "Hi", link: CARD, fetch: fetcher })
  assertEquals(calls.length, 1)
  assertStringIncludes(result.error, "redirect (302)")
})

Deno.test("fails an answer without an at:// post uri", async () => {
  const { fetcher } = stub(() => json({ uri: "https://bsky.app/x", cid: "c" }))
  const result = await postBlueskyLink({ session: SESSION, text: "Hi", link: CARD, fetch: fetcher })
  assertStringIncludes(result.error, "no post uri and cid; the post may exist")
})

Deno.test("refuses a session whose service is not https, without a request", async () => {
  const { calls, fetcher } = stub(created)
  const result = await postBlueskyLink({
    session: { ...SESSION, service: "http://pds.example.com" },
    text: "Hi",
    link: CARD,
    fetch: fetcher,
  })
  assertStringIncludes(result.error, "session.service must be an https origin")
  assertEquals(calls.length, 0)
})

Deno.test("uploads a card image with its type and answers the blob", async () => {
  const blob: BlueskyBlob = {
    $type: "blob",
    ref: { $link: "bafkrei-img" },
    mimeType: "image/png",
    size: 3,
  }
  const { calls, fetcher } = stub(() => json({ blob }))
  const data = new Uint8Array([1, 2, 3])
  const result = await uploadBlueskyBlob({
    session: SESSION,
    data,
    mimeType: "image/png",
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: blob, error: "" })
  assertEquals(calls[0].url, "https://pds.example.com/xrpc/com.atproto.repo.uploadBlob")
  assertEquals(calls[0].headers.get("content-type"), "image/png")
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${JWT}`)
  assertEquals(calls[0].body, data)
})

/** A feed item as `getAuthorFeed` answers it. */
const item = (rkey: string, record: unknown, author = DID) => ({
  post: {
    uri: `at://${author}/app.bsky.feed.post/${rkey}`,
    cid: `cid-${rkey}`,
    author: { did: author, handle: author === DID ? "seed.example.com" : "other.example.com" },
    record,
  },
})
const plain = { $type: "app.bsky.feed.post", text: "hi" }
const carded = (uri: string) => ({
  ...plain,
  embed: { $type: "app.bsky.embed.external", external: { uri, title: "", description: "" } },
})

Deno.test("finds the author's post by its card on a later page, without a token", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1
      ? json({
        cursor: "c1",
        feed: [item("a", plain), item("b", carded("https://other.example/"))],
      })
      : json({ feed: [item("c", carded(LINK))] })
  )
  const result = await findBlueskyPostByLink({ actor: DID, uri: LINK, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: {
      uri: `at://${DID}/app.bsky.feed.post/c`,
      cid: "cid-c",
      url: `https://bsky.app/profile/${DID}/post/c`,
    },
    error: "",
  })
  assertEquals(
    calls.map((call) => call.url),
    [
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${
        encodeURIComponent(DID)
      }&limit=100`,
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${
        encodeURIComponent(DID)
      }&limit=100&cursor=c1`,
    ],
  )
  assertEquals(calls[0].headers.get("authorization"), null)
})

Deno.test("finds a post by its link facet", async () => {
  const record = {
    ...plain,
    facets: [{
      index: { byteStart: 0, byteEnd: 5 },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: LINK }],
    }],
  }
  const { fetcher } = stub(() => json({ feed: [item("f", record)] }))
  const result = await findBlueskyPostByLink({ actor: DID, uri: LINK, fetch: fetcher })
  assertEquals(result.output?.cid, "cid-f")
})

Deno.test("skips another author's post that the actor reposted", async () => {
  const { fetcher } = stub(() => json({ feed: [item("r", carded(LINK), "did:plc:other")] }))
  const result = await findBlueskyPostByLink({ actor: DID, uri: LINK, fetch: fetcher })
  assertEquals(result, { success: true, output: null, error: "" })
})

Deno.test("stops after maxPages and answers not found", async () => {
  const { calls, fetcher } = stub(() => json({ cursor: "next", feed: [item("a", plain)] }))
  const result = await findBlueskyPostByLink({ actor: DID, uri: LINK, maxPages: 2, fetch: fetcher })
  assertEquals(result, { success: true, output: null, error: "" })
  assertEquals(calls.length, 2)
})

Deno.test("fails the lookup on a malformed page rather than answering not found", async () => {
  const { fetcher } = stub(() => json({ feed: [{ post: { uri: 1 } }] }))
  const result = await findBlueskyPostByLink({ actor: DID, uri: LINK, fetch: fetcher })
  assertEquals(result, { success: false, output: null, error: "bluesky feed page 1 is malformed" })
})

Deno.test("reads likes as reactions and replies as comments, keeping reposts and quotes", async () => {
  const { calls, fetcher } = stub(() =>
    json({
      posts: [{ uri: POST_URI, likeCount: 9, replyCount: 4, repostCount: 2, quoteCount: 1 }],
    })
  )
  const result = await readBlueskyPostResults({ uri: POST_URI, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { views: null, reactions: 9, comments: 4, score: null, reposts: 2, quotes: 1 },
    error: "",
  })
  assertEquals(
    calls[0].url,
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(POST_URI)}`,
  )
  assertEquals(calls[0].headers.get("authorization"), null)
})

Deno.test("fails the results of a post the AppView no longer has", async () => {
  const { fetcher } = stub(() => json({ posts: [] }))
  const result = await readBlueskyPostResults({ uri: POST_URI, fetch: fetcher })
  assertStringIncludes(result.error, "not found")
})

Deno.test("retries a 5xx on a read", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({}, 503) : json({ posts: [{ uri: POST_URI, likeCount: 1 }] })
  )
  const result = await readBlueskyPostResults({
    uri: POST_URI,
    fetch: fetcher,
    sleep: recorder().sleep,
  })
  assertEquals(result.output?.reactions, 1)
  assertEquals(calls.length, 2)
})
