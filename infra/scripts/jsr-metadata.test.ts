import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  buildAllRequests,
  buildPackageRequests,
  requireApiToken,
  sendRequest,
} from "./jsr-metadata.ts"

const REPOSITORY = { owner: "spy4x", name: "ts-libs" }

describe("buildPackageRequests", () => {
  it("builds one PATCH request per field, description first", () => {
    const requests = buildPackageRequests(
      "time",
      { description: "IANA time-zone arithmetic on Intl.", runtimeCompat: { deno: true } },
      REPOSITORY,
    )

    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({
      method: "PATCH",
      url: "https://api.jsr.io/scopes/spy4x/packages/time",
      body: { description: "IANA time-zone arithmetic on Intl." },
    })
    expect(requests[1]).toEqual({
      method: "PATCH",
      url: "https://api.jsr.io/scopes/spy4x/packages/time",
      body: { githubRepository: REPOSITORY },
    })
    expect(requests[2]).toEqual({
      method: "PATCH",
      url: "https://api.jsr.io/scopes/spy4x/packages/time",
      body: { runtimeCompat: { deno: true } },
    })
  })

  it("never mixes two fields into one request body", () => {
    const requests = buildPackageRequests(
      "net",
      { description: "SSRF guards.", runtimeCompat: { deno: true } },
      REPOSITORY,
    )

    for (const request of requests) {
      expect(Object.keys(request.body)).toHaveLength(1)
    }
  })
})

describe("buildAllRequests", () => {
  it("builds three requests per package in the metadata file", () => {
    const requests = buildAllRequests({
      repository: REPOSITORY,
      packages: {
        net: { description: "SSRF guards.", runtimeCompat: { deno: true } },
        time: { description: "Time zones.", runtimeCompat: { deno: true, browser: true } },
      },
    })

    expect(requests).toHaveLength(6)
    expect(requests.filter((r) => r.url.endsWith("/net"))).toHaveLength(3)
    expect(requests.filter((r) => r.url.endsWith("/time"))).toHaveLength(3)
  })
})

describe("requireApiToken", () => {
  it("throws when JSR_API_TOKEN is not set", () => {
    const original = Deno.env.get("JSR_API_TOKEN")
    Deno.env.delete("JSR_API_TOKEN")
    try {
      expect(() => requireApiToken()).toThrow("JSR_API_TOKEN")
    } finally {
      if (original !== undefined) Deno.env.set("JSR_API_TOKEN", original)
    }
  })

  it("returns the token when it is set", () => {
    const original = Deno.env.get("JSR_API_TOKEN")
    Deno.env.set("JSR_API_TOKEN", "test-token-value")
    try {
      expect(requireApiToken()).toBe("test-token-value")
    } finally {
      if (original === undefined) Deno.env.delete("JSR_API_TOKEN")
      else Deno.env.set("JSR_API_TOKEN", original)
    }
  })
})

/**
 * `sendRequest` calls the module-global `fetch`, so this test swaps `globalThis.fetch` for a fake
 * and restores the original in `finally` — same approach as `platform/api/api.test.ts`.
 */
function withFakeFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch
  function fetch(...args: [input: RequestInfo | URL, init?: RequestInit]): Promise<Response> {
    return Promise.resolve(handler(args[0], args[1]))
  }
  globalThis.fetch = fetch
  return run().finally(() => {
    globalThis.fetch = real
  })
}

describe("sendRequest", () => {
  it("sends the bearer token and the request body as JSON", async () => {
    let capturedInit: RequestInit | undefined
    let capturedUrl: RequestInfo | URL | undefined

    await withFakeFetch(
      (input, init) => {
        capturedUrl = input
        capturedInit = init
        return new Response(null, { status: 200 })
      },
      async () => {
        await sendRequest(
          {
            method: "PATCH",
            url: "https://api.jsr.io/scopes/spy4x/packages/time",
            body: { description: "IANA time-zone arithmetic." },
          },
          "secret-token",
        )
      },
    )

    expect(capturedUrl).toBe("https://api.jsr.io/scopes/spy4x/packages/time")
    expect(capturedInit?.method).toBe("PATCH")
    const headers = new Headers(capturedInit?.headers)
    expect(headers.get("authorization")).toBe("Bearer secret-token")
    expect(capturedInit?.body).toBe(JSON.stringify({ description: "IANA time-zone arithmetic." }))
  })

  it("rejects with the status and body when JSR returns an error", async () => {
    await withFakeFetch(
      () => new Response("scope member required", { status: 403 }),
      async () => {
        await expect(
          sendRequest(
            {
              method: "PATCH",
              url: "https://api.jsr.io/scopes/spy4x/packages/time",
              body: { description: "x" },
            },
            "secret-token",
          ),
        ).rejects.toThrow("403")
      },
    )
  })
})
