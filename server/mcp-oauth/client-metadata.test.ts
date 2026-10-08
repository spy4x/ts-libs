import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { Fetcher } from "@spy4x/net/safe-fetch"
import type { DnsResolver } from "@spy4x/net/url-policy"
import { createClientMetadataFetcher, isClientIdUrl } from "./client-metadata.ts"

const CLIENT_ID = "https://claude.example/oauth/client-metadata"

const publicResolver: DnsResolver = {
  resolve: (host) =>
    Promise.resolve(host.endsWith("internal.example") ? ["10.0.0.1"] : ["93.184.216.34"]),
}

function fetcherFor(respond: (url: string) => Response): Fetcher & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch(input) {
      calls.push(input)
      return Promise.resolve(respond(input))
    },
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const goodDocument = {
  client_id: CLIENT_ID,
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  token_endpoint_auth_method: "none",
}

describe("createClientMetadataFetcher", () => {
  it("loads a valid document", async () => {
    const fetcher = fetcherFor(() => json(goodDocument))
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toEqual({
      clientId: CLIENT_ID,
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    })
  })

  it("refuses a document not served as JSON, and accepts a +json type", async () => {
    const html = createClientMetadataFetcher({
      fetcher: fetcherFor(() =>
        new Response(JSON.stringify(goodDocument), { headers: { "content-type": "text/html" } })
      ),
      resolver: publicResolver,
    })
    expect(await html.load(CLIENT_ID)).toBeUndefined()
    const typed = createClientMetadataFetcher({
      fetcher: fetcherFor(() =>
        new Response(JSON.stringify(goodDocument), {
          headers: { "content-type": "application/oauth-client+json; charset=utf-8" },
        })
      ),
      resolver: publicResolver,
    })
    expect((await typed.load(CLIENT_ID))?.clientName).toBe("Claude")
  })

  it("strips invisible characters from client_name and caps its length", async () => {
    const load = (clientName: string) =>
      createClientMetadataFetcher({
        fetcher: fetcherFor(() => json({ ...goodDocument, client_name: clientName })),
        resolver: publicResolver,
      }).load(CLIENT_ID)
    expect((await load("Cla\u202Eude\u200B\n"))?.clientName).toBe("Claude")
    const long = (await load("x".repeat(500)))?.clientName ?? ""
    expect(Array.from(long)).toHaveLength(100)
    expect(long.endsWith("…")).toBe(true)
    expect((await load("\u200B\u202E"))?.clientName).toBe("claude.example")
  })

  it("gives up on a body that drips past the time budget, and cancels it", async () => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(JSON.stringify(goodDocument))
        let i = 0
        timer = setInterval(() => {
          if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i))
          else controller.close()
        }, 20)
      },
      cancel() {
        cancelled = true
        clearInterval(timer)
      },
    })
    const source = createClientMetadataFetcher({
      fetcher: fetcherFor(() =>
        new Response(body, { headers: { "content-type": "application/json" } })
      ),
      resolver: publicResolver,
      timeoutMs: 200,
    })
    const started = Date.now()
    try {
      expect(await source.load(CLIENT_ID)).toBeUndefined()
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(cancelled).toBe(true)
    } finally {
      clearInterval(timer)
    }
  })

  it("refuses a document whose client_id is not its own URL", async () => {
    const fetcher = fetcherFor(() => json({ ...goodDocument, client_id: "https://evil.example/c" }))
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
  })

  it("refuses a confidential-client document", async () => {
    const fetcher = fetcherFor(() =>
      json({ ...goodDocument, token_endpoint_auth_method: "client_secret_basic" })
    )
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
  })

  it("refuses a document without redirect URIs", async () => {
    const fetcher = fetcherFor(() => json({ ...goodDocument, redirect_uris: [] }))
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
  })

  it("refuses a document larger than the cap", async () => {
    const fetcher = fetcherFor(() => json({ ...goodDocument, client_name: "x".repeat(6000) }))
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
  })

  it("follows no redirect", async () => {
    const fetcher = fetcherFor((url) =>
      url === CLIENT_ID
        ? new Response(null, { status: 302, headers: { location: "https://claude.example/other" } })
        : json(goodDocument)
    )
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
    expect(fetcher.calls).toEqual([CLIENT_ID])
  })

  it("refuses a non-200 answer and non-JSON", async () => {
    const missing = createClientMetadataFetcher({
      fetcher: fetcherFor(() => json(goodDocument, 404)),
      resolver: publicResolver,
    })
    expect(await missing.load(CLIENT_ID)).toBeUndefined()
    const garbage = createClientMetadataFetcher({
      fetcher: fetcherFor(() =>
        new Response("<html>", { headers: { "content-type": "application/json" } })
      ),
      resolver: publicResolver,
    })
    expect(await garbage.load(CLIENT_ID)).toBeUndefined()
  })

  it("never fetches a client_id on a private address", async () => {
    const id = "https://idp.internal.example/client"
    const fetcher = fetcherFor(() => json({ ...goodDocument, client_id: id }))
    const source = createClientMetadataFetcher({ fetcher, resolver: publicResolver })
    expect(await source.load(id)).toBeUndefined()
    expect(fetcher.calls).toEqual([])
  })

  it("never fetches a client_id off the trusted hosts", async () => {
    const fetcher = fetcherFor(() => json(goodDocument))
    const source = createClientMetadataFetcher({
      fetcher,
      resolver: publicResolver,
      trustedHosts: ["claude.ai"],
    })
    expect(await source.load(CLIENT_ID)).toBeUndefined()
    expect(fetcher.calls).toEqual([])
  })

  it("reuses a fetched document until the cache expires", async () => {
    let now = 0
    const fetcher = fetcherFor(() => json(goodDocument))
    const source = createClientMetadataFetcher({
      fetcher,
      resolver: publicResolver,
      clock: { now: () => now },
      cacheMs: 1_000,
    })
    await source.load(CLIENT_ID)
    now = 999
    await source.load(CLIENT_ID)
    expect(fetcher.calls).toHaveLength(1)
    now = 1_000
    await source.load(CLIENT_ID)
    expect(fetcher.calls).toHaveLength(2)
  })
})

describe("isClientIdUrl", () => {
  it("accepts an https URL with a path", () => {
    expect(isClientIdUrl(CLIENT_ID)).toBe(true)
  })

  it("refuses http, a bare origin, a fragment, user info and dot segments", () => {
    expect(isClientIdUrl("http://claude.example/c")).toBe(false)
    expect(isClientIdUrl("https://claude.example/")).toBe(false)
    expect(isClientIdUrl("https://claude.example")).toBe(false)
    expect(isClientIdUrl("https://claude.example/c#x")).toBe(false)
    expect(isClientIdUrl("https://u:p@claude.example/c")).toBe(false)
    expect(isClientIdUrl("https://claude.example/a/../c")).toBe(false)
  })
})
