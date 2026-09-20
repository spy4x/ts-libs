/**
 * Integration tier (#74): `HealthchecksClient` against a real HTTP server.
 *
 * `healthchecks.test.ts` replaces `fetch` with a fake that resolves
 * synchronously, so the timeout and retry behaviour has only ever run against
 * instantaneous, in-process responses — a fake cannot prove a hanging server
 * is actually bounded. This file starts a real listener on `127.0.0.1` with
 * `Deno.serve({ port: 0 })` — an ephemeral loopback port, no container,
 * nothing reachable outside loopback — and drives the client's real `fetch`
 * calls against it.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { HealthchecksClient, HealthchecksOutcome } from "./healthchecks.ts"

/** Starts a plain HTTP server on an ephemeral loopback port, for this test only. */
const startServer = (
  handler: (request: Request) => Response | Promise<Response>,
): { baseUrl: string; stop: () => Promise<void> } => {
  const controller = new AbortController()
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: controller.signal, onListen: () => {} },
    handler,
  )
  const { port } = server.addr as Deno.NetAddr
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      controller.abort()
      await server.finished
    },
  }
}

/** How long the "never answers" test waits before failing on its own. */
const GUARD_BOUND_MS = 5000

/**
 * Rejects with a clear message if `promise` has not settled within `boundMs`.
 *
 * Without this, a regression that drops the client's own timeout turns this
 * test into a hang: nothing here ever times the client call out, so the test
 * would block the whole integration run until an outer process killed it,
 * printing no useful failure. `Promise.race` does not cancel the loser, so
 * the caller must still let it settle — see the `finally` block below.
 */
const withGuard = async <T>(promise: Promise<T>, boundMs: number): Promise<T> => {
  let timer: number | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the client did not give up within ${boundMs}ms`)),
      boundMs,
    )
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

describe("HealthchecksClient against a real server", () => {
  it("fails with a timeout error inside the budget when the server never answers", async () => {
    // The handler never resolves on its own; the test releases it explicitly
    // in `finally`, so cleanup never depends on the client having given up —
    // a client that regressed and never times out must not be able to hang
    // `stop()` too.
    let releasePendingRequest: (() => void) | undefined
    const { baseUrl, stop } = startServer(() =>
      new Promise<Response>((resolve) => {
        releasePendingRequest = () => resolve(new Response(null, { status: 599 }))
      })
    )
    const client = new HealthchecksClient(
      { pingUrl: `${baseUrl}/it-never-answers` },
      { requestTimeoutMs: 300, retry: { maxAttempts: 1, totalBudgetMs: 2000 } },
    )
    const startedAt = performance.now()
    const pinged = client.ping({ outcome: HealthchecksOutcome.Fail })
    try {
      const result = await withGuard(pinged, GUARD_BOUND_MS)
      const elapsedMs = performance.now() - startedAt
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.code).toBe("timeout")
      // A generous upper bound, not a tight wall-clock assertion: the point is
      // that the call returned at all instead of hanging forever.
      expect(elapsedMs).toBeLessThan(GUARD_BOUND_MS)
    } finally {
      releasePendingRequest?.()
      await stop()
      // Let the race's loser settle before this test function returns, so a
      // guard-triggered failure never leaves a dangling op for the sanitizers.
      await pinged.catch(() => {})
    }
  })

  it("retries past two transient failures and succeeds, sending the expected request", async () => {
    let requestCount = 0
    let received:
      | { method: string; path: string; contentType: string | null; body: string }
      | undefined
    const { baseUrl, stop } = startServer(async (request) => {
      requestCount++
      if (requestCount < 3) {
        return new Response("try again", { status: 500 })
      }
      received = {
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get("Content-Type"),
        body: await request.text(),
      }
      return new Response("", { status: 200 })
    })
    try {
      const client = new HealthchecksClient(
        { pingUrl: `${baseUrl}/it-check-not-real` },
        { retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, totalBudgetMs: 5000 } },
      )
      const result = await client.ping({
        outcome: HealthchecksOutcome.Fail,
        body: "3 of 5 failed",
      })
      expect(result.ok).toBe(true)
      expect(result.ok && result.attempts).toBe(3)
      expect(requestCount).toBe(3)
      expect(received?.method).toBe("POST")
      expect(received?.path).toBe("/it-check-not-real/fail")
      expect(received?.body).toBe("3 of 5 failed")
      // A string body's default Content-Type, proving the request headers
      // reached the server rather than only the body.
      expect(received?.contentType).toContain("text/plain")
    } finally {
      await stop()
    }
  })
})
