import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { apiFetch } from "./api.ts"

/**
 * `apiFetch` calls the module-global `fetch`, so these tests swap `globalThis.fetch` for a fake
 * and restore the original in `finally`.
 *
 * The fake is declared as an ordinary named function — `function fetch(...) {}` — rather than an
 * arrow function assigned to a variable, so it matches the real `fetch`'s shape, not just its call
 * signature. Checked directly against Deno's own `globalThis.fetch` in a throwaway script:
 *
 * ```
 * name: fetch
 * length: 0
 * ownKeys: [ "length", "name", "prototype" ]
 * has own prototype: true
 * toString: function fetch(...e){return lazyFetch().fetch(...new n(e))}
 * ```
 *
 * Deno's real `fetch` takes a rest parameter internally, which is why `.length` is `0` rather than
 * `1` or `2` (neither `input` nor `init` counts toward `.length` once they are folded into a
 * rest parameter) — an arrow function assigned to a variable would report the closure's name
 * (`""` or the variable name, never `"fetch"`) and has no own `prototype` at all. The fake below
 * uses the same rest-parameter, named-declaration shape and was confirmed to report the same
 * `name`, `length`, own keys, and own `prototype` as the real one.
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

/** How many entries a `Headers` instance carries under `name` (compared case-insensitively). */
function countHeader(headers: Headers, name: string): number {
  let count = 0
  for (const [key] of headers) {
    if (key === name.toLowerCase()) count++
  }
  return count
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

  it("lets a mixed-case Content-Type win when given as a plain object, sending exactly one", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: { "Content-Type": "text/plain" } })
      },
    )
    expect(seen?.get("content-type")).toBe("text/plain")
    expect(countHeader(seen!, "content-type")).toBe(1)
  })

  it("lets a mixed-case Content-Type win when given as an array of pairs, sending exactly one", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: [["Content-Type", "text/plain"]] })
      },
    )
    expect(seen?.get("content-type")).toBe("text/plain")
    expect(countHeader(seen!, "content-type")).toBe(1)
  })

  it("lets a mixed-case Content-Type win when given as a Headers instance, sending exactly one", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { headers: new Headers({ "Content-Type": "text/plain" }) })
      },
    )
    expect(seen?.get("content-type")).toBe("text/plain")
    expect(countHeader(seen!, "content-type")).toBe(1)
  })
})

describe("apiFetch — content-type by body shape (#132)", () => {
  it("still sends application/json for a JSON string body", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { method: "POST", body: JSON.stringify({ a: 1 }) })
      },
    )
    expect(seen?.get("content-type")).toBe("application/json")
  })

  it("lets fetch set its own multipart content-type for a FormData body", async () => {
    let seenContentType: string | null | undefined
    await withFakeFetch(
      (input, init) => {
        // A fake fetch only sees the raw init; building a real Request from it is how the
        // browser actually decides the content-type once the body is a FormData.
        const request = new Request(new URL(String(input), "http://localhost"), init)
        seenContentType = request.headers.get("content-type")
        return jsonResponse({})
      },
      async () => {
        const formData = new FormData()
        formData.append("file", new Blob(["hi"]), "hi.txt")
        await apiFetch("/x", { method: "POST", body: formData })
      },
    )
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=/)
  })

  it("sends no content-type of its own for every other body shape fetch understands", async () => {
    const bodies: Array<[string, BodyInit]> = [
      ["URLSearchParams", new URLSearchParams({ a: "1" })],
      ["Blob", new Blob(["hi"])],
      ["ArrayBuffer", new ArrayBuffer(4)],
      ["Uint8Array", new Uint8Array([1, 2, 3])],
      [
        "ReadableStream",
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            controller.close()
          },
        }),
      ],
    ]
    for (const [label, body] of bodies) {
      let seen: Headers | undefined
      await withFakeFetch(
        (_input, init) => {
          seen = new Headers(init?.headers)
          return jsonResponse({})
        },
        async () => {
          await apiFetch("/x", { method: "POST", body })
        },
      )
      expect(seen?.has("content-type"), label).toBe(false)
    }
  })

  it("sets no default content-type for an explicit null body either", async () => {
    // `body: null` takes the same path as `FormData` etc, not the `body === undefined` path:
    // it is neither `undefined` nor a `string`, so the default is left off. Pinned because a
    // reader could otherwise expect "no body" and "null body" to behave the same way.
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { method: "POST", body: null })
      },
    )
    expect(seen?.has("content-type")).toBe(false)
  })

  it("still lets a caller's explicit content-type win for a FormData body", async () => {
    let seen: Headers | undefined
    await withFakeFetch(
      (_input, init) => {
        seen = new Headers(init?.headers)
        return jsonResponse({})
      },
      async () => {
        const formData = new FormData()
        formData.append("file", new Blob(["hi"]), "hi.txt")
        await apiFetch("/x", {
          method: "POST",
          body: formData,
          headers: { "content-type": "application/x-custom" },
        })
      },
    )
    expect(seen?.get("content-type")).toBe("application/x-custom")
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

  it("lets a caller's own credentials win over the include default", async () => {
    let seenCredentials: RequestCredentials | undefined
    await withFakeFetch(
      (_input, init) => {
        seenCredentials = init?.credentials
        return jsonResponse({})
      },
      async () => {
        await apiFetch("/x", { credentials: "omit" })
      },
    )
    expect(seenCredentials).toBe("omit")
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

describe("apiFetch — error body shapes", () => {
  /** Fetch `/x` against a fake that answers `body` with `status`, and return the error. */
  async function errorFor(body: unknown, status = 502) {
    let result: Awaited<ReturnType<typeof apiFetch>> | undefined
    await withFakeFetch(
      () => jsonResponse(body, status),
      async () => {
        result = await apiFetch("/x")
      },
    )
    if (result === undefined || result.ok) throw new Error(`expected a failure, got ${result}`)
    return result.error
  }

  it("reads code and message from a { code, message } body", async () => {
    expect(await errorFor({ code: "caldav_refused", message: "Server refused the login" }))
      .toEqual({ status: 502, message: "Server refused the login", code: "caldav_refused" })
  })

  it("prefers the error string over message when the body has both", async () => {
    expect(await errorFor({ error: "from error", message: "from message" })).toEqual({
      status: 502,
      message: "from error",
    })
  })

  it("keeps the code alongside an error string", async () => {
    expect(await errorFor({ error: "Unreachable", code: "caldav_unreachable" })).toEqual({
      status: 502,
      message: "Unreachable",
      code: "caldav_unreachable",
    })
  })

  it("sets the code and falls back to 'Request failed' when the body has only a code", async () => {
    expect(await errorFor({ code: "caldav_unreachable" })).toEqual({
      status: 502,
      message: "Request failed",
      code: "caldav_unreachable",
    })
  })

  it("ignores a non-string code and a non-string message", async () => {
    const error = await errorFor({ code: 42, message: { text: "nested" } })
    expect(error).toEqual({ status: 502, message: "Request failed" })
    expect("code" in error).toBe(false)
  })

  it("reads code and message from a { error: { code, message } } body", async () => {
    expect(await errorFor({ error: { code: "x", message: "y", requestId: "r1" } }, 403))
      .toEqual({ status: 403, message: "y", code: "x" })
  })

  it("prefers the nested code and message over the top-level ones", async () => {
    expect(await errorFor({ error: { code: "inner", message: "inner msg" }, code: "outer" }))
      .toEqual({ status: 502, message: "inner msg", code: "inner" })
  })

  it("falls back to the top-level message and code when the nested ones are missing", async () => {
    expect(await errorFor({ error: { requestId: "r1" }, message: "outer msg", code: "outer" }))
      .toEqual({ status: 502, message: "outer msg", code: "outer" })
  })

  it("ignores non-string nested fields", async () => {
    const error = await errorFor({ error: { code: 42, message: { text: "deep" } } })
    expect(error).toEqual({ status: 502, message: "Request failed" })
    expect("code" in error).toBe(false)
  })

  it("ignores an error that is null", async () => {
    expect(await errorFor({ error: null })).toEqual({ status: 502, message: "Request failed" })
  })

  it("leaves code absent when the body has none", async () => {
    const error = await errorFor({ error: "not found" }, 404)
    expect("code" in error).toBe(false)
  })
})

describe("apiFetch — network failure", () => {
  it("rejects with fetch's own error instead of resolving a result", async () => {
    const failure = new TypeError("network down")
    await withFakeFetch(
      () => Promise.reject(failure),
      async () => {
        await expect(apiFetch("/x")).rejects.toBe(failure)
      },
    )
  })
})
