import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { INDEXNOW_MAX_URLS, submitIndexNow } from "./indexnow.ts"

const KEY = "0123456789abcdef"

interface Call {
  url: string
  method: string
  contentType: string | null
  body: unknown
}

/** A fetch stub that records every call and answers from `respond`. */
const stub = (respond: (init?: RequestInit) => Response | Promise<Response>) => {
  const calls: Call[] = []
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      contentType: new Headers(init?.headers).get("content-type"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return Promise.resolve(respond(init))
  }) as typeof fetch
  return { calls, fetcher }
}

const ok = () => new Response(null, { status: 200 })

Deno.test("posts host, key, keyLocation and urlList as JSON to api.indexnow.org", async () => {
  const { calls, fetcher } = stub(ok)
  const result = await submitIndexNow({
    host: "Shop.Example",
    key: KEY,
    keyLocation: "https://shop.example/keys/indexnow.txt",
    urls: ["https://shop.example/a", "https://shop.example/b"],
    fetch: fetcher,
  })
  assertEquals(result, { success: true, output: "submitted 2 URL(s)", error: "" })
  assertEquals(calls.length, 1)
  assertEquals(calls[0].url, "https://api.indexnow.org/indexnow")
  assertEquals(calls[0].method, "POST")
  assertEquals(calls[0].contentType, "application/json; charset=utf-8")
  assertEquals(calls[0].body, {
    host: "shop.example",
    key: KEY,
    keyLocation: "https://shop.example/keys/indexnow.txt",
    urlList: ["https://shop.example/a", "https://shop.example/b"],
  })
})

Deno.test("leaves keyLocation out when the key file is at the root", async () => {
  const { calls, fetcher } = stub(ok)
  await submitIndexNow({
    host: "shop.example",
    key: KEY,
    urls: ["https://shop.example/"],
    fetch: fetcher,
  })
  assertEquals(Object.keys(calls[0].body as object), ["host", "key", "urlList"])
})

Deno.test("treats 202, key validation pending, as success", async () => {
  const { fetcher } = stub(() => new Response(null, { status: 202 }))
  const result = await submitIndexNow({
    host: "shop.example",
    key: KEY,
    urls: ["https://shop.example/a"],
    fetch: fetcher,
  })
  assertEquals(result.success, true)
})

Deno.test("fails with the status and its meaning on 403, and the status alone on 500", async () => {
  for (
    const [status, expected] of [
      [403, "submission failed (HTTP 403: key not valid"],
      [500, "submission failed (HTTP 500)"],
    ] as const
  ) {
    const { fetcher } = stub(() => new Response("nope", { status }))
    const result = await submitIndexNow({
      host: "shop.example",
      key: KEY,
      urls: ["https://shop.example/a"],
      fetch: fetcher,
    })
    assertEquals(result.success, false)
    assertStringIncludes(result.error, expected)
  }
})

Deno.test("sends nothing for an empty list", async () => {
  const { calls, fetcher } = stub(ok)
  const result = await submitIndexNow({ host: "shop.example", key: KEY, urls: [], fetch: fetcher })
  assertEquals(result, { success: true, output: "nothing to submit", error: "" })
  assertEquals(calls.length, 0)
})

Deno.test("accepts 10,000 URLs and refuses 10,001 without a request", async () => {
  const { calls, fetcher } = stub(ok)
  const urls = Array.from(
    { length: INDEXNOW_MAX_URLS + 1 },
    (_, i) => `https://shop.example/p${i}`,
  )
  const over = await submitIndexNow({ host: "shop.example", key: KEY, urls, fetch: fetcher })
  assertEquals(over.success, false)
  assertStringIncludes(over.error, "10001 URLs, IndexNow takes 10000")
  assertEquals(calls.length, 0)

  const full = await submitIndexNow({
    host: "shop.example",
    key: KEY,
    urls: urls.slice(0, INDEXNOW_MAX_URLS),
    fetch: fetcher,
  })
  assertEquals(full.success, true)
  assertEquals(calls.length, 1)
})

Deno.test("refuses a URL on another host or with another scheme without a request", async () => {
  const { calls, fetcher } = stub(ok)
  for (const url of ["https://other.example/a", "ftp://shop.example/a", "/a"]) {
    const result = await submitIndexNow({
      host: "shop.example",
      key: KEY,
      urls: [url],
      fetch: fetcher,
    })
    assertEquals(result.success, false)
    assertStringIncludes(result.error, "not an http or https URL on shop.example")
  }
  assertEquals(calls.length, 0)
})

Deno.test("refuses a key of the wrong shape and a keyLocation on another host", async () => {
  const { calls, fetcher } = stub(ok)
  const urls = ["https://shop.example/a"]
  for (const key of ["short", "has space-0123456", "x".repeat(129)]) {
    const result = await submitIndexNow({ host: "shop.example", key, urls, fetch: fetcher })
    assertStringIncludes(result.error, "key must be 8 to 128 letters, digits and dashes")
  }
  const located = await submitIndexNow({
    host: "shop.example",
    key: KEY,
    keyLocation: "https://other.example/key.txt",
    urls,
    fetch: fetcher,
  })
  assertStringIncludes(located.error, "keyLocation must be an http or https URL on shop.example")
  assertEquals(calls.length, 0)
})

Deno.test("reports a timeout instead of waiting forever", async () => {
  const { fetcher } = stub((init) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
    })
  )
  const result = await submitIndexNow({
    host: "shop.example",
    key: KEY,
    urls: ["https://shop.example/a"],
    fetch: fetcher,
    requestTimeoutMs: 10,
  })
  assertEquals(result, {
    success: false,
    output: "",
    error: "request failed (request timed out after 10 ms)",
  })
})

Deno.test("never throws on a transport error and withholds the URL", async () => {
  const fetcher =
    (() => Promise.reject(new TypeError("dns failed for api.indexnow.org"))) as typeof fetch
  const result = await submitIndexNow({
    host: "shop.example",
    key: KEY,
    urls: ["https://shop.example/a"],
    fetch: fetcher,
  })
  assertEquals(result.success, false)
  assertEquals(result.error, "request failed (TypeError: transport failure (url withheld))")
  assert(!result.error.includes("api.indexnow.org"))
})
