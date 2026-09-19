// ── HTTP transport ──
// Web-standard `Request` → `Response` handler: `Deno.serve` calls it in production,
// tests call it in-process with constructed `Request` objects. Nothing here touches
// the network, the filesystem or the clock.
//
// Routes:
//   GET  /health  — unauthenticated liveness only, zero information
//   POST /mcp     — JSON-RPC (also the CORS preflight target)
//   GET  /mcp     — SSE stream with heartbeats
//
// The token is read from the `Authorization` header and nowhere else. `?api_key=`
// acceptance is gone: query strings land in proxy and access logs.

import { bearerTokenFromHeaders, formatLogLine, type TokenVerifier } from "./auth.ts"
import type { McpHandler } from "./handler.ts"
import { clientIp, type RateLimitStore, retryAfterSeconds } from "./rate-limit.ts"
import { jsonRpcError, JsonRpcErrorCode } from "./jsonrpc.ts"

/** Emits one already-redacted log line. */
export type HttpLogger = (line: string) => void

/** HTTP transport configuration. */
export interface HttpTransportOptions {
  /** The MCP handler serving `POST /mcp`. */
  handler: McpHandler
  /**
   * Token verifier. When omitted the transport serves unauthenticated — the caller has
   * to say why at the call site.
   */
  verifier?: TokenVerifier
  /**
   * Exact origins allowed to call this server from a browser. Empty by default, which
   * forbids every cross-origin request. There is no `"*"` mode: a wildcard on an
   * endpoint that takes a bearer credential lets any page the operator visits spend
   * that credential.
   */
  allowedOrigins?: readonly string[]
  /** Rate limit. Defaults to none; production wiring passes a bounded store. */
  rateLimit?: RateLimitStore
  /** Reject a larger request body with 413. Defaults to 1 MiB. */
  maxBodyBytes?: number
  /** Path the SSE `endpoint` event points at. Defaults to `/mcp`. */
  endpointPath?: string
  /**
   * Heartbeat producer for the SSE stream. Called repeatedly while the stream is open;
   * each call emits one comment frame. Defaults to a 15 s timer. Tests inject a
   * controllable producer, which is why this is a port and not a bare interval.
   */
  heartbeat?: HeartbeatProducer
  /** Log sink. Lines are redacted before they reach it. */
  logger?: HttpLogger
}

/** Produces SSE heartbeats until stopped. */
export interface HeartbeatProducer {
  /** Resolves on each heartbeat tick; never rejects. */
  next(): Promise<void>
  /** Stop producing heartbeats and let the SSE loop finish. */
  stop(): void
}

/** Default body limit: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576

/** Default heartbeat interval in milliseconds. */
export const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * Build the transport. The returned function is pure request-in / response-out and can
 * be handed to `Deno.serve` unchanged.
 */
export function createHttpTransport(
  options: HttpTransportOptions,
): (request: Request) => Promise<Response> {
  const allowedOrigins = options.allowedOrigins ?? []
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const endpointPath = options.endpointPath ?? "/mcp"
  const log = options.logger ?? ((line: string) => console.error(line))

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const origin = request.headers.get("origin")

    if (origin !== null && origin.length > 0 && !allowedOrigins.includes(origin)) {
      log(formatLogLine("warn", `Rejected cross-origin request from ${origin}`, []))
      return jsonResponse({ error: "Forbidden" }, 403, origin, allowedOrigins)
    }

    if (url.pathname === "/health") {
      // Zero-information liveness: no version, no uptime, no tool list.
      return jsonResponse({ status: "ok" }, 200, origin, allowedOrigins)
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowedOrigins, true) })
    }

    if (request.method !== "POST" && request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405, origin, allowedOrigins)
    }

    const verifier = options.verifier
    if (verifier) {
      const token = bearerTokenFromHeaders(request.headers)
      const verified = token === undefined ? false : await verifier.verify(token)
      if (!verified) {
        // The presented value is never logged, here or anywhere else. `formatLogLine`
        // redacts it defensively in case a future edit interpolates it.
        log(
          formatLogLine(
            "warn",
            `Auth failed for ${clientIp(request)} on ${request.method} ${url.pathname}`,
            [token],
          ),
        )
        return jsonResponse({ error: "Unauthorized" }, 401, origin, allowedOrigins, {
          "WWW-Authenticate": "Bearer",
        })
      }
    }

    if (options.rateLimit) {
      const client = clientIp(request)
      const result = options.rateLimit.check(client)
      if (!result.allowed) {
        log(formatLogLine("warn", `Rate limit exceeded for ${client} on ${url.pathname}`, []))
        return jsonResponse({ error: "Rate limit exceeded" }, 429, origin, allowedOrigins, {
          "Retry-After": retryAfterSeconds(result.retryAfterMs),
        })
      }
    }

    if (url.pathname !== "/mcp") {
      return jsonResponse({ error: "Not found" }, 404, origin, allowedOrigins)
    }

    if (request.method === "GET") {
      return sseResponse(request, options.heartbeat ?? intervalHeartbeat(), endpointPath)
    }

    return await postResponse(request, options.handler, maxBodyBytes, origin, allowedOrigins)
  }
}

async function postResponse(
  request: Request,
  handler: McpHandler,
  maxBodyBytes: number,
  origin: string | null,
  allowedOrigins: readonly string[],
): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? "")
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return jsonResponse({ error: "Payload too large" }, 413, origin, allowedOrigins)
  }

  let body: string
  try {
    body = await request.text()
  } catch {
    return jsonResponse(
      jsonRpcError(null, JsonRpcErrorCode.ParseError) as unknown as Record<string, unknown>,
      400,
      origin,
      allowedOrigins,
    )
  }

  if (new TextEncoder().encode(body).byteLength > maxBodyBytes) {
    return jsonResponse({ error: "Payload too large" }, 413, origin, allowedOrigins)
  }

  // A JSON-RPC error is a protocol-level result, so the HTTP status stays 200; only a
  // body that could not be read at all is a 4xx.
  const response = await handler.handleMessage(body)
  return jsonResponse(response as unknown as Record<string, unknown>, 200, origin, allowedOrigins)
}

/**
 * SSE stream. Emits the `endpoint` frame, then heartbeats until the caller aborts. The
 * stream closes on `request.signal`, when the heartbeat producer stops, or on a write
 * failure — it does not hang open. No CORS header is emitted: this function is only
 * reached after the origin check in `createHttpTransport` passed.
 */
export function sseResponse(
  request: Request,
  heartbeat: HeartbeatProducer,
  endpointPath: string,
): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        heartbeat.stop()
        try {
          controller.close()
        } catch {
          // Already closed by the client.
        }
      }
      const write = (frame: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(frame))
          return true
        } catch {
          close()
          return false
        }
      }

      request.signal.addEventListener("abort", close, { once: true })

      if (!write(`event: endpoint\ndata: ${endpointPath}\n\n`)) return
      if (request.signal.aborted) {
        close()
        return
      }

      while (!request.signal.aborted && !closed) {
        await heartbeat.next()
        if (request.signal.aborted || closed) break
        // A comment frame is a valid heartbeat and cannot be mistaken for a message.
        if (!write(`: heartbeat ${Date.now()}\n\n`)) break
      }

      close()
    },
    cancel() {
      heartbeat.stop()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      // Keeps a reverse proxy from buffering the stream.
      "X-Accel-Buffering": "no",
    },
  })
}

/** Timer-based heartbeat used in production. Tests inject their own producer. */
export function intervalHeartbeat(intervalMs: number = DEFAULT_HEARTBEAT_MS): HeartbeatProducer {
  let stopped = false
  let timer: number | undefined

  return {
    next(): Promise<void> {
      if (stopped) return new Promise<void>(() => {})
      return new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timer = undefined
          resolve()
        }, intervalMs)
      })
    },
    stop(): void {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

function corsHeaders(
  origin: string | null,
  allowedOrigins: readonly string[],
  preflight: boolean,
): Headers {
  const headers = new Headers()
  if (origin === null || !allowedOrigins.includes(origin)) return headers

  headers.set("Access-Control-Allow-Origin", origin)
  headers.set("Vary", "Origin")
  if (preflight) {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type")
    headers.set("Access-Control-Max-Age", "600")
  }
  return headers
}

function jsonResponse(
  payload: unknown,
  status: number,
  origin: string | null,
  allowedOrigins: readonly string[],
  extra: Record<string, string> = {},
): Response {
  const headers = corsHeaders(origin, allowedOrigins, false)
  headers.set("Content-Type", "application/json")
  for (const [key, value] of Object.entries(extra)) headers.set(key, value)
  return new Response(JSON.stringify(payload), { status, headers })
}
