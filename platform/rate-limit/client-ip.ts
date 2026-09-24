/**
 * Client IP extraction from the transport peer address and optional proxy headers.
 *
 * With `trustedProxy: false` (the default) only `remoteAddr` is consulted, so the returned value is
 * the address of whoever actually opened the connection — unspoofable. With `trustedProxy: true`
 * the order is the one `mig/lib/ratelimit.ts` used: `CF-Connecting-IP`, then the first
 * `X-Forwarded-For` hop, then `X-Real-IP`, then `remoteAddr`. Passing one {@link TrustedProxyHeader}
 * instead of `true` reads only that header — the other two are ignored even when present.
 *
 * **Trust boundary:** all three headers are client-controlled unless a reverse proxy strips and
 * rewrites them, and *which* headers a given proxy rewrites is proxy-specific — `trustedProxy: true`
 * trusts all three, which is wrong for a proxy that only rewrites some of them. Traefik, with
 * default settings (an empty `forwardedHeaders.trustedIPs`), overwrites `X-Forwarded-For` and
 * `X-Real-IP` but passes `CF-Connecting-IP` through verbatim: a client behind Traefik can set
 * `CF-Connecting-IP` to anything it likes, and `trustedProxy: true` would read that forged value
 * first. Behind Traefik, set `trustedProxy: "x-real-ip"` (or `"x-forwarded-for"`) instead, so
 * `CF-Connecting-IP` is never consulted — **but only with `trustedIPs` empty.** Configuring
 * `forwardedHeaders.trustedIPs` (the Cloudflare → Traefik layout) makes Traefik keep that upstream's
 * `X-Real-IP` instead of overwriting it, so a client-forged value passes through just as
 * `CF-Connecting-IP` does with no `trustedIPs` set; trust `"cf-connecting-ip"` in that layout
 * instead. See `rate-limit/README.md`'s trust-boundary section for the full `trustedIPs` caveat.
 * Behind Cloudflare directly, which sets `CF-Connecting-IP` itself, `trustedProxy:
 * "cf-connecting-ip"` is the narrow equivalent of `true`. With no proxy in front and any header
 * trusted, a caller rotating that header produces a new bucket per request and the limiter is
 * defeated.
 */

/** Fallback when no header and no peer address is available. */
export const UNKNOWN_CLIENT_IP = "0.0.0.0"

const CONNECTING_IP = "cf-connecting-ip"
const FORWARDED_FOR = "x-forwarded-for"
const REAL_IP = "x-real-ip"

/**
 * A single proxy header {@link clientIp} may be told to trust, in place of the default
 * all-three-headers order. Name the one header the proxy in front actually rewrites — see the
 * module doc's Traefik and Cloudflare examples.
 */
export type TrustedProxyHeader = "cf-connecting-ip" | "x-forwarded-for" | "x-real-ip"

/** First hop of a comma-separated header value, or `undefined` when it is empty. */
function firstHop(value: string | null): string | undefined {
  if (value === null) return undefined
  const hop = value.split(",")[0]?.trim() ?? ""
  return hop === "" ? undefined : hop
}

/**
 * Resolve the client IP for a request.
 *
 * `trustedProxy: true` order: `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` >
 * `remoteAddr`. A {@link TrustedProxyHeader} instead of `true` reads only that one header, first
 * hop, then falls back to `remoteAddr` — the other two headers are never consulted. Either way,
 * `X-Forwarded-For` is read hop by hop, never as a whole string — a list is
 * `<client>, <proxy>, ...`, so the first hop is the client and the remaining hops are proxy-chain
 * noise. An empty or whitespace-only header falls through to the next source; a malformed value is
 * returned verbatim rather than guessed at, because a limiter must bucket two requests claiming the
 * same address together instead of scattering them into fresh buckets.
 *
 * @param req Request whose headers are inspected.
 * @param remoteAddr Peer address from the transport, when the runtime exposes one.
 * @param trustedProxy `false` (default): only `remoteAddr`. `true`: all three headers, in the order
 *   above. A {@link TrustedProxyHeader}: only that header.
 */
export function clientIp(
  req: Request,
  remoteAddr?: string,
  trustedProxy: boolean | TrustedProxyHeader = false,
): string {
  if (trustedProxy === true) {
    const cf = firstHop(req.headers.get(CONNECTING_IP))
    if (cf !== undefined) return cf

    const xff = firstHop(req.headers.get(FORWARDED_FOR))
    if (xff !== undefined) return xff

    const real = firstHop(req.headers.get(REAL_IP))
    if (real !== undefined) return real
  } else if (trustedProxy !== false) {
    const only = firstHop(req.headers.get(trustedProxy))
    if (only !== undefined) return only
  }

  const peer = remoteAddr?.trim()
  return peer === undefined || peer === "" ? UNKNOWN_CLIENT_IP : peer
}

/**
 * Milliseconds as a human retry hint: `"1 second"`, `"45 seconds"`, `"2 minutes"`.
 *
 * Deterministic and locale-free on purpose — routing this through `Intl` would make the string
 * depend on the host locale and turn its test into a coin flip. Rounds up, because rounding down
 * would tell a client to retry before the window actually has room.
 */
export function humanRetry(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  const seconds = Math.ceil(safe / 1000)
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? "" : "s"}`
}
