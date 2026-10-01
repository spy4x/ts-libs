// The fake "Fetcher" the net tests inject, held to "fetcher-contract.test.ts".
//
// "fetcher-contract.test.ts" runs the same cases on this fake ("_fake-fetcher.contract.test.ts",
// unit tier) and on the platform "fetch" against a loopback server
// ("fetcher-contract.integration.test.ts"). "safe-fetch.test.ts" builds every response it scripts
// through "fakeResponse", so what the contract proves about it holds for those tests too.
//
// Not a test file in itself: it is named "*.test.ts" only so the root "publish.exclude" pattern
// keeps it out of the published package.

import type { Fetcher } from "./safe-fetch.ts"

/** What one fake (or real) endpoint answers. */
export interface ResponseSpec {
  /** Defaults to 200. */
  status?: number
  headers?: Record<string, string>
  /** Text, or the exact chunks of a streamed body. Defaults to an empty body. */
  body?: string | Uint8Array[]
  /** Send the chunks, then keep the body open until the caller cancels or aborts. */
  stall?: boolean
  /** Never answer: the response does not arrive until the caller aborts. */
  hang?: boolean
}

/** A request the fake received. */
export interface ReceivedRequest {
  method: string
  path: string
  headers: Record<string, string>
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The signal has been aborted", "AbortError")
}

/**
 * The response a fetcher returns for "url", built the way the platform "fetch" builds it: "url" is
 * the requested URL, a stalled body ends in the signal's error when the signal aborts, and a
 * redirect is returned as it is, never followed.
 */
export function fakeResponse(url: string, spec: ResponseSpec, signal?: AbortSignal): Response {
  let body: BodyInit | null = null
  if (typeof spec.body === "string") {
    body = spec.body
  } else if (spec.body !== undefined || spec.stall) {
    const chunks = spec.body ?? []
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        if (!spec.stall) {
          controller.close()
          return
        }
        signal?.addEventListener("abort", () => {
          try {
            controller.error(abortError(signal))
          } catch {
            // Already cancelled by the reader: nothing left to fail.
          }
        }, { once: true })
      },
    })
  }
  const response = new Response(body, { status: spec.status ?? 200, headers: spec.headers })
  Object.defineProperty(response, "url", { value: url })
  return response
}

/** The fake under contract: routes by path, records every request, honours the signal. */
export function createFakeFetcher(origin = "https://fake.test"): {
  fetcher: Fetcher
  serve(path: string, spec: ResponseSpec): string
  requests: ReceivedRequest[]
} {
  const routes = new Map<string, ResponseSpec>()
  const requests: ReceivedRequest[] = []
  const fetcher: Fetcher = {
    fetch(input, init) {
      const url = new URL(input)
      requests.push({
        method: init.method ?? "GET",
        path: url.pathname + url.search,
        headers: Object.fromEntries(
          Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      })
      const signal = init.signal
      if (signal?.aborted) return Promise.reject(abortError(signal))
      const spec = routes.get(url.pathname) ?? { status: 404 }
      if (spec.hang) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(abortError(signal)), { once: true })
        })
      }
      return Promise.resolve(fakeResponse(input, spec, signal))
    },
  }
  return {
    fetcher,
    serve: (path, spec) => {
      routes.set(path, spec)
      return origin + path
    },
    requests,
  }
}
