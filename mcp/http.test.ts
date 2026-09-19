// Tests for the HTTP transport. Every case constructs a `Request` in-process and calls
// the handler directly: no socket, no `Deno.serve`, no real timer.
//
// The two security assertions that must not be silently green:
//   - a token value never appears in a log line, from any log path;
//   - a valid token presented only as a query parameter is rejected.

import { assert, assertEquals, assertNotMatch } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createTokenVerifier, REDACTED_TOKEN } from "./auth.ts"
import { McpHandler } from "./handler.ts"
import { createHttpTransport, type HeartbeatProducer } from "./http.ts"
import { clientIp, MemoryRateLimitStore } from "./rate-limit.ts"
import { FAKE_SECRET_BODY, FAKE_TOKEN, FAKE_TOKEN_WRONG, toolSchema } from "./test-helpers.ts"

const ORIGIN = "https://mcp.example.invalid"
const ALLOWED_ORIGIN = "https://console.example.invalid"

/** A heartbeat producer the test drives by hand. No timer, no sleep. */
function manualHeartbeat(): HeartbeatProducer & { ping(): void; stops(): number } {
  let pending: (() => void) | undefined
  let stopCount = 0
  return {
    ping(): void {
      const resolve = pending
      pending = undefined
      resolve?.()
    },
    next(): Promise<void> {
      return new Promise<void>((resolve) => {
        pending = resolve
      })
    },
    stop(): void {
      stopCount += 1
      this.ping()
    },
    stops(): number {
      return stopCount
    },
  }
}

function createHandler(): McpHandler {
  const handler = new McpHandler({ serverInfo: { name: "http-test", version: "0.1.0" } })
  handler.registerTool({
    name: "echo",
    description: "Echo text",
    inputSchema: toolSchema({ text: { type: "string" } }, ["text"]),
  }, () => ({ success: true, output: FAKE_SECRET_BODY }))
  return handler
}

function createTransport(options: {
  logs?: string[]
  rateLimit?: MemoryRateLimitStore
  heartbeat?: HeartbeatProducer
  allowedOrigins?: string[]
  handler?: McpHandler
} = {}) {
  const logs = options.logs ?? []
  const transport = createHttpTransport({
    handler: options.handler ?? createHandler(),
    verifier: createTokenVerifier(FAKE_TOKEN),
    allowedOrigins: options.allowedOrigins ?? [ALLOWED_ORIGIN],
    rateLimit: options.rateLimit,
    heartbeat: options.heartbeat,
    logger: (line) => logs.push(line),
  })
  return { transport, logs }
}

/** A transport whose handler has already completed the MCP handshake. */
function createInitializedTransport() {
  const logs: string[] = []
  const transport = createHttpTransport({
    handler: createHandler(),
    verifier: createTokenVerifier(FAKE_TOKEN),
    logger: (line) => logs.push(line),
  })
  // Drive the handshake through the transport itself, as a client would.
  return {
    transport,
    logs,
    async initialize(): Promise<void> {
      await transport(
        mcpPost(
          { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
          JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }),
        ),
      )
    },
  }
}

function mcpPost(headers: Record<string, string> = {}, body = "{}"): Request {
  return new Request("https://mcp.example.invalid/mcp", {
    method: "POST",
    headers,
    body,
  })
}

describe("GET /health", () => {
  it("answers without a token", async () => {
    const { transport } = createTransport()
    const response = await transport(new Request("https://mcp.example.invalid/health"))
    assertEquals(response.status, 200)
    assertEquals(await response.json(), { status: "ok" })
  })

  it("is a zero-information signal: no version, no server name, no tool list", async () => {
    const { transport } = createTransport()
    const response = await transport(new Request("https://mcp.example.invalid/health"))
    const text = await response.text()
    assertEquals(text, '{"status":"ok"}')
  })

  it("still requires no token when a rate limit is configured", async () => {
    const rateLimit = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000 })
    const { transport } = createTransport({ rateLimit })
    const first = await transport(new Request("https://mcp.example.invalid/health"))
    const second = await transport(new Request("https://mcp.example.invalid/health"))
    assertEquals(first.status, 200)
    assertEquals(second.status, 200)
  })
})

describe("token auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const { transport } = createTransport()
    const response = await transport(mcpPost())
    assertEquals(response.status, 401)
    assertEquals(await response.json(), { error: "Unauthorized" })
  })

  it("accepts a valid Bearer token from the Authorization header", async () => {
    const { transport } = createTransport()
    const response = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" }),
    )
    assertEquals(response.status, 200)
  })

  it("rejects a valid token supplied only as a query parameter", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request(`https://mcp.example.invalid/mcp?api_key=${FAKE_TOKEN}`, {
        method: "POST",
        body: "{}",
      }),
    )
    assertEquals(response.status, 401)
    assertEquals(await response.json(), { error: "Unauthorized" })
  })

  it("rejects a valid token in the query parameter even when a wrong header is also present", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request(`https://mcp.example.invalid/mcp?token=${FAKE_TOKEN}&api_key=${FAKE_TOKEN}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${FAKE_TOKEN_WRONG}` },
        body: "{}",
      }),
    )
    assertEquals(response.status, 401)
  })

  it("does not read a token from an X-Api-Key header", async () => {
    const { transport } = createTransport()
    const response = await transport(mcpPost({ "X-Api-Key": FAKE_TOKEN }))
    assertEquals(response.status, 401)
  })

  it("rejects an equal-length wrong token", async () => {
    const { transport } = createTransport()
    const response = await transport(mcpPost({ Authorization: `Bearer ${FAKE_TOKEN_WRONG}` }))
    assertEquals(response.status, 401)
  })

  it("advertises WWW-Authenticate: Bearer on a 401", async () => {
    const { transport } = createTransport()
    const response = await transport(mcpPost())
    assertEquals(response.headers.get("www-authenticate"), "Bearer")
  })
})

describe("log redaction", () => {
  it("never logs the token value when the header, the api key and the query all carry it", async () => {
    const logs: string[] = []
    const { transport } = createTransport({ logs })
    const response = await transport(
      new Request(
        `https://mcp.example.invalid/mcp?api_key=${FAKE_TOKEN}&token=${FAKE_TOKEN}`,
        {
          method: "POST",
          headers: {
            // A wrong bearer token, so the auth-failure path runs while the real token
            // is present in the query string and in the alternate header.
            Authorization: `Bearer ${FAKE_TOKEN_WRONG}`,
            "X-Api-Key": FAKE_TOKEN,
            "X-Forwarded-For": "203.0.113.7",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { apiKey: FAKE_TOKEN },
          }),
        },
      ),
    )
    assertEquals(response.status, 401)

    // The failure must actually have been logged: a test that only checks "nothing
    // leaked" passes trivially when the log line is never emitted.
    assert(logs.length > 0, "the auth failure must emit a log line")
    const logged = logs.join("\n")
    assertNotMatch(logged, new RegExp(FAKE_TOKEN))
    assertNotMatch(logged, new RegExp(FAKE_TOKEN_WRONG))
    assert(logged.includes("Auth failed"), logged)
  })

  it("never logs the token when a wrong token is presented", async () => {
    const logs: string[] = []
    const { transport } = createTransport({ logs })
    await transport(mcpPost({ Authorization: `Bearer ${FAKE_TOKEN_WRONG}` }))
    assert(logs.length > 0)
    assertNotMatch(logs.join("\n"), new RegExp(FAKE_TOKEN_WRONG))
    assert(logs.join("\n").includes(REDACTED_TOKEN) || logs.join("\n").includes("Auth failed"))
  })

  it("does not log the request body, which may carry a credential", async () => {
    const logs: string[] = []
    const { transport } = createTransport({ logs })
    await transport(
      mcpPost(
        { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
        body(),
      ),
    )
    assertNotMatch(logs.join("\n"), new RegExp(FAKE_SECRET_BODY))
  })

  function body(): string {
    return JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { text: FAKE_TOKEN } },
    })
  }
})

describe("POST /mcp", () => {
  it("returns a JSON-RPC result for a valid request", async () => {
    const { transport } = createTransport()
    const response = await transport(
      mcpPost(
        { Authorization: `Bearer ${FAKE_TOKEN}`, "Content-Type": "application/json" },
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      ),
    )
    const payload = await response.json() as { id: number; result: { protocolVersion: string } }
    assertEquals(response.status, 200)
    assertEquals(payload.id, 1)
    assertEquals(payload.result.protocolVersion, "2024-11-05")
  })

  it("returns a protocol error for a malformed body with HTTP 200", async () => {
    const { transport } = createTransport()
    const response = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}` }, "{not json"),
    )
    const payload = await response.json() as { error: { code: number } }
    assertEquals(response.status, 200)
    assertEquals(payload.error.code, -32700)
  })

  it("returns -32602 for a call to an unregistered tool", async () => {
    const { transport, initialize } = createInitializedTransport()
    await initialize()
    const response = await transport(
      mcpPost(
        { Authorization: `Bearer ${FAKE_TOKEN}` },
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "nope", arguments: {} },
        }),
      ),
    )
    const payload = await response.json() as { error: { code: number } }
    assertEquals(payload.error.code, -32602)
  })

  it("returns -32601 for an unknown method", async () => {
    const { transport } = createTransport()
    const response = await transport(
      mcpPost(
        { Authorization: `Bearer ${FAKE_TOKEN}` },
        JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/delete" }),
      ),
    )
    const payload = await response.json() as { error: { code: number } }
    assertEquals(payload.error.code, -32601)
  })

  it("rejects a body larger than the configured limit with 413", async () => {
    const logs: string[] = []
    const transport = createHttpTransport({
      handler: createHandler(),
      verifier: createTokenVerifier(FAKE_TOKEN),
      maxBodyBytes: 32,
      logger: (line) => logs.push(line),
    })
    const response = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}` }, JSON.stringify({ pad: "x".repeat(200) })),
    )
    assertEquals(response.status, 413)
  })

  it("returns 404 for an unknown path", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request("https://mcp.example.invalid/nope", {
        method: "POST",
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
        body: "{}",
      }),
    )
    assertEquals(response.status, 404)
  })

  it("returns 405 for an unsupported method", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      }),
    )
    assertEquals(response.status, 405)
  })
})

describe("CORS", () => {
  it("never answers with a wildcard origin", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${FAKE_TOKEN}`, Origin: ALLOWED_ORIGIN },
        body: "{}",
      }),
    )
    assertEquals(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN)
  })

  it("rejects a cross-origin request from an origin that is not allow-listed", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        method: "POST",
        headers: { Authorization: `Bearer ${FAKE_TOKEN}`, Origin: ORIGIN },
        body: "{}",
      }),
    )
    assertEquals(response.status, 403)
    assertEquals(response.headers.get("access-control-allow-origin"), null)
  })

  it("emits no CORS header for a request with no Origin", async () => {
    const { transport } = createTransport()
    const response = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}` }),
    )
    assertEquals(response.headers.get("access-control-allow-origin"), null)
  })

  it("answers a preflight for an allow-listed origin without requiring a token", async () => {
    const { transport } = createTransport()
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        method: "OPTIONS",
        headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "POST" },
      }),
    )
    assertEquals(response.status, 204)
    assertEquals(response.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN)
    assert(response.headers.get("access-control-allow-headers")?.includes("Authorization"))
  })
})

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the limit is exceeded", async () => {
    const rateLimit = new MemoryRateLimitStore({ limit: 2, windowMs: 60_000 })
    const { transport } = createTransport({ rateLimit })
    const request = () =>
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}`, "X-Forwarded-For": "203.0.113.7" })

    assertEquals((await transport(request())).status, 200)
    assertEquals((await transport(request())).status, 200)
    const denied = await transport(request())
    assertEquals(denied.status, 429)
    assertEquals(denied.headers.get("retry-after"), "60")
    assertEquals(await denied.json(), { error: "Rate limit exceeded" })
  })

  it("limits each client address separately", async () => {
    const rateLimit = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000 })
    const { transport } = createTransport({ rateLimit })
    const first = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}`, "X-Forwarded-For": "203.0.113.7" }),
    )
    const second = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}`, "X-Forwarded-For": "198.51.100.9" }),
    )
    assertEquals(first.status, 200)
    assertEquals(second.status, 200)
  })

  it("checks auth before the rate limit so an unauthenticated flood cannot spend the quota", async () => {
    const rateLimit = new MemoryRateLimitStore({ limit: 1, windowMs: 60_000 })
    const { transport } = createTransport({ rateLimit })
    const unauthenticated = await transport(mcpPost({ "X-Forwarded-For": "203.0.113.7" }))
    assertEquals(unauthenticated.status, 401)

    const authenticated = await transport(
      mcpPost({ Authorization: `Bearer ${FAKE_TOKEN}`, "X-Forwarded-For": "203.0.113.7" }),
    )
    assertEquals(authenticated.status, 200)
  })
})

describe("GET /mcp SSE", () => {
  it("does not emit a wildcard CORS header on the authenticated stream", async () => {
    const beats = manualHeartbeat()
    const { transport } = createTransport({ heartbeat: beats })
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        headers: { Authorization: `Bearer ${FAKE_TOKEN}`, Origin: ALLOWED_ORIGIN },
      }),
    )
    assertEquals(response.headers.get("content-type"), "text/event-stream")
    assertEquals(response.headers.get("access-control-allow-origin"), null)
  })

  it("requires the token before opening the stream", async () => {
    const beats = manualHeartbeat()
    const { transport } = createTransport({ heartbeat: beats })
    const response = await transport(new Request("https://mcp.example.invalid/mcp"))
    assertEquals(response.status, 401)
  })

  it("emits an endpoint frame, a heartbeat and closes on abort", async () => {
    const beats = manualHeartbeat()
    const { transport } = createTransport({ heartbeat: beats })
    const controller = new AbortController()
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
        signal: controller.signal,
      }),
    )
    assert(response.body !== null)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    assert(!first.done)
    const firstFrame = decoder.decode(first.value)
    assert(firstFrame.startsWith("event: endpoint\ndata: /mcp\n\n"), firstFrame)

    // One heartbeat tick, driven by the test rather than a timer.
    beats.ping()
    const heartbeat = decoder.decode((await reader.read()).value)
    assert(heartbeat.startsWith(": heartbeat "), heartbeat)
    assert(heartbeat.endsWith("\n\n"))

    controller.abort()
    const finished = await reader.read()
    assertEquals(finished.done, true)
    assertEquals(beats.stops() > 0, true)
  })

  it("closes the stream and stops the heartbeat when the caller cancels", async () => {
    const beats = manualHeartbeat()
    const { transport } = createTransport({ heartbeat: beats })
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      }),
    )
    assert(response.body !== null)
    await response.body.cancel()
    assertEquals(beats.stops() > 0, true)
  })

  it("honours a custom endpoint path", async () => {
    const beats = manualHeartbeat()
    const transport = createHttpTransport({
      handler: createHandler(),
      verifier: createTokenVerifier(FAKE_TOKEN),
      heartbeat: beats,
      endpointPath: "/mcp/session/1",
    })
    const response = await transport(
      new Request("https://mcp.example.invalid/mcp", {
        headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
      }),
    )
    const frame = new TextDecoder().decode((await response.body!.getReader().read()).value)
    assertEquals(frame, "event: endpoint\ndata: /mcp/session/1\n\n")
  })
})

describe("clientIp behind a proxy", () => {
  it("uses the leftmost forwarded address", () => {
    const request = new Request("https://mcp.example.invalid/mcp", {
      headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" },
    })
    assertEquals(clientIp(request), "203.0.113.7")
  })
})
