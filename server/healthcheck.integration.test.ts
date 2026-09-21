/**
 * The healthcheck probe against a real TCP listener (#58).
 *
 * `healthcheck.test.ts` drives `probeLoopback` with an injected `ProbeConnector`,
 * which proves the decision logic but never opens a socket. This file starts a
 * real `Deno.serve` on `127.0.0.1` with an ephemeral port and runs the probe
 * with its default `denoConnector` against it, and against a port nothing is
 * listening on any more, so the loopback code path itself — not just the
 * injected double — is exercised. No container is needed: the tier's unscoped
 * `--allow-net` covers loopback the same way `net/safe-fetch.integration.test.ts`
 * relies on it.
 */

import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { probeLoopback } from "./healthcheck.ts"

/** Start a real HTTP server on loopback with an ephemeral port and return it. */
function startServer(): { port: number; close: () => Promise<void> } {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    () => new Response("ok"),
  )
  const addr = server.addr
  const port = "port" in addr ? addr.port : 0
  return { port, close: () => server.shutdown() }
}

describe("probeLoopback against a real socket", () => {
  it("reports a real, running web server as healthy", async () => {
    const server = startServer()
    try {
      assertEquals(await probeLoopback({ port: server.port }), { healthy: true })
    } finally {
      await server.close()
    }
  })

  it("reports connect_failed for a port nothing is listening on", async () => {
    // Bind an ephemeral port, then release it: on loopback, connecting to a port
    // nothing listens on is refused immediately, which is the shape a healthcheck
    // sees when the app it probes has not started yet or has already exited.
    const server = startServer()
    const port = server.port
    await server.close()

    assertEquals(await probeLoopback({ port }), { healthy: false, reason: "connect_failed" })
  })
})
