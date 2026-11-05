/**
 * Client IP extraction from the transport peer address and optional proxy headers.
 *
 * With `trustedProxy: false` (the default) only `remoteAddr` is consulted, so the returned value is
 * the address of whoever actually opened the connection — unspoofable. With `trustedProxy: true`
 * the order is `CF-Connecting-IP`, then the first
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
 * instead. The trust-boundary section below has the full `trustedIPs` caveat.
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
 * **Only an address is accepted.** A trusted header's first hop counts only when it is exactly one IPv4
 * or IPv6 address; anything else (a port, brackets, a zone id, a hostname, a 64 KB string) is treated as
 * if the header were absent, so the next source is used and in the end the peer address. Every address
 * `clientIp` returns is in one canonical spelling from `normalizeIp` in `@spy4x/net/ip`: `2001:DB8::1`
 * and `2001:db8::1` are one client, and an IPv4-mapped `::ffff:192.0.2.1` is returned as `192.0.2.1`.
 * A forged header is never returned verbatim, so distinct spellings cannot become separate buckets.
 *
 * **Trusting a header only from known proxies.** The fourth parameter's `trustedProxies` lists CIDR
 * ranges. The header is then read only when the peer address lies inside one of them; any other
 * peer, and a request with no peer address, is keyed on its own address. An empty list trusts no one,
 * and a malformed range throws a `RangeError` on every call, so a typo shows up on the first request.
 * This is what makes `CF-Connecting-IP` safe on a server that is also reachable around Cloudflare:
 *
 * ```ts
 * import { clientIp } from "@spy4x/platform/rate-limit"
 *
 * const CLOUDFLARE = ["173.245.48.0/20", "104.16.0.0/13", "2400:cb00::/32"] // … and the rest of the full list
 *
 * // Traefik writes X-Real-IP (the address that connected to it); believe CF-Connecting-IP only when
 * // that address is a Cloudflare edge.
 * const peer = clientIp(req, socketAddress, "x-real-ip")
 * const ip = clientIp(req, peer, "cf-connecting-ip", { trustedProxies: CLOUDFLARE })
 * ```
 *
 * No provider's range list ships with this package: those lists change, so the caller keeps its own.
 * `userThenIp` takes the same `trustedProxies` option.
 *
 * **IPv6 clients are keyed on their /64.** One ordinary IPv6 allocation is a whole /64, 2^64 addresses
 * its holder can pick from, so a per-address key never limits it. `userThenIp` therefore keys an
 * IPv6 client as `ip:2001:db8:1:2::/64`; IPv4 keys are unchanged. `ipv6PerAddress: true` restores one
 * key per IPv6 address. Outside the middleware, `clientIpBucket(ip)` does the same reduction:
 *
 * ```ts
 * import { clientIp, clientIpBucket, rateLimitKey, RateLimitKind } from "@spy4x/platform/rate-limit"
 *
 * const key = rateLimitKey(RateLimitKind.Ip, clientIpBucket(clientIp(req, socketAddress)))
 * ```
 *
 * A budget a stranger must not multiply, such as sign-up codes sent to one address, can count a wider
 * network: a free tunnel broker hands out a /48, which holds 65,536 /64s.
 * `clientIpBucket(ip, { ipv6Prefix: 48 })` answers `2001:db8:1::/48` for every address in it. The
 * prefix is an integer from 0 to 128; any other value throws a `RangeError`.
 *
 * With `trustedProxy: false` (the default) only the transport peer address is used. With
 * `trustedProxy: true` the order is `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` >
 * peer address. `X-Forwarded-For` is read hop by hop, never as a whole string, because a client
 * controls the leading part of that list. Passing one `TrustedProxyHeader` string
 * (`"cf-connecting-ip" | "x-forwarded-for" | "x-real-ip"`) instead of `true` reads only that header,
 * first hop, then falls back to the peer address — the other two headers are never consulted.
 *
 * **Every one of those headers is client-controlled unless a proxy strips and rewrites it, and which
 * headers a given proxy rewrites differs by proxy** — `trustedProxy: true` trusts all three, which is
 * wrong for a proxy that only rewrites some of them:
 *
 * - **Traefik**, with default settings (an empty `forwardedHeaders.trustedIPs`), overwrites
 *   `X-Forwarded-For` and `X-Real-IP` for every client, but passes `CF-Connecting-IP` through
 *   untouched. A client behind Traefik can set `CF-Connecting-IP` to anything it likes, so
 *   `trustedProxy: true` behind Traefik reads a forged value first. Pass `trustedProxy: "x-real-ip"`
 *   (or `"x-forwarded-for"`) instead, so `CF-Connecting-IP` is never read — **but only when
 *   `trustedIPs` is empty.** Set `forwardedHeaders.trustedIPs` to trust an upstream proxy in front of
 *   Traefik (the Cloudflare → Traefik layout, listing Cloudflare's ranges) and Traefik stops rewriting
 *   from scratch: it keeps that upstream's `X-Real-IP` as it arrived and appends its own hop to
 *   `X-Forwarded-For` instead of replacing it. `X-Real-IP` and every hop but the last of
 *   `X-Forwarded-For` are then only as trustworthy as the upstream was — a client can still forge
 *   `X-Real-IP` and have Cloudflare (or whatever sits in `trustedIPs`) pass it straight through, and a
 *   test against Traefik 3.5.6 confirmed it: with `trustedIPs: ["127.0.0.1/32"]`, a
 *   client-forged `X-Real-IP: 192.0.2.1` reached the backend unchanged. Behind Cloudflare → Traefik
 *   with Cloudflare's ranges in `trustedIPs`, trust `"cf-connecting-ip"` instead — Cloudflare sets that
 *   header itself and Traefik never rewrites it either way, so `trustedIPs` does not weaken it.
 *   `"x-real-ip"` is the right choice only when nothing reachable by a client is listed in
 *   `trustedIPs`.
 * - **Cloudflare** sets `CF-Connecting-IP` itself. `trustedProxy: "cf-connecting-ip"` is the narrow
 *   equivalent of `true` behind Cloudflare alone.
 * - **nginx** writes only the headers its own config sets with `proxy_set_header` — there is no
 *   built-in default to name here; check the site config for which header (typically
 *   `X-Real-IP` and/or `X-Forwarded-For`) it actually rewrites before trusting either.
 *
 * A client that reaches the origin directly, with no proxy at all, can forge any of the three, so the
 * trusted-proxy boundary is always the caller's responsibility. The middleware supports every point on
 * that spectrum:
 *
 * - **Behind a proxy that rewrites every header you might read:** pass `trustedProxy: true` to
 *   `userThenIp`. Nothing else is needed.
 * - **Behind a proxy that rewrites only one header** (Traefik's default, most nginx configs): pass
 *   that header's name, e.g. `trustedProxy: "x-real-ip"`.
 * - **No such proxy:** leave `trustedProxy` at its default (`false`) and wire `remoteAddr`, which
 *   `keyResolver` receives as `context.remoteAddr` (see Usage). Keys then follow the connection's own
 *   peer address, which a client cannot set.
 *
 * Without a `remoteAddr` accessor the resolver has no peer address at all and falls back to the
 * placeholder `clientIp` returns, `0.0.0.0` — and **every** header-less client then shares one bucket,
 * so one caller exhausting it denies the rest. So `createRateLimitMiddleware`
 * **requires** a `remoteAddr` resolver and throws at construction time without one, so the shared
 * bucket can only happen because a caller wrote `remoteAddr: () => undefined` and meant it, not because
 * the option was left out. If you cannot obtain a peer address, pass that no-op explicitly, treat the
 * shared bucket as a backstop, and front the service with a proxy.
 *
 * **Where the trust decision lives.** Exactly three places can consult a forwarding header, and all
 * three default to not trusting one: `clientIp`'s `trustedProxy` parameter, `userThenIp`'s
 * `trustedProxy` option, and the `keyResolver` you write — which sees a header only if you read one.
 * There is deliberately no fourth, such as a helper that builds a key from a bare `Request`: a
 * `Request` carries no peer address, so such a helper could only trust a forwarding header. Compose `clientIp` with `rateLimitKey` yourself if you need a key
 * outside the middleware, stating explicitly which of the two you want.
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
 * The three headers in which a request names the client it came from, and which {@link clientIp}
 * reads when told to trust a proxy. Only a proxy should send them: a server that reads any of them
 * can refuse them from every other peer with `requireProxyForForwardedHeaders` from
 * `@spy4x/server/http/trusted-proxy`, which checks this same list.
 */
export const FORWARDED_HEADERS: readonly ["x-real-ip", "x-forwarded-for", "cf-connecting-ip"] = [
  REAL_IP,
  FORWARDED_FOR,
  CONNECTING_IP,
] as const

/**
 * A single proxy header {@link clientIp} may be told to trust, in place of the default
 * all-three-headers order. Name the one header the proxy in front actually rewrites — see the
 * module doc's Traefik and Cloudflare examples.
 */
export type TrustedProxyHeader = (typeof FORWARDED_HEADERS)[number]

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

/** Options for {@link clientIpBucket}. */
export interface ClientIpBucketOptions {
  /**
   * The length of the IPv6 network one client is counted as, an integer from 0 to 128. Defaults
   * to 64, one ordinary allocation. A budget that a stranger with a free tunnel broker's /48 must
   * not be able to multiply, such as a sign-up code budget per address, passes 48. Any other
   * value throws a `RangeError`, even for an IPv4 address, so a bad setting fails on the first
   * request.
   */
  ipv6Prefix?: number
}

/**
 * The rate-limit identity of a client address: an IPv6 address reduced to its /64 network
 * (`2001:db8:1:2::/64`), or to the network `options.ipv6Prefix` names, anything else unchanged.
 *
 * One ordinary IPv6 allocation — a household, a phone, a rented server — is a whole /64, 2^64
 * addresses the holder can pick from freely. Keyed per address, such a client rotates through them
 * and is never limited, and every rotated address becomes a stored bucket. Keyed per /64, it
 * gets one budget, the same as one IPv4 client. A free tunnel broker hands out a /48, 65,536 /64s,
 * so a budget a stranger must not multiply counts per /48 (`ipv6Prefix: 48`). IPv4 addresses, and
 * values that are not an address (the placeholder, a Unix socket path), come back as they are. An
 * IPv4-mapped IPv6 address comes back as its IPv4 address.
 */
export function clientIpBucket(ip: string, options: ClientIpBucketOptions = {}): string {
  const prefix = options.ipv6Prefix ?? 64
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    throw new RangeError(`ipv6Prefix must be an integer from 0 to 128, got ${prefix}`)
  }
  const parsed = parseIp(ip)
  if (parsed === null) return ip
  if (parsed.version === 4) return parsed.address
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) {
    // The bits of this 16-bit group that lie inside the prefix; the rest are cleared.
    const kept = Math.min(16, Math.max(0, prefix - i * 8))
    const mask = kept === 0 ? 0 : (0xffff << (16 - kept)) & 0xffff
    groups.push((((parsed.bytes[i] << 8) | parsed.bytes[i + 1]) & mask).toString(16))
  }
  return `${normalizeIp(groups.join(`:`))}/${prefix}`
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
