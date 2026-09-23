import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { apiFetch } from "./api.ts"

/**
 * `apiFetch` calls the module-global `fetch`, so these tests swap `globalThis.fetch` for a fake
 * and restore the original in `finally`. The fake has the same call shape as the real `fetch`:
 * `(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`, two positional
 * arguments, a `Response` returned (not thrown), and `init.headers` may arrive as any
 * `HeadersInit` — the same freedom callers of the real `fetch` have.
 */
function withFakeFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(handler(input, init))) as typeof fetch
  return run().finally(() => {
    globalThis.fetch = real
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("apiFetch — header merge", () => {
  it("sends the default content-type when the caller passes no headers", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x")
      },
    )
    expect(seen?.get("content-type")).toBe("application/json")
  })

  it("adds a caller header (plain object form) to the default instead of replacing it", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: { authorization: "Bearer t" } })
      },
    )
    expect(seen?.get("content-type")).toBe("application/json")
    expect(seen?.get("authorization")).toBe("Bearer t")
  })

  it("adds a caller header given as an array of pairs", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: [["authorization", "Bearer t"]] })
      },
    )
    expect(seen?.get("content-type")).toBe("application/json")
    expect(seen?.get("authorization")).toBe("Bearer t")
  })

  it("adds a caller header given as a Headers instance", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: new Headers({ authorization: "Bearer t" }) })
      },
    )
    expect(seen?.get("content-type")).toBe("application/json")
    expect(seen?.get("authorization")).toBe("Bearer t")
  })

  it("lets the caller's own content-type win over the default", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: { "content-type": "text/plain" } })
      },
    )
    expect(seen?.get("content-type")).toBe("text/plain")
  })
})

describe("apiFetch — other init fields", () => {
  it("always sends credentials: include by default", async () => {
    let seenCredentials: RequestCredentials | undefined
    await withFakeFetch(
      (_input, init) => {
        seenCredentials = init?.credentials
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x")
      },
    )
    expect(seenCredentials).toBe("include")
  })

  it("still forwards every other init field (method, body, signal) to fetch", async () => {
    let seenInit: RequestInit | undefined
    const controller = new AbortController()
    await withFakeFetch(
      (_input, init) => {
        seenInit = init
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", {
          method: "POST",
          body: JSON.stringify({ a: 1 }),
          signal: controller.signal,
        })
      },
    )
    expect(seenInit?.method).toBe("POST")
    expect(seenInit?.body).toBe(JSON.stringify({ a: 1 }))
    expect(seenInit?.signal).toBe(controller.signal)
  })
})

describe("apiFetch — result shape", () => {
  it("returns ok:true with the parsed body on a 2xx response", async () => {
    await withFakeFetch(
      () => jsonResponse({ id: 1 }, 200),
      async () => {
        const result = await apiFetch<{ id: number }>("/x")
        expect(result).toEqual({ ok: true, status: 200, data: { id: 1 } })
      },
    )
  })

  it("uses the body's own error string on a failing response", async () => {
    await withFakeFetch(
      () => jsonResponse({ error: "not found" }, 404),
      async () => {
        const result = await apiFetch("/x")
        expect(result).toEqual({
          ok: false,
          status: 404,
          error: { status: 404, message: "not found" },
        })
      },
    )
  })

  it("falls back to 'Request failed' when the failing body has no string error field", async () => {
    await withFakeFetch(
      () => jsonResponse({ whatever: true }, 500),
      async () => {
        const result = await apiFetch("/x")
        expect(result).toEqual({
          ok: false,
          status: 500,
          error: { status: 500, message: "Request failed" },
        })
      },
    )
  })

  it("falls back to 'Request failed' on a failing response with a non-JSON body", async () => {
    await withFakeFetch(
      () => new Response("not json", { status: 500 }),
      async () => {
        const result = await apiFetch("/x")
        expect(result).toEqual({
          ok: false,
          status: 500,
          error: { status: 500, message: "Request failed" },
        })
      },
    )
  })

  it("treats a non-JSON body on a successful response as null data", async () => {
    await withFakeFetch(
      () => new Response("not json", { status: 200 }),
      async () => {
        const result = await apiFetch("/x")
        expect(result).toEqual({ ok: true, status: 200, data: null })
      },
    )
  })
})
