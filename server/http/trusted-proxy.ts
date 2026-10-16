/**
 * Trust the forwarded-client headers only from the proxies in front of the app.
 *
 * A reverse proxy names the client it forwards in `X-Real-IP`, `X-Forwarded-For` or
 * `CF-Connecting-IP`, and the app reads that name for its rate limits, its audit rows and a
 * session's device. Any other peer that reaches the app directly, such as a neighbour container on
 * a shared Docker network, can set the same headers to any address it likes and get a fresh
 * sign-in budget for each. {@link requireProxyForForwardedHeaders} refuses such a request with 403
 * unless it came from a trusted proxy; {@link createProxyPeers} decides which peers those are.
 *
 * `clientIp`'s `trustedProxies` option (`@spy4x/platform/rate-limit/client-ip`) takes fixed CIDR
 * ranges. A proxy that runs as a container gets a new address each time it is recreated, so this
 * module trusts it by name instead and follows the name's current address.
 *
 * Ported from `template/apps/api/middlewares/proxy-peer.ts` (spy4x/template#381, #469). What changed
 * and why:
 *
 *  - The source awaited a DNS lookup inside the request every 10 s, and for each request from an
 *    unknown peer. When the resolver hung (upstream DNS down), every request carrying a forwarded
 *    header waited up to 8 s. Lookups now run in the background and a request is answered from the
 *    addresses already known; only the very first lookup is awaited, because before it there is
 *    nothing to answer from.
 *  - A failing `onError` callback no longer breaks the lookup: the last good addresses stay.
 *  - The peer address comes from a `remoteAddr` resolver (`denoServeRemoteAddr` under `deno
 *    serve`) instead of Deno's `env.remoteAddr`, so the module runs on any runtime.
 *  - The 403 wording is a parameter.
 *
 * @module
 */

import type { Env, MiddlewareHandler } from "hono"
import { normalizeIp } from "@spy4x/net/ip"
import { defaultResolver, type DnsResolver } from "@spy4x/net/url-policy"
import { FORWARDED_HEADERS } from "@spy4x/platform/rate-limit/client-ip"
import type { RateLimitContext, RemoteAddrResolver } from "@spy4x/platform/rate-limit/hono"

export { FORWARDED_HEADERS }

/** How long a looked-up address of a proxy is trusted before a request starts a new lookup. */
export const PROXY_ADDRESS_MAX_AGE_MS = 10_000

/** The least time between two lookups that a request from an unknown peer starts. */
export const PROXY_LOOKUP_RETRY_MS = 1_000

/** Tells whether a connection's peer address is one of the trusted proxies. */
export type IsProxyPeer = (peer: string | undefined) => Promise<boolean>

/** Options for {@link createProxyPeers}. */
export interface ProxyPeersOptions {
  /** Container or host names to look up, or IP addresses taken as they are. */
  hosts: readonly string[]
  /**
   * Looks a name up. Defaults to `defaultResolver` from `@spy4x/net`, the system resolver (Docker's
   * own DNS inside a container), which needs `--allow-net` under Deno.
   */
  resolver?: DnsResolver
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Told when a lookup of `host` fails; that name keeps the addresses it had. An error this
   * callback throws is ignored, so a broken logger cannot drop the trusted addresses.
   */
  onError?: (host: string, error: unknown) => void
}

/**
 * The trusted proxies, by address.
 *
 * An IP address in `hosts` is trusted as it is, in any spelling (`::ffff:127.0.0.1` is
 * `127.0.0.1`). Every other entry is a name, and the addresses it resolves to are trusted.
 *
 * The first call that needs a name waits for the first lookup. After that, no call waits on DNS:
 * it answers from the addresses already known and, when needed, starts a lookup in the background
 * that later calls see. A call starts one when the addresses are {@link PROXY_ADDRESS_MAX_AGE_MS}
 * old, because a recreated proxy gets a new address and its old one may go to another container.
 * A call from an unknown peer starts one too, at most once per {@link PROXY_LOOKUP_RETRY_MS}, so a
 * recreated proxy is trusted again about a second later. Its requests in between are refused.
 *
 * A lookup that fails keeps the name's last addresses, so a DNS outage does not shut the proxy out;
 * it is reported to `onError`. A name that resolves to no address (a container that is not
 * running) trusts nothing.
 */
export function createProxyPeers(options: ProxyPeersOptions): IsProxyPeer {
  const resolver = options.resolver ?? defaultResolver
  const now = options.now ?? Date.now
  const onError = options.onError ?? (() => {})
  const fixed = new Set<string>()
  const names: string[] = []
  for (const host of options.hosts) {
    const ip = normalizeIp(host.trim())
    if (ip === null) names.push(host.trim())
    else fixed.add(ip)
  }
  const resolved = new Map<string, readonly string[]>()
  let lookedUpAt: number | undefined
  let pending: Promise<void> | undefined

  const lookUpName = async (name: string): Promise<void> => {
    try {
      const addresses = await resolver.resolve(name)
      resolved.set(name, addresses.map((a) => normalizeIp(a)).filter((a) => a !== null))
    } catch (error) {
      try {
        onError(name, error)
      } catch {
        // A failing reporter must not fail the lookup it reports on.
      }
    }
  }
  /** One lookup of every name at a time; it never rejects. */
  const lookUp = (): Promise<void> => {
    pending ??= Promise.all(names.map(lookUpName)).then(() => {
      lookedUpAt = now()
      pending = undefined
    })
    return pending
  }
  const isResolved = (ip: string) => [...resolved.values()].some((list) => list.includes(ip))

  return async (peer) => {
    const ip = peer === undefined ? null : normalizeIp(peer.trim())
    if (ip === null) return false
    if (fixed.has(ip)) return true
    if (names.length === 0) return false
    if (lookedUpAt === undefined) {
      await lookUp()
      return isResolved(ip)
    }
    const age = now() - lookedUpAt
    const trusted = isResolved(ip)
    if (age >= PROXY_ADDRESS_MAX_AGE_MS || (!trusted && age >= PROXY_LOOKUP_RETRY_MS)) {
      void lookUp()
    }
    return trusted
  }
}

/** Options for {@link requireProxyForForwardedHeaders}. */
export interface RequireProxyOptions<E extends Env = Record<string, never>> {
  /**
   * Reads the connection's peer address, as for the rate limiter: `denoServeRemoteAddr` from
   * `@spy4x/platform/rate-limit/hono` under `deno serve`.
   */
  remoteAddr: RemoteAddrResolver<E>
  /** The `error` of the 403 body. Defaults to `"Forwarded headers are accepted from the proxy only"`. */
  message?: string
}

/** The default `error` of the 403 body. */
const FORWARDED_HEADERS_REFUSED = "Forwarded headers are accepted from the proxy only"

/**
 * Hono middleware that refuses, with 403 and `{ error: message }`, a request that carries one of
 * the {@link FORWARDED_HEADERS} and whose peer is not a trusted proxy (or is unknown). A request
 * without those headers passes, and the app counts it under the connection's own address.
 *
 * Mount it in front of every route, before anything that reads the headers: the rate limits, the
 * audit log, `requestInfoFromContext`. Refusing rather than stripping the headers keeps the
 * original request, which a WebSocket upgrade needs, and covers every reader at once.
 *
 * Throws a `TypeError` when `remoteAddr` is not a function or `message` is empty: without a peer
 * address every forwarded request would be refused, the proxy's included.
 */
export function requireProxyForForwardedHeaders<E extends Env = Record<string, never>>(
  isProxyPeer: IsProxyPeer,
  options: RequireProxyOptions<E>,
): MiddlewareHandler<E> {
  if (typeof isProxyPeer !== "function") {
    throw new TypeError("requireProxyForForwardedHeaders: isProxyPeer must be a function")
  }
  if (typeof options?.remoteAddr !== "function") {
    throw new TypeError(
      "requireProxyForForwardedHeaders: remoteAddr is required, for example denoServeRemoteAddr",
    )
  }
  const message = options.message ?? FORWARDED_HEADERS_REFUSED
  if (typeof message !== "string" || message.trim() === "") {
    throw new TypeError("requireProxyForForwardedHeaders: message must be a non-empty string")
  }
  const remoteAddr = options.remoteAddr
  return async (c, next) => {
    const forwarded = FORWARDED_HEADERS.some((name) => c.req.raw.headers.has(name))
    if (forwarded) {
      const context: RateLimitContext<E> = {
        req: c.req.raw,
        env: (c as { env?: E }).env,
        get: (key: string) => c.get?.(key as never),
      }
      if (!(await isProxyPeer(remoteAddr(context)))) return c.json({ error: message }, 403)
    }
    await next()
  }
}
