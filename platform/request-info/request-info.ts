/**
 * `RequestInfo` — the request metadata worth attaching to a log line or an error report — and the
 * Hono helper that builds one.
 *
 * Moved from `template/apps/api/services/request-info.ts` and
 * `template/libs/platform/types/+index.ts`, with two bugs fixed at extraction time.
 *
 * **Bug 1: an unconditionally trusted `X-Forwarded-For`.** The source read `X-Forwarded-For` (and
 * `X-Real-IP`) straight off the request, so any client could set its own `X-Forwarded-For` and have
 * that string logged as its IP — useful for framing another address in an abuse report, or for
 * defeating anything downstream that keys on this value. Here the header is read through
 * {@link clientIp} (`platform/rate-limit/client-ip.ts`), which already carries this exact trust
 * boundary for the rate limiter: with `trustedProxy` false (the default here, same as there) only
 * the transport's own peer address is used; a forwarding header is consulted only when the caller
 * opts in, which is correct only behind a proxy that overwrites it.
 *
 * **Bug 2 (a coupling, not a runtime bug): importing the app's `APIContext`.** The source's Hono
 * parameter was typed `Context<APIContext>`, an app-specific type a library cannot import. This
 * takes a plain Hono `Context`, generic over the caller's own `Env`, matching how
 * `platform/rate-limit/hono.ts` stays app-agnostic.
 *
 * **Where the peer address comes from.** `clientIp` wants the transport's peer address as a
 * fallback for when no forwarding header is trusted or present, but Hono has no adapter-agnostic
 * way to read it — `platform/rate-limit/hono.ts` solves this by taking a `remoteAddr` resolver as
 * *its* caller's own runtime-specific accessor (e.g. `hono/deno`'s `getConnInfo`), rather than
 * reaching into `c.env` itself. This module does the same, but as a resolved value instead of a
 * resolver function: `requestInfoFromContext` is called once per request, not built once as
 * middleware, so the caller resolves the address inline and passes the string through
 * {@link RequestInfoOptions.remoteAddr}. `ip` stays unset when no trusted forwarding header and no
 * `remoteAddr` identify the client, as in the source — `clientIp`'s own placeholder
 * (`UNKNOWN_CLIENT_IP`, `"0.0.0.0"`) is a made-up address, not a real one, and the source's own
 * `apps/api/features/groups/errors.ts` writes `request.ip || null` into an audit row, so a
 * placeholder string would be logged as though it were the client's real address instead of as
 * "unknown". Same reasoning for `userAgent`: an empty header value is treated the same as a
 * missing one (`|| undefined`, matching the source), not kept as `""`.
 */
import type { Context, Env } from "hono"

import { clientIp, type TrustedProxyHeader, UNKNOWN_CLIENT_IP } from "../rate-limit/client-ip.ts"

/** Request metadata worth attaching to a log line or an error report. */
export interface RequestInfo {
  requestId?: string
  ip?: string
  userAgent?: string
}

/** Options for {@link requestInfoFromContext}. */
export interface RequestInfoOptions {
  /**
   * Trust `CF-Connecting-IP` / `X-Forwarded-For` / `X-Real-IP`. Defaults to **false**: with no
   * proxy in front, trusting a forwarding header lets a client claim any address it likes. Set it
   * to `true` only behind a proxy that strips and rewrites all three headers itself, or to a single
   * {@link TrustedProxyHeader} behind one that rewrites only that header — for example
   * `"x-real-ip"` behind Traefik's default settings, which pass `CF-Connecting-IP` through
   * unrewritten. That default-settings case only: with `forwardedHeaders.trustedIPs` configured
   * (e.g. Cloudflare in front of Traefik), Traefik keeps the trusted upstream's `X-Real-IP` instead
   * of overwriting it, so a client-forged value can pass through — trust `"cf-connecting-ip"` in
   * that layout instead. See `rate-limit/client-ip.ts`'s module doc for the full trust boundary.
   */
  trustedProxy?: boolean | TrustedProxyHeader
  /**
   * The connection's peer address, resolved by the caller from whatever its own runtime exposes
   * (see the module doc for why this module does not read it from `c` itself). Used by
   * {@link clientIp} when no trusted forwarding header applies.
   */
  remoteAddr?: string
}

/**
 * Read a Hono context variable defensively, without requiring the caller's `Env` to declare it.
 *
 * `server/request-log` (`platform/`'s sibling package) sets no context variable at all, so there
 * is no established name to import a type for — and `platform/` does not depend on `server/`
 * anyway. `"requestId"` is read because it is the name Hono's own `hono/request-id` middleware
 * sets, which is the common case a caller wiring this up already has running.
 */
function readRequestId<E extends Env>(c: Context<E>): string | undefined {
  const value = c.get?.("requestId" as never) as unknown
  return typeof value === "string" ? value : undefined
}

/**
 * Build a {@link RequestInfo} from a Hono request: its request id (when the app's middleware set
 * one), its client IP (see the module doc for the trust boundary), and its user agent.
 */
export function requestInfoFromContext<E extends Env = Record<string, never>>(
  c: Context<E>,
  options: RequestInfoOptions = {},
): RequestInfo {
  const trustedProxy = options.trustedProxy ?? false
  const ip = clientIp(c.req.raw, options.remoteAddr, trustedProxy)
  return {
    requestId: readRequestId(c),
    ip: ip === UNKNOWN_CLIENT_IP ? undefined : ip,
    userAgent: c.req.header("user-agent") || undefined,
  }
}
