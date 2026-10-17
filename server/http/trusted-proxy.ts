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
 *  - The source awaited a DNS lookup inside the request with no bound: when the resolver hung
 *    (upstream DNS down), every request carrying a forwarded header waited up to 8 s. A request now
 *    waits for a lookup at most {@link PROXY_LOOKUP_DEADLINE_MS}, and concurrent requests share one.
 *  - After the deadline a request is answered from the last good addresses, but only while they are
 *    younger than {@link PROXY_ADDRESS_HARD_MAX_AGE_MS}; past that a failing DNS refuses, so a
 *    moved proxy's old address is not trusted for the length of an outage.
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

/** How long looked-up addresses of a proxy answer without a new lookup. */
export const PROXY_ADDRESS_MAX_AGE_MS = 10_000

/** The least time between the end of a lookup and the next one that an unknown peer starts. */
export const PROXY_LOOKUP_RETRY_MS = 1_000

/** The longest a call waits for a lookup before it answers from the last good addresses. */
export const PROXY_LOOKUP_DEADLINE_MS = 1_000

/**
 * How long a name's addresses stay trusted after its last successful lookup while later lookups
 * fail or hang. Past it the name trusts nothing until a lookup succeeds.
 */
export const PROXY_ADDRESS_HARD_MAX_AGE_MS = 600_000

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
   * Calls `callback` after `ms` milliseconds and returns a function that cancels it; it bounds the
   * wait for a lookup. Defaults to `setTimeout`. A test passes a fake one together with `now`.
   */
  setTimer?: (callback: () => void, ms: number) => () => void
  /**
   * Told when a lookup of `host` fails; that name keeps the addresses it had. An error this
   * callback throws is ignored, so a broken logger cannot drop the trusted addresses.
   */
  onError?: (host: string, error: unknown) => void
}

/** The addresses of one name, and when the lookup that found them started. */
interface Resolved {
  addresses: readonly string[]
  at: number
}

/** The lookup in flight, and a promise that settles when the calls stop waiting for it. */
interface Lookup {
  done: Promise<void>
  deadline: Promise<void>
}

const defaultSetTimer = (callback: () => void, ms: number) => {
  const id = setTimeout(callback, ms)
  return () => clearTimeout(id)
}

/**
 * The trusted proxies, by address.
 *
 * An IP address in `hosts` is trusted as it is, in any spelling (`::ffff:127.0.0.1` is
 * `127.0.0.1`). Every other entry is a name, and the addresses it resolves to are trusted.
 *
 * A call looks the names up again when the addresses are {@link PROXY_ADDRESS_MAX_AGE_MS} old (or
 * none were looked up yet), and when the peer is not among them, unless the last lookup ended less
 * than {@link PROXY_LOOKUP_RETRY_MS} ago. It waits for the lookup, at most
 * {@link PROXY_LOOKUP_DEADLINE_MS} after the lookup started, and every call in that time shares the
 * one lookup. A lookup that answers in time decides the call: a recreated proxy's new address is
 * trusted and its old one, which Docker may give to another container, is refused.
 *
 * What remains:
 *
 *  - A known address is trusted without a lookup until the addresses are
 *    {@link PROXY_ADDRESS_MAX_AGE_MS} old, so a proxy that moves within that time of the last
 *    lookup leaves its old address trusted for the rest of it, even with DNS healthy.
 *  - A peer that is not among the addresses within {@link PROXY_LOOKUP_RETRY_MS} after a lookup
 *    ended is refused without a new lookup, so a proxy recreated in that second is refused for up
 *    to a second.
 *  - When a lookup fails (an error, or no answer by the deadline), the call is answered from the
 *    name's last good addresses while they are younger than {@link PROXY_ADDRESS_HARD_MAX_AGE_MS},
 *    counted from the start of the last lookup that succeeded. So while DNS fails, a moved proxy's
 *    old address stays trusted for at most that long; after it the name trusts nothing until a
 *    lookup succeeds. A failure is reported to `onError`.
 *  - One lookup runs at a time. While one runs past its deadline, calls answer at once from the last
 *    good addresses, as above, instead of waiting again.
 *
 * A name that resolves to no address (a container that is not running) trusts nothing.
 */
export function createProxyPeers(options: ProxyPeersOptions): IsProxyPeer {
  const resolver = options.resolver ?? defaultResolver
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? defaultSetTimer
  const onError = options.onError ?? (() => {})
  const fixed = new Set<string>()
  const names: string[] = []
  for (const host of options.hosts) {
    const ip = normalizeIp(host.trim())
    if (ip === null) names.push(host.trim())
    else fixed.add(ip)
  }
  const resolved = new Map<string, Resolved>()
  let lookedUpAt: number | undefined
  let current: Lookup | undefined

  const lookUpName = async (name: string, startedAt: number): Promise<void> => {
    try {
      const addresses = await resolver.resolve(name)
      resolved.set(name, {
        addresses: addresses.map((a) => normalizeIp(a)).filter((a) => a !== null),
        at: startedAt,
      })
    } catch (error) {
      try {
        onError(name, error)
      } catch {
        // A failing reporter must not fail the lookup it reports on.
      }
    }
  }
  /** One lookup of every name at a time; neither of its promises rejects. */
  const lookUp = (): Lookup => {
    if (current !== undefined) return current
    let cancel = () => {}
    const deadline = new Promise<void>((resolve) => {
      cancel = setTimer(resolve, PROXY_LOOKUP_DEADLINE_MS)
    })
    const startedAt = now()
    const done = Promise.all(names.map((name) => lookUpName(name, startedAt))).then(() => {
      cancel()
      lookedUpAt = now()
      current = undefined
    })
    current = { done, deadline }
    return current
  }
  const isResolved = (ip: string) => {
    const time = now()
    return [...resolved.values()].some((entry) =>
      time - entry.at < PROXY_ADDRESS_HARD_MAX_AGE_MS && entry.addresses.includes(ip)
    )
  }

  return async (peer) => {
    const ip = peer === undefined ? null : normalizeIp(peer.trim())
    if (ip === null) return false
    if (fixed.has(ip)) return true
    if (names.length === 0) return false
    const age = lookedUpAt === undefined ? Infinity : now() - lookedUpAt
    const stale = age >= PROXY_ADDRESS_MAX_AGE_MS
    const unknown = !isResolved(ip) && age >= PROXY_LOOKUP_RETRY_MS
    if (stale || unknown) {
      const lookup = lookUp()
      await Promise.race([lookup.done, lookup.deadline])
    }
    return isResolved(ip)
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
