/**
 * Client IP extraction from the transport peer address and optional proxy headers.
 *
 * With `trustedProxy: false` (the default) only `remoteAddr` is consulted, so the returned value is
 * the address of whoever actually opened the connection — unspoofable. With `trustedProxy: true`
 * the order is the one `mig/lib/ratelimit.ts` used: `CF-Connecting-IP`, then the first
 * `X-Forwarded-For` hop, then `X-Real-IP`, then `remoteAddr`.
 *
 * **Trust boundary:** those three headers are client-controlled unless a reverse proxy strips and
 * rewrites them. With no proxy in front and `trustedProxy: true`, a caller rotating
 * `X-Forwarded-For` produces a new bucket per request and the limiter is defeated; a self-set
 * `CF-Connecting-IP` lets it choose its own bucket. Turn the flag on only behind a proxy that
 * overwrites both.
 */

/** Fallback when no header and no peer address is available. */
export const UNKNOWN_CLIENT_IP = "0.0.0.0"

const CONNECTING_IP = "cf-connecting-ip"
const FORWARDED_FOR = "x-forwarded-for"
const REAL_IP = "x-real-ip"

/** First hop of a comma-separated header value, or `undefined` when it is empty. */
function firstHop(value: string | null): string | undefined {
  if (value === null) return undefined
  const hop = value.split(",")[0]?.trim() ?? ""
  return hop === "" ? undefined : hop
}

/**
 * Resolve the client IP for a request.
 *
 * Precedence: `CF-Connecting-IP` > first `X-Forwarded-For` hop > `X-Real-IP` > `remoteAddr`.
 * `X-Forwarded-For` is read hop by hop, never as a whole string — a list is
 * `<client>, <proxy>, ...`, so the first hop is the client and the remaining hops are proxy-chain
 * noise. An empty or whitespace-only header falls through to the next source; a malformed value is
 * returned verbatim rather than guessed at, because a limiter must bucket two requests claiming the
 * same address together instead of scattering them into fresh buckets.
 *
 * @param req Request whose headers are inspected.
 * @param remoteAddr Peer address from the transport, when the runtime exposes one.
 * @param trustedProxy When true, forwarding headers win; when false (default), only `remoteAddr`.
 */
export function clientIp(req: Request, remoteAddr?: string, trustedProxy = false): string {
  if (trustedProxy) {
    const cf = firstHop(req.headers.get(CONNECTING_IP))
    if (cf !== undefined) return cf

    const xff = firstHop(req.headers.get(FORWARDED_FOR))
    if (xff !== undefined) return xff

    const real = firstHop(req.headers.get(REAL_IP))
    if (real !== undefined) return real
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
