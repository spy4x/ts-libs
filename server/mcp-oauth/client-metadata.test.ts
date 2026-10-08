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
      fetcher: fetcherFor(() => new Response("<html>")),
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
