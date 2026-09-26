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
 *
 * A header value counts only when it is exactly one IP address: anything else (a port, a hostname, a
 * 64 KB string) is treated as if the header were absent. Every address that comes back is in one
 * canonical spelling, and an IPv4-mapped IPv6 address comes back as IPv4, so two spellings of one
 * client share a bucket. {@link ClientIpOptions.trustedProxies} narrows the trust further: the
 * header is read only when the connection came from one of the listed ranges.
 *
 * @module
 */

import { ipInRanges, normalizeIp, parseIp } from "@spy4x/net/ip"

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

/** Options for {@link clientIp}. */
export interface ClientIpOptions {
  /**
   * CIDR ranges of the proxies allowed to set the trusted header, for example Cloudflare's
   * published ranges. When given, the header is read only if the peer address lies inside one of
   * them; any other peer, or no peer address at all, gets its own address back. An empty list
   * trusts no one. A malformed range throws a `RangeError` on every call (see `ipInRanges` in
   * `@spy4x/net/ip`). Left out, the header is trusted from any peer, as before.
   */
  trustedProxies?: readonly string[]
}

/**
 * First hop of a comma-separated header value in its canonical spelling, or `undefined` when that
 * hop is empty or is not an IP address.
 */
function firstHop(value: string | null): string | undefined {
  if (value === null) return undefined
  const hop = value.split(",")[0]?.trim() ?? ""
  return normalizeIp(hop) ?? undefined
}

/**
 * Resolve the client IP for a request.
 *
 * `trustedProxy: true` order: `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` >
 * `remoteAddr`. A {@link TrustedProxyHeader} instead of `true` reads only that one header, first
 * hop, then falls back to `remoteAddr` — the other two headers are never consulted. Either way,
 * `X-Forwarded-For` is read hop by hop, never as a whole string — a list is
 * `<client>, <proxy>, ...`, so the first hop is the client and the remaining hops are proxy-chain
 * noise. A header whose first hop is empty or is not exactly one IP address counts as absent and
 * falls through to the next source, so a forged value can neither mint a bucket of its own nor
 * carry a port or a 64 KB string into the limiter's memory.
 *
 * The result is canonical (`normalizeIp` from `@spy4x/net/ip`): `::ffff:192.0.2.1` and `192.0.2.1`
 * are one client, and so are `2001:DB8::1` and `2001:db8::1`. A `remoteAddr` that is not an IP
 * address (a Unix socket path, say) is returned trimmed but otherwise as it came, because the
 * transport, not the client, wrote it.
 *
 * @param req Request whose headers are inspected.
 * @param remoteAddr Peer address from the transport, when the runtime exposes one.
 * @param trustedProxy `false` (default): only `remoteAddr`. `true`: all three headers, in the order
 *   above. A {@link TrustedProxyHeader}: only that header.
 * @param options `trustedProxies`: read the header only when `remoteAddr` is inside these ranges.
 */
export function clientIp(
  req: Request,
  remoteAddr?: string,
  trustedProxy: boolean | TrustedProxyHeader = false,
  options: ClientIpOptions = {},
): string {
  const trimmed = remoteAddr?.trim()
  const peer = trimmed === undefined || trimmed === ""
    ? undefined
    : (normalizeIp(trimmed) ?? trimmed)
  // Evaluated even when no header would be read, so a malformed range list fails on the first
  // request instead of waiting for the first proxied one.
  const fromTrustedPeer = options.trustedProxies === undefined ||
    ipInRanges(peer ?? "", options.trustedProxies)

  // A peer outside `trustedProxies` is not a listed proxy: whatever it wrote in a header is its own
  // claim, so no header is read.
  if (fromTrustedPeer && trustedProxy === true) {
    const cf = firstHop(req.headers.get(CONNECTING_IP))
    if (cf !== undefined) return cf

    const xff = firstHop(req.headers.get(FORWARDED_FOR))
    if (xff !== undefined) return xff

    const real = firstHop(req.headers.get(REAL_IP))
    if (real !== undefined) return real
  } else if (fromTrustedPeer && typeof trustedProxy === "string") {
    const only = firstHop(req.headers.get(trustedProxy))
    if (only !== undefined) return only
  }

  return peer ?? UNKNOWN_CLIENT_IP
}

/**
 * The rate-limit identity of a client address: an IPv6 address reduced to its /64 network
 * (`2001:db8:1:2::/64`), anything else unchanged.
 *
 * One ordinary IPv6 allocation — a household, a phone, a rented server — is a whole /64, 2^64
 * addresses the holder can pick from freely. Keyed per address, such a client rotates through them
 * and is never limited, and every rotated address becomes a stored bucket (#219). Keyed per /64, it
 * gets one budget, the same as one IPv4 client. IPv4 addresses, and values that are not an address
 * (the placeholder, a Unix socket path), come back as they are. An IPv4-mapped IPv6 address comes
 * back as its IPv4 address.
 */
export function clientIpBucket(ip: string): string {
  const parsed = parseIp(ip)
  if (parsed === null) return ip
  if (parsed.version === 4) return parsed.address
  const groups: string[] = []
  for (let i = 0; i < 8; i += 2) {
    groups.push(((parsed.bytes[i] << 8) | parsed.bytes[i + 1]).toString(16))
  }
  return `${normalizeIp(`${groups.join(":")}::`)}/64`
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
