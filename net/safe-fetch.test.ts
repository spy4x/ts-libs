import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  DEFAULT_MAX_REDIRECTS,
  defaultFetcher,
  type Fetcher,
  safeFetch,
  SafeFetchMethod,
} from "./safe-fetch.ts"
import { type DnsResolver, UrlValidationError, validatePublicUrl } from "./url-policy.ts"

/** Deterministic resolver: one host answers private, everything else public. */
const ALWAYS_PUBLIC: DnsResolver = {
  resolve: (host: string) => {
    if (host.endsWith("evil.test")) return Promise.resolve(["10.0.0.1"])
    return Promise.resolve(["93.184.216.34"])
  },
}

interface Step {
  url: string
  status?: number
  location?: string
  body?: string
  headers?: Record<string, string>
  method?: string
}

/**
 * A `Fetcher` that replays a fixed script and asserts the URL of every call.
 *
 * A mismatch is returned as a 599 instead of thrown, so a test that drifts off
 * the planned chain fails on the assertion it cares about rather than on an
 * unrelated exception.
 */
function fakeFetcher(
  steps: Step[],
): { fetcher: Fetcher; getCalls: () => number; methods: string[] } {
  let calls = 0
  const methods: string[] = []
  const fetcher: Fetcher = {
    fetch(input, init) {
      const step = steps[calls]
      calls++
      methods.push(init.method ?? "")
      // Confirm the URL the caller is asking for matches the planned step.
      if (!step || step.url !== input) {
        return Promise.resolve(
          new Response(`<html>unexpected fetch: ${input} (expected ${step?.url})</html>`, {
            status: 599,
          }),
        )
      }
      const headers = new Headers(step.headers ?? {})
      if (step.location) headers.set("location", step.location)
      const status = step.status ?? 200
      const body = step.body ?? `<html>ok:${input}</html>`
      return Promise.resolve(new Response(body, { status, headers }))
    },
  }
  return { fetcher, getCalls: () => calls, methods }
}

/** A fetcher that records the URLs it was asked for, always answering 200. */
function recordingFetcher(): { fetcher: Fetcher; urls: string[] } {
  const urls: string[] = []
  const fetcher: Fetcher = {
    fetch(input) {
      urls.push(input)
      return Promise.resolve(new Response("ok", { status: 200 }))
    },
  }
  return { fetcher, urls }
}

describe("safeFetch", () => {
  it("returns the response on a 200 with no redirects", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/page", status: 200, body: "<html>hi</html>" },
    ])
    const result = await safeFetch("https://example.com/page", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, "https://example.com/page")
    assertEquals(result.response.status, 200)
    assertEquals(await result.response.text(), "<html>hi</html>")
  })

  it("follows a single 302 redirect to a public host", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "/new" },
      { url: "https://example.com/new", status: 200, body: "<html>ok</html>" },
    ])
    const result = await safeFetch("https://example.com/old", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, "https://example.com/new")
    assertEquals(result.response.status, 200)
  })

  it("follows up to MAX_REDIRECTS hops then accepts the body", async () => {
    const hops: Step[] = []
    for (let i = 0; i < DEFAULT_MAX_REDIRECTS; i++) {
      hops.push({ url: `https://example.com/h${i}`, status: 301, location: `/h${i + 1}` })
    }
    hops.push({ url: `https://example.com/h${DEFAULT_MAX_REDIRECTS}`, status: 200, body: "ok" })
    const { fetcher } = fakeFetcher(hops)
    const result = await safeFetch("https://example.com/h0", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, `https://example.com/h${DEFAULT_MAX_REDIRECTS}`)
  })

  it("rejects when the redirect count exceeds the cap", async () => {
    const hops: Step[] = []
    for (let i = 0; i <= DEFAULT_MAX_REDIRECTS; i++) {
      hops.push({ url: `https://example.com/h${i}`, status: 301, location: `/h${i + 1}` })
    }
    const { fetcher } = fakeFetcher(hops)
    await assertRejects(
      () => safeFetch("https://example.com/h0", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "redirects",
    )
  })

  it("rejects a redirect response with no Location header", async () => {
    const { fetcher } = fakeFetcher([{ url: "https://example.com/p", status: 302 }])
    await assertRejects(
      () => safeFetch("https://example.com/p", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "Location",
    )
  })

  // ── Redirect targets go back through the policy ──────────────────────────

  it("rejects a redirect to a host that resolves private", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "https://internal.evil.test/x" },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "non-public",
    )
  })

  it("rejects a redirect to localhost", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 301, location: "http://localhost/admin" },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "special-use",
    )
  })

  it("rejects a redirect to a javascript: scheme", async () => {
    // A browser would never pass `javascript:` through Location, but the client
    // cannot trust upstream. The policy must reject it, and nothing may be
    // fetched under that Location.
    const { fetcher, getCalls } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "javascript:alert(1)" },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
    )
    assertEquals(getCalls(), 1)
  })

  it("rejects a redirect with userinfo", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "https://user:pass@example.com/n" },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "credentials",
    )
  })

  it("rejects a redirect to a numeric private literal", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "http://169.254.169.254/latest" },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "non-public",
    )
  })

  it("rejects an initial URL that is not public", async () => {
    const { fetcher } = fakeFetcher([])
    await assertRejects(
      () => safeFetch("http://localhost/", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "special-use",
    )
  })

  it("applies the same policy to the initial URL and to each redirect", async () => {
    // Symmetry check: the exact URL a redirect refuses must also be refused as
    // a starting point, or the guard is only half-wired.
    const target = "https://internal.evil.test/landing"
    await assertRejects(
      () => validatePublicUrl(target, { resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "non-public",
    )
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: target },
    ])
    await assertRejects(
      () => safeFetch("https://example.com/old", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "non-public",
    )
  })

  // ── Canonical form ───────────────────────────────────────────────────────

  it("resolves a relative Location against the current URL", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/section/page", status: 301, location: "../other" },
      { url: "https://example.com/other", status: 200, body: "ok" },
    ])
    const result = await safeFetch("https://example.com/section/page", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, "https://example.com/other")
  })

  it("resolves a protocol-relative Location against the current scheme", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/section/page", status: 301, location: "//example.com/other" },
      { url: "https://example.com/other", status: 200, body: "ok" },
    ])
    const result = await safeFetch("https://example.com/section/page", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, "https://example.com/other")
  })

  it("preserves the canonical lowercase host across redirects", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 301, location: "https://EXAMPLE.com/new" },
      { url: "https://example.com/new", status: 200, body: "ok" },
    ])
    const result = await safeFetch("https://example.com/old", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url, "https://example.com/new")
  })

  it("never echoes userinfo in the returned URL", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 302, location: "https://EXAMPLE.com/new" },
      { url: "https://example.com/new", status: 200, body: "ok" },
    ])
    const result = await safeFetch("https://example.com/old", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(result.url.includes("@"), false)
    assertEquals(result.url.includes("user:"), false)
  })

  it("follows a scheme downgrade to http once the target is validated", async () => {
    const { fetcher } = fakeFetcher([
      { url: "https://example.com/old", status: 301, location: "http://example.com/new" },
      { url: "http://example.com/new", status: 200, body: "ok" },
    ])
    const result = await safeFetch("https://example.com/old", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertStringIncludes(result.url, "http://example.com/new")
  })

  it("stops at maxRedirects when the cap is lowered", async () => {
    const { fetcher, getCalls } = fakeFetcher([
      { url: "https://example.com/h0", status: 301, location: "/h1" },
      { url: "https://example.com/h1", status: 301, location: "/h2" },
      { url: "https://example.com/h2", status: 200, body: "ok" },
    ])
    await assertRejects(
      () =>
        safeFetch("https://example.com/h0", {
          fetcher,
          resolver: ALWAYS_PUBLIC,
          maxRedirects: 1,
        }),
      UrlValidationError,
      "redirects",
    )
    assertEquals(getCalls(), 2) // h0 and h1 — no h2
  })

  // ── Method handling ──────────────────────────────────────────────────────

  it("downgrades a POST to GET on a 303", async () => {
    const { fetcher, methods } = fakeFetcher([
      { url: "https://example.com/submit", status: 303, location: "/done" },
      { url: "https://example.com/done", status: 200, body: "ok" },
    ])
    await safeFetch("https://example.com/submit", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
      method: SafeFetchMethod.Post,
    })
    assertEquals(methods, ["POST", "GET"])
  })

  it("preserves the method on a 307", async () => {
    const { fetcher, methods } = fakeFetcher([
      { url: "https://example.com/submit", status: 307, location: "/done" },
      { url: "https://example.com/done", status: 200, body: "ok" },
    ])
    await safeFetch("https://example.com/submit", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
      method: SafeFetchMethod.Post,
    })
    assertEquals(methods, ["POST", "POST"])
  })

  it("defaults to GET", async () => {
    const { fetcher, methods } = fakeFetcher([
      { url: "https://example.com/page", status: 200, body: "ok" },
    ])
    await safeFetch("https://example.com/page", { fetcher, resolver: ALWAYS_PUBLIC })
    assertEquals(methods, ["GET"])
  })

  // ── Timeout, cancellation and the timer lifecycle ────────────────────────

  it("aborts an in-flight fetch when the timeout fires", async () => {
    let abortFired = false
    const slowFetcher: Fetcher = {
      fetch(_input, init) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal
          if (!signal) return
          if (signal.aborted) {
            abortFired = true
            reject(new DOMException("aborted", "AbortError"))
            return
          }
          signal.addEventListener("abort", () => {
            abortFired = true
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      },
    }
    await assertRejects(
      () =>
        safeFetch("https://example.com/slow", {
          fetcher: slowFetcher,
          resolver: ALWAYS_PUBLIC,
          timeoutMs: 5,
        }),
      DOMException,
      "aborted",
    )
    await new Promise((r) => setTimeout(r, 10))
    assertEquals(abortFired, true)
  })

  it("shares one timeout across every hop of the chain", async () => {
    // Two slow hops must not be allowed two budgets: the timer is created once,
    // before the first request, and cleared only in `finally`.
    let abortCount = 0
    const slowRedirectFetcher: Fetcher = {
      fetch(_input, init) {
        return new Promise<Response>((resolve, reject) => {
          const signal = init.signal
          const timer = setTimeout(
            () =>
              resolve(
                new Response(null, { status: 302, headers: { location: "https://example.com/b" } }),
              ),
            8,
          )
          signal?.addEventListener("abort", () => {
            clearTimeout(timer)
            abortCount++
            reject(new DOMException("aborted", "AbortError"))
          })
        })
      },
    }
    await assertRejects(
      () =>
        safeFetch("https://example.com/a", {
          fetcher: slowRedirectFetcher,
          resolver: ALWAYS_PUBLIC,
          timeoutMs: 20,
        }),
      DOMException,
      "aborted",
    )
    assertEquals(abortCount >= 1, true)
  })

  it("clears the timer when the initial validation rejects", async () => {
    await assertRejects(
      () =>
        safeFetch("http://localhost/", {
          fetcher: { fetch: () => Promise.resolve(new Response("x", { status: 200 })) },
          resolver: ALWAYS_PUBLIC,
        }),
      UrlValidationError,
    )
  })

  it("clears the timer when a slow resolver rejects", async () => {
    // Trade-off documented on the module: a slow resolver blocks past the
    // timeout — the timer cannot make an awaited DNS call return. This proves
    // the rejection path still leaves no timer behind.
    const slowResolver: DnsResolver = {
      resolve: () =>
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error("dns offline")), 30)
        ),
    }
    await assertRejects(
      () =>
        safeFetch("https://example.com/", {
          fetcher: { fetch: () => Promise.resolve(new Response("x", { status: 200 })) },
          resolver: slowResolver,
          timeoutMs: 100,
        }),
      UrlValidationError,
      "DNS",
    )
  })

  it("leaves the timer cleared when the fetcher throws", async () => {
    const failingFetcher: Fetcher = {
      fetch: () => Promise.reject(new Error("connection refused")),
    }
    await assertRejects(
      () => safeFetch("https://example.com/", { fetcher: failingFetcher, resolver: ALWAYS_PUBLIC }),
      Error,
      "connection refused",
    )
  })

  it("cancels the redirect body before throwing too_many_redirects", async () => {
    let cancelledCount = 0
    const fetcher: Fetcher = {
      fetch(_input) {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([0]))
            c.close()
          },
          cancel() {
            cancelledCount++
          },
        })
        return Promise.resolve(
          new Response(stream, { status: 301, headers: { location: "https://example.com/h0" } }),
        )
      },
    }
    await assertRejects(
      () => safeFetch("https://example.com/h0", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "redirects",
    )
    assertEquals(cancelledCount >= 1, true)
  })

  it("cancels the redirect body before throwing for a missing Location", async () => {
    let cancelledCount = 0
    const fetcher: Fetcher = {
      fetch(_input) {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new Uint8Array([0]))
            c.close()
          },
          cancel() {
            cancelledCount++
          },
        })
        return Promise.resolve(new Response(stream, { status: 302 }))
      },
    }
    await assertRejects(
      () => safeFetch("https://example.com/p", { fetcher, resolver: ALWAYS_PUBLIC }),
      UrlValidationError,
      "Location",
    )
    assertEquals(cancelledCount >= 1, true)
  })

  it("rejects a non-positive timeout instead of aborting silently", async () => {
    const { fetcher, getCalls } = fakeFetcher([
      { url: "https://example.com/page", status: 200, body: "ok" },
    ])
    for (const timeoutMs of [0, -1, Number.NaN]) {
      await assertRejects(
        () =>
          safeFetch("https://example.com/page", { fetcher, resolver: ALWAYS_PUBLIC, timeoutMs }),
        UrlValidationError,
        "timeoutMs",
      )
    }
    assertEquals(getCalls(), 0)
  })
})

describe("defaultFetcher", () => {
  it("always requests manual redirects", async () => {
    // `redirect: "manual"` is the whole guard: with the platform default the
    // runtime would follow a Location behind this module's back.
    const seen: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(String(init?.redirect))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as typeof fetch
    try {
      await defaultFetcher.fetch("https://example.com/", {
        redirect: "manual",
        method: "GET",
      })
    } finally {
      globalThis.fetch = original
    }
    assertEquals(seen, ["manual"])
  })
})

describe("safe-fetch integration with the real fetcher seam", () => {
  it("passes the requested URL through to the fetcher unchanged", async () => {
    const { fetcher, urls } = recordingFetcher()
    const result = await safeFetch("https://example.com/keeping/case?Q=1", {
      fetcher,
      resolver: ALWAYS_PUBLIC,
    })
    assertEquals(urls, ["https://example.com/keeping/case?Q=1"])
    assertEquals(result.url, "https://example.com/keeping/case?Q=1")
  })
})
