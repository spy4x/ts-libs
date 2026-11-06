import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import {
  exchangeLinkedinCode,
  LINKEDIN_VERSION,
  linkedinAuthorizeUrl,
  postLinkedinShare,
  type PostLinkedinShareOptions,
  readLinkedinMember,
} from "./linkedin.ts"

const TOKEN = "s3cr3t-LINKEDIN-token"
const SECRET = "s3cr3t-CLIENT-secret"
const CODE = "s3cr3t-AUTH-code"
const POST_ID = "urn:li:share:6844785523593134080"

interface Call {
  url: string
  method: string
  headers: Headers
  redirect: RequestRedirect | undefined
  body: string | undefined
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
      body: typeof init?.body === "string" ? init.body : undefined,
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

const created = () => new Response(null, { status: 201, headers: { "x-restli-id": POST_ID } })

const SHARE: Omit<PostLinkedinShareOptions, "fetch"> = {
  accessToken: TOKEN,
  authorUrn: "urn:li:person:abc_123",
  commentary: "New post",
  link: { url: "https://seedsaas.com/blog/hello", title: "Hello" },
}

Deno.test("builds the sign-in address with the default scopes, space-separated", () => {
  const url = new URL(linkedinAuthorizeUrl({
    clientId: "client-1",
    redirectUri: "https://seedsaas.com/auth/linkedin",
    state: "state-1",
  }))
  assertEquals(url.origin + url.pathname, "https://www.linkedin.com/oauth/v2/authorization")
  assertEquals(Object.fromEntries(url.searchParams), {
    response_type: "code",
    client_id: "client-1",
    redirect_uri: "https://seedsaas.com/auth/linkedin",
    state: "state-1",
    scope: "openid profile w_member_social",
  })
})

Deno.test("throws on a sign-in address without state or with a bad redirect or scope", () => {
  const base = { clientId: "c", redirectUri: "https://a.example/cb", state: "s" }
  for (
    const options of [
      { ...base, state: "" },
      { ...base, redirectUri: "javascript:alert(1)" },
      { ...base, scopes: [] },
      { ...base, scopes: ["w_member_social&x=1"] },
    ]
  ) {
    assertThrows(() => linkedinAuthorizeUrl(options), TypeError)
  }
})

Deno.test("exchanges the code with a form body and turns expires_in into ISO times", async () => {
  const { calls, fetcher } = stub(() =>
    json({
      access_token: "AQU-token",
      expires_in: 5184000,
      refresh_token: "AQX-refresh",
      refresh_token_expires_in: 31536000,
      scope: "openid,profile,w_member_social",
    })
  )
  const result = await exchangeLinkedinCode({
    clientId: "client-1",
    clientSecret: SECRET,
    redirectUri: "https://seedsaas.com/auth/linkedin",
    code: CODE,
    fetch: fetcher,
    clock: () => Date.UTC(2026, 10, 6),
  })
  assertEquals(result, {
    success: true,
    output: {
      accessToken: "AQU-token",
      expiresAt: "2027-01-05T00:00:00.000Z",
      refreshToken: "AQX-refresh",
      refreshTokenExpiresAt: "2027-11-06T00:00:00.000Z",
    },
    error: "",
  })
  assertEquals(calls[0].url, "https://www.linkedin.com/oauth/v2/accessToken")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].headers.get("content-type"), "application/x-www-form-urlencoded")
  assertEquals(calls[0].headers.has("authorization"), false)
  assertEquals(Object.fromEntries(new URLSearchParams(calls[0].body)), {
    grant_type: "authorization_code",
    code: CODE,
    client_id: "client-1",
    client_secret: SECRET,
    redirect_uri: "https://seedsaas.com/auth/linkedin",
  })
})

Deno.test("answers no refresh token when LinkedIn sends none", async () => {
  const { fetcher } = stub(() => json({ access_token: "AQU-token", expires_in: 60 }))
  const result = await exchangeLinkedinCode({
    clientId: "c",
    clientSecret: SECRET,
    redirectUri: "https://a.example/cb",
    code: CODE,
    fetch: fetcher,
    clock: () => 0,
  })
  assertEquals(result.output, { accessToken: "AQU-token", expiresAt: "1970-01-01T00:01:00.000Z" })
})

Deno.test("does not send the code twice after a 5xx", async () => {
  const { calls, fetcher } = stub(() => json({}, 500))
  const result = await exchangeLinkedinCode({
    clientId: "c",
    clientSecret: SECRET,
    redirectUri: "https://a.example/cb",
    code: CODE,
    fetch: fetcher,
    sleep: () => Promise.resolve(),
  })
  assertEquals(result.success, false)
  assertEquals(calls.length, 1)
})

Deno.test("keeps the client secret and code out of an exchange error", async () => {
  const answers = [
    () => json({ error: "invalid_request", error_description: `bad ${SECRET} ${CODE}` }, 400),
    () => Promise.reject(new TypeError(`failed ${SECRET} ${CODE}`)),
  ]
  for (const respond of answers) {
    const { fetcher } = stub(respond)
    const result = await exchangeLinkedinCode({
      clientId: "c",
      clientSecret: SECRET,
      redirectUri: "https://a.example/cb",
      code: CODE,
      fetch: fetcher,
    })
    assertEquals(result.success, false)
    const text = JSON.stringify(result)
    assert(!text.includes(SECRET) && !text.includes(CODE), result.error)
  }
})

Deno.test("reads the member's sub from userinfo and builds the author URN", async () => {
  const { calls, fetcher } = stub(() => json({ sub: "abc_123", name: "Anton" }))
  const result = await readLinkedinMember({ accessToken: TOKEN, fetch: fetcher })
  assertEquals(result, {
    success: true,
    output: { sub: "abc_123", authorUrn: "urn:li:person:abc_123" },
    error: "",
  })
  assertEquals(calls[0].url, "https://api.linkedin.com/v2/userinfo")
  assertEquals(calls[0].method, "GET")
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`)
})

Deno.test("rejects a userinfo answer whose sub cannot form a URN", async () => {
  for (const body of [{}, { sub: "" }, { sub: "a:b" }]) {
    const { fetcher } = stub(() => json(body))
    const result = await readLinkedinMember({ accessToken: TOKEN, fetch: fetcher })
    assertEquals(result.success, false, JSON.stringify(body))
  }
})

Deno.test("tells the member to sign in again after a 401", async () => {
  const { fetcher } = stub(() => json({ message: "Invalid access token", status: 401 }, 401))
  const result = await readLinkedinMember({ accessToken: TOKEN, fetch: fetcher })
  assertEquals(
    result.error,
    "linkedin answered HTTP 401: Invalid access token; the access token is invalid or expired, sign in again",
  )
})

Deno.test("posts a public article share with the versioned headers and returns the post URN and url", async () => {
  const { calls, fetcher } = stub(created)
  const result = await postLinkedinShare({
    ...SHARE,
    link: { ...SHARE.link, description: "Intro" },
    fetch: fetcher,
  })
  assertEquals(result, {
    success: true,
    output: { id: POST_ID, url: `https://www.linkedin.com/feed/update/${POST_ID}/` },
    error: "",
  })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://api.linkedin.com/rest/posts")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].redirect, "manual")
  assertEquals(calls[0].headers.get("authorization"), `Bearer ${TOKEN}`)
  assertEquals(calls[0].headers.get("linkedin-version"), LINKEDIN_VERSION)
  assertEquals(calls[0].headers.get("x-restli-protocol-version"), "2.0.0")
  assertEquals(calls[0].headers.get("content-type"), "application/json")
  assertEquals(JSON.parse(calls[0].body ?? ""), {
    author: "urn:li:person:abc_123",
    commentary: "New post",
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    content: {
      article: { source: "https://seedsaas.com/blog/hello", title: "Hello", description: "Intro" },
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  })
})

Deno.test("sends the LinkedIn-Version the caller picks", async () => {
  const { calls, fetcher } = stub(created)
  await postLinkedinShare({ ...SHARE, linkedinVersion: "202701", fetch: fetcher })
  assertEquals(calls[0].headers.get("linkedin-version"), "202701")
})

Deno.test("escapes little-format characters in the commentary but keeps hashtags", async () => {
  const { calls, fetcher } = stub(created)
  await postLinkedinShare({
    ...SHARE,
    commentary: "Seed (v2) @ [home] *new* C# #deno_land #2026 a#b \\ {x}|<y>~",
    fetch: fetcher,
  })
  assertEquals(
    JSON.parse(calls[0].body ?? "").commentary,
    "Seed \\(v2\\) \\@ \\[home\\] \\*new\\* C\\# #deno\\_land #2026 a\\#b \\\\ \\{x\\}\\|\\<y\\>\\~",
  )
})

Deno.test("retries a 429 after the Retry-After delay, then posts", async () => {
  const { calls, fetcher } = stub((n) =>
    n === 1 ? json({}, 429, { "Retry-After": "4" }) : created()
  )
  const { waits, sleep } = recorder()
  const result = await postLinkedinShare({ ...SHARE, fetch: fetcher, sleep })
  assertEquals(result.success, true)
  assertEquals(calls.length, 2)
  assertEquals(waits, [4000])
})

Deno.test("does not post again after a 5xx, a dropped connection or a timeout", async () => {
  const answers = [
    () => json({ message: "Internal error" }, 503),
    () => Promise.reject(new TypeError("reset")),
    () => Promise.reject(new DOMException("timed out", "TimeoutError")),
  ]
  for (const respond of answers) {
    const { calls, fetcher } = stub(respond)
    const result = await postLinkedinShare({
      ...SHARE,
      fetch: fetcher,
      sleep: () => Promise.resolve(),
    })
    assertEquals(calls.length, 1)
    assertStringIncludes(result.error, "the post may exist, check the profile first")
  }
})

Deno.test("reports LinkedIn's 422 message without claiming the post may exist", async () => {
  const { fetcher } = stub(() => json({ message: "FIELD_LENGTH_TOO_LONG", status: 422 }, 422))
  const result = await postLinkedinShare({ ...SHARE, fetch: fetcher })
  assertEquals(result.error, "linkedin answered HTTP 422: FIELD_LENGTH_TOO_LONG")
})

Deno.test("fails when a 201 carries no valid x-restli-id, saying the post may exist", async () => {
  for (const id of [undefined, "", "urn:li:person:1", "urn:li:share:1/../x"]) {
    const { fetcher } = stub(() =>
      new Response(null, { status: 201, headers: id === undefined ? {} : { "x-restli-id": id } })
    )
    const result = await postLinkedinShare({ ...SHARE, fetch: fetcher })
    assertEquals(result.success, false, String(id))
    assertStringIncludes(result.error, "may exist")
  }
})

Deno.test("refuses a redirect instead of following it with the token", async () => {
  const { calls, fetcher } = stub(() =>
    new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
  )
  const result = await postLinkedinShare({ ...SHARE, fetch: fetcher })
  assertEquals(calls.length, 1)
  assertEquals(result.error, "linkedin answered with a redirect (302)")
})

Deno.test("refuses a bad token, author, version or share without sending a request", async () => {
  const { calls, fetcher } = stub(created)
  const bad: Partial<PostLinkedinShareOptions>[] = [
    { accessToken: "" },
    { accessToken: "has space" },
    { authorUrn: "urn:li:organization:1" },
    { linkedinVersion: "2026-10" },
    { commentary: "" },
    { commentary: "x".repeat(3001) },
    { link: { url: "ftp://x", title: "t" } },
    { link: { url: "https://x.example", title: "" } },
  ]
  for (const change of bad) {
    const result = await postLinkedinShare({ ...SHARE, ...change, fetch: fetcher })
    assertEquals(result.success, false, JSON.stringify(change))
  }
  assertEquals(calls.length, 0)
})

Deno.test("never puts the access token in an error, whatever fails", async () => {
  const answers = [
    () => json({ message: `token ${TOKEN} revoked` }, 401),
    () => json({ message: `token ${TOKEN}` }, 500),
    () => Promise.reject(new TypeError(`connect ${TOKEN}`)),
    () => new Response(`not json ${TOKEN}`, { status: 200 }),
  ]
  for (const respond of answers) {
    const { fetcher } = stub(respond)
    const sleep = () => Promise.resolve()
    for (
      const result of [
        await postLinkedinShare({ ...SHARE, fetch: fetcher, sleep }),
        await readLinkedinMember({ accessToken: TOKEN, fetch: fetcher, sleep }),
      ]
    ) {
      assert(!JSON.stringify(result).includes(TOKEN), result.error)
    }
  }
})
