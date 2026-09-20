/**
 * Integration tier (#74): `NtfyClient` against a real HTTP server.
 *
 * `ntfy.test.ts` replaces `fetch` with a fake that resolves synchronously, so the
 * timeout and retry behaviour has only ever run against instantaneous, in-process
 * responses — a fake cannot prove a hanging server is actually bounded. This file
 * starts a real listener on `127.0.0.1` with `Deno.serve({ port: 0 })` — an
 * ephemeral loopback port, no container, nothing reachable outside loopback — and
 * drives the client's real `fetch` calls against it.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { NotificationSeverity, NtfyClient } from "./ntfy.ts"

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

describe("NtfyClient against a real server", () => {
  it("fails with a timeout error inside the budget when the server never answers", async () => {
    const { baseUrl, stop } = startServer(() => new Promise<Response>(() => {}))
    try {
      const client = new NtfyClient(
        { baseUrl, topic: "it-never-answers" },
        { requestTimeoutMs: 300, retry: { maxAttempts: 1, totalBudgetMs: 2000 } },
      )
      const startedAt = performance.now()
      const result = await client.push({
        title: "integration",
        message: "never answers",
        severity: NotificationSeverity.Failure,
      })
      const elapsedMs = performance.now() - startedAt
      expect(result.ok).toBe(false)
      expect(result.ok === false && result.code).toBe("timeout")
      // A generous upper bound, not a tight wall-clock assertion: the point is
      // that the call returned at all instead of hanging forever.
      expect(elapsedMs).toBeLessThan(5000)
    } finally {
      await stop()
    }
  })

  it("retries past two transient failures and succeeds, sending the expected request", async () => {
    let requestCount = 0
    let received:
      | { method: string; path: string; auth: string | null; title: string | null; body: string }
      | undefined
    const { baseUrl, stop } = startServer(async (request) => {
      requestCount++
      if (requestCount < 3) {
        return new Response("try again", { status: 503 })
      }
      received = {
        method: request.method,
        path: new URL(request.url).pathname,
        auth: request.headers.get("Authorization"),
        title: request.headers.get("Title"),
        body: await request.text(),
      }
      return new Response("", { status: 200 })
    })
    try {
      const client = new NtfyClient(
        { baseUrl, topic: "it-topic", token: "it-token-not-real" },
        { retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, totalBudgetMs: 5000 } },
      )
      const result = await client.push({
        title: "integration push",
        message: "third time lucky",
        severity: NotificationSeverity.Failure,
      })
      expect(result.ok).toBe(true)
      expect(result.ok && result.status === "pushed" && result.attempts).toBe(3)
      expect(requestCount).toBe(3)
      expect(received).toEqual({
        method: "POST",
        path: "/it-topic",
        auth: "Bearer it-token-not-real",
        title: "integration push",
        body: "third time lucky",
      })
    } finally {
      await stop()
    }
  })
})
