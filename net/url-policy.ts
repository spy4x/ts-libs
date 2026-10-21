/**
 * URL policy — validates that a URL is publicly routable.
 *
 * SSRF guard for any place that issues an outbound HTTP request on the user's
 * behalf. The check runs in three layers:
 *   1. Parse + scheme/host shape, reusing `net/url-shape`'s scheme, character
 *      and parse rules verbatim.
 *   2. Reject special-use hostnames (`localhost`, `*.localhost`, `.local`,
 *      `.invalid`) and embedded credentials.
 *   3. For IP literals, verify the address is globally routable. For DNS
 *      hostnames, resolve A/AAAA and reject if ANY result is non-public or
 *      the lookup fails.
 *
 * Layer 3 is the only side-effecting part and it goes through the injectable
 * `DnsResolver`, so the whole module is deterministic in tests.
 *
 * RELATIONSHIP TO `net/url-shape`
 *
 * `validatePublicUrl()` deliberately does not call `normalizeUrlShape()`: shape
 * refuses anything without a dot in the host, so `localhost`, `127.0.0.1` and
 * `[::1]` would all come back as `invalid_hostname` instead of the policy codes
 * a caller needs to branch on (`special_use`, `non_public_ip`). It also drops
 * the port. The two rulesets therefore fork at the host rules and share
 * everything above them — see `detectScheme`, `INVALID_CHARACTERS` and the
 * message constants imported below.
 *
 * PERMISSIONS: `defaultResolver` calls `Deno.resolveDns`, so a consumer that
 * uses the default resolver needs `--allow-net`. Injecting a resolver removes
 * that need; every test in this package does exactly that.
 * @module
 */

import { parseIpv6Groups } from "./_ipv6.ts"
import { ipInRanges } from "./ip.ts"
import {
  ALLOWED_PROTOCOLS,
  detectScheme,
  EMPTY_MESSAGE,
  INVALID_CHARACTERS,
  INVALID_CHARACTERS_MESSAGE,
  INVALID_FORMAT_MESSAGE,
  UNSUPPORTED_PROTOCOL_MESSAGE,
} from "./url-shape.ts"

export type { NormalizeUrlShapeResult, UrlShapeError, UrlShapeOk } from "./url-shape.ts"

/**
 * Re-exported so a caller that already depends on the policy — and therefore
 * wants a URL that is safe to fetch, not just well-shaped — can reach the
 * shape-only entry point without a second import specifier.
 */
export { normalizeUrlShape } from "./url-shape.ts"

export { parseIpv6Groups } from "./_ipv6.ts"

/**
 * Machine-readable rejection reason.
 *
 * Shape codes (`empty`, `unsupported_protocol`, `invalid_format`) are shared
 * with `net/url-shape`; the rest are policy-only. The two redirect codes come
 * from `net/safe-fetch`, which raises the same error type so a caller can catch
 * one class and branch on the code alone.
 */
export type UrlPolicyErrorCode =
  | "empty"
  | "unsupported_protocol"
  | "invalid_format"
  | "invalid_hostname"
  | "userinfo"
  | "special_use"
  | "non_public_ip"
  | "dns_failure"
  | "invalid_redirect"
  | "too_many_redirects"

/** A URL rejected by the policy, with a stable code a caller can branch on. */
export class UrlValidationError extends Error {
  /** Stable machine-readable error code. Safe to surface to clients. */
  readonly code: UrlPolicyErrorCode
  /**
   * Builds the error for a rejected URL.
   * @param code Stable machine-readable error code.
   * @param message Human-readable rejection message.
   */
  constructor(code: UrlPolicyErrorCode, message: string) {
    super(message)
    this.name = "UrlValidationError"
    this.code = code
  }
}

/**
 * DNS lookup failure — either the resolver threw or it returned no records.
 *
 * Separate from plain `UrlValidationError` so a caller can tell "this host does
 * not resolve" from "this host is not allowed" without matching message text.
 */
export class DnsResolutionError extends UrlValidationError {
  /**
   * Builds the error for a DNS lookup failure.
   * @param message Human-readable rejection message.
   */
  constructor(message: string) {
    super("dns_failure", message)
    this.name = "DnsResolutionError"
  }
}

/** Resolves a hostname to all A/AAAA addresses. */
export interface DnsResolver {
  /**
   * Resolve a hostname to all A/AAAA records.
   *
   * Implementations are NOT expected to honour an AbortSignal — DNS
   * resolution is fire-and-forget from this module's perspective. Callers
   * that need an upper bound on DNS latency must enforce it externally.
   */
  resolve(hostname: string): Promise<string[]>
}

/** Address families the policy verifies. Every family listed is required. */
type AddressFamily = "A" | "AAAA"

/**
 * The production resolver: system A **and** AAAA lookups, both required.
 *
 * NODATA and lookup failure are different things and must be treated
 * differently:
 *
 *  - **NODATA** — the name exists but has no record of that type.
 *    `Deno.resolveDns` throws `Deno.errors.NotFound` for it. That is a
 *    legitimate empty answer: most of the public web is A-only, so treating it
 *    as a failure would refuse `github.com`. It resolves to an empty family.
 *  - **Every other error** — SERVFAIL, timeout, refused, malformed reply — is a
 *    real failure and propagates, so the guard reports `dns_failure` and fails
 *    closed. An unanswerable family is unverifiable, and unverifiable must never
 *    be read as safe.
 *
 * A host that answers neither family propagates as NODATA and fails the
 * policy — "no records at all" is not a routable destination.
 */
export const defaultResolver: DnsResolver = {
  async resolve(hostname: string): Promise<string[]> {
    const lookup = async (type: AddressFamily): Promise<string[]> => {
      try {
        return await Deno.resolveDns(hostname, type)
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return []
        throw err
      }
    }
    const [a, aaaa] = await Promise.all([lookup("A"), lookup("AAAA")])
    return [...a, ...aaaa]
  },
}

/** Per-call overrides for {@link validatePublicUrl}. */
export interface ValidatePublicUrlOptions {
  /** Resolver for DNS lookups. Defaults to `defaultResolver`. */
  resolver?: DnsResolver
  /** When `false`, `http:` is rejected outright. Defaults to `true`. */
  allowHttp?: boolean
}

/** Message used when `allowHttp: false` rejects an `http:` URL. */
export const HTTP_OPTION_MESSAGE: string = "HTTPS required"

const CANONICAL_DOTTED_IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Validate a URL and return the canonical form.
 *
 * Throws `UrlValidationError` (or its `DnsResolutionError` subclass) on any
 * policy violation. The returned string is safe to use in logs, DB
 * persistence, downstream fetches, and client responses — credentials are
 * stripped, default ports are elided, and the host is normalized.
 *
 * @param input Raw input; a missing scheme is completed with `https://`.
 * @param options Injected resolver and `allowHttp`.
 */
export async function validatePublicUrl(
  input: string,
  options: ValidatePublicUrlOptions = {},
): Promise<string> {
  const raw = (input ?? "").trim()
  if (!raw) {
    throw new UrlValidationError("empty", EMPTY_MESSAGE)
  }

  // Reject control chars and embedded whitespace — URLs must not contain them.
  if (INVALID_CHARACTERS.test(raw)) {
    throw new UrlValidationError("invalid_format", INVALID_CHARACTERS_MESSAGE)
  }

  // Detect any explicit scheme up-front so we can reject dangerous schemes
  // (`javascript:`, `data:`, `file:`, …) before prepending `https://`. A dotted
  // candidate (`example.com:8443`) is a host with a port, not a scheme.
  const { hadScheme, scheme } = detectScheme(raw)
  if (hadScheme && !ALLOWED_PROTOCOLS.has(`${scheme}:`)) {
    throw new UrlValidationError("unsupported_protocol", UNSUPPORTED_PROTOCOL_MESSAGE)
  }

  let parsed: URL
  try {
    parsed = new URL(hadScheme ? raw : `https://${raw}`)
  } catch {
    throw new UrlValidationError("invalid_format", INVALID_FORMAT_MESSAGE)
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new UrlValidationError("unsupported_protocol", UNSUPPORTED_PROTOCOL_MESSAGE)
  }

  if (parsed.protocol === "http:" && options.allowHttp === false) {
    throw new UrlValidationError("unsupported_protocol", HTTP_OPTION_MESSAGE)
  }

  if (!parsed.hostname) {
    throw new UrlValidationError("invalid_hostname", "Invalid URL: missing hostname")
  }

  // Reject userinfo — credentials must never appear in canonical URLs that
  // get logged, persisted, or echoed back to clients.
  if (parsed.username || parsed.password) {
    throw new UrlValidationError("userinfo", "URL must not contain credentials")
  }

  // `parsed.hostname` for IPv6 literals includes the surrounding brackets
  // (`[::1]`); strip them so the classifiers can work on the bare address.
  const rawHost = parsed.hostname
  const isBracketedIpv6 = rawHost.startsWith("[") && rawHost.endsWith("]")
  const host = isBracketedIpv6 ? rawHost.slice(1, -1) : rawHost

  if (isLocalHostname(host)) {
    throw new UrlValidationError("special_use", "URL points to a special-use host")
  }

  if (isBracketedIpv6) {
    if (!isPublicIpv6(host)) {
      throw new UrlValidationError("non_public_ip", "URL points to a non-public address")
    }
  } else if (CANONICAL_DOTTED_IPV4.test(host)) {
    if (!isPublicIpv4(host)) {
      throw new UrlValidationError("non_public_ip", "URL points to a non-public address")
    }
  } else if (host.includes(":")) {
    // Some parsers omit brackets for IPv6; treat the bare form as IPv6.
    if (!isPublicIpv6(host)) {
      throw new UrlValidationError("non_public_ip", "URL points to a non-public address")
    }
  } else {
    // DNS name — resolve and verify every record is publicly routable.
    if (!host.includes(".") || host.endsWith(".")) {
      throw new UrlValidationError("invalid_hostname", "Invalid domain")
    }
    const resolver = options.resolver ?? defaultResolver
    let addrs: string[]
    try {
      addrs = await resolver.resolve(host)
    } catch (err) {
      throw new DnsResolutionError(
        `DNS resolution failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (addrs.length === 0) {
      throw new DnsResolutionError("DNS resolution returned no addresses")
    }
    for (const addr of addrs) {
      if (!isPublicAddress(addr)) {
        throw new UrlValidationError(
          "non_public_ip",
          "Hostname resolves to a non-public address",
        )
      }
    }
  }

  // Use parsed.href as canonical output: the WHATWG parser has already
  // normalized host case, elided default ports, and preserved non-default
  // ports (incl. with bracketed IPv6). Userinfo was rejected above so the
  // canonical form is safe to persist/log/return.
  return parsed.href
}

/** `0.0.0.0/8`, "this network": refused by the classifier, never denied at connect time. */
const THIS_NETWORK = "0.0.0.0/8"

/**
 * Every IPv4 range that is not globally routable: the one table behind both
 * `isPublicIpv4` and `DENY_NET_ADDRESSES`, so the two cannot drift apart.
 */
const NON_PUBLIC_IPV4_RANGES: readonly string[] = [
  THIS_NETWORK,
  "10.0.0.0/8", // private (RFC 1918)
  "100.64.0.0/10", // carrier-grade NAT (RFC 6598)
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, including the cloud metadata address
  "172.16.0.0/12", // private (RFC 1918)
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation (TEST-NET-1)
  "192.88.99.0/24", // 6to4 relay anycast, decommissioned
  "192.168.0.0/16", // private (RFC 1918)
  "198.18.0.0/15", // benchmarking (RFC 2544)
  "198.51.100.0/24", // documentation (TEST-NET-2)
  "203.0.113.0/24", // documentation (TEST-NET-3)
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including the broadcast address
]

// ────────────────────────────────────────────────────────────────────────────
// The second layer: address ranges the runtime should refuse to dial
// ────────────────────────────────────────────────────────────────────────────

/**
 * Addresses to refuse at connection time, in the spelling `--deny-net` takes.
 *
 * This guard resolves a hostname and then hands the *name* to `fetch`, which
 * resolves it a second time. A DNS server under someone else's control can
 * answer with a public address for the first lookup and an internal one for the
 * second, and the request then goes where the guard never looked. Nothing this
 * module can do closes that gap: the platform `fetch` takes no resolved address.
 *
 * `--deny-net` does close it, because Deno applies it at connect time, against
 * the address the connection is actually going to. Start the process with these
 * denied and a rebind lands on a refused connection instead of on the internal
 * service — see `denyNetFlag()` and the README.
 *
 * **What this layer cannot cover.** Deno 2.9.7 takes a CIDR range for IPv4 but
 * not for IPv6: `--deny-net=fc00::/7` stops the process from starting at all
 * ("ipv6 addresses must be enclosed in square brackets") and `[fc00::]/7` is
 * rejected as a host, so an IPv6 range cannot be written down. Only single
 * bracketed addresses can — `[::1]` and `[::]` are the two worth naming — so
 * unique-local and link-local IPv6 have the classifier above as their only layer.
 *
 * **The gap it leaves.** `0.0.0.0` still reaches a service on the same machine,
 * and it cannot be denied from here: a denied address cannot be listened on
 * either, and `Deno.serve` binds the wildcard address by default, so
 * `0.0.0.0/8` or `0.0.0.0/32` in this list stops the application from starting
 * its own server. A process that never listens can add `0.0.0.0/32` to the flag
 * itself and close it; one that serves cannot, and the README says so plainly.
 *
 * Every address here is one `isPublicAddress` also refuses, which
 * `url-policy.test.ts` checks; the other direction does not hold, and this list
 * is the shorter of the two.
 */
export const DENY_NET_ADDRESSES: readonly string[] = [
  // Every IPv4 range the classifier refuses, except `0.0.0.0/8`: see "The gap it leaves" above.
  ...NON_PUBLIC_IPV4_RANGES.filter((range) => range !== THIS_NETWORK),
  // The two IPv6 addresses the flag can express. `[::]` is the IPv6 spelling of
  // "this machine" and is safe to deny: unlike `0.0.0.0`, denying it does not
  // stop `Deno.serve` binding its default address.
  "[::1]", // IPv6 loopback
  "[::]", // IPv6 unspecified — reaches local services when dialled
]

/**
 * `DENY_NET_ADDRESSES` as the command-line flag that applies them.
 *
 * Meant for whatever writes the command: a task definition, a Dockerfile, a
 * deploy script. It cannot restrict the process it is called from — permissions
 * are fixed when that process starts.
 */
export function denyNetFlag(): string {
  return `--deny-net=${DENY_NET_ADDRESSES.join(",")}`
}

// ────────────────────────────────────────────────────────────────────────────
// Hostname + IP classifiers
// ────────────────────────────────────────────────────────────────────────────

/** RFC 6761 special-use names that resolve to local or non-routable space. */
const SPECIAL_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"])

/**
 * True if the hostname is a special-use name that resolves locally.
 *
 * A fully-qualified trailing dot is folded away first: under DNS,
 * `localhost.` and `localhost` are the same name, and `localhost` is legal in
 * a `Location` header, so leaving the trailing dot intact let
 * `http://localhost./` reach the DNS branch instead of being rejected here.
 */
export function isLocalHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.+$/, "")
  if (SPECIAL_HOSTNAMES.has(lower)) return true
  if (lower.endsWith(".localhost")) return true
  if (lower.endsWith(".local")) return true
  if (lower.endsWith(".invalid")) return true
  return false
}

/**
 * True if `addr` is a globally routable IPv4 or IPv6 address. An IPv6 address may come with or
 * without surrounding brackets.
 */
export function isPublicAddress(addr: string): boolean {
  if (!addr) return false
  let bare = addr
  if (bare.startsWith("[") && bare.endsWith("]")) bare = bare.slice(1, -1)
  if (bare.includes(":")) return isPublicIpv6(bare)
  return isPublicIpv4(bare)
}

/**
 * True if `addr` is a globally routable IPv4 address.
 *
 * Only canonical dotted-decimal form is classified. Non-canonical spellings of
 * an IPv4 address (`127.1`, `2130706433`, `0x7f000001`, `0177.0.0.1`) are
 * refused rather than parsed: the WHATWG `URL` parser already canonicalises
 * every one of those spellings before the policy sees a host, so nothing this
 * module can be handed reaches this function in that form.
 */
export function isPublicIpv4(addr: string): boolean {
  const m = CANONICAL_DOTTED_IPV4.exec(addr)
  if (!m) return false
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  if (octets.some((n) => n < 0 || n > 255)) return false
  // Rebuilt from the numbers: `010.0.0.1` is 10.0.0.1 here, and `ipInRanges`
  // refuses a leading zero, so the written form would read as no range at all.
  return !ipInRanges(octets.join("."), NON_PUBLIC_IPV4_RANGES)
}

/** True if the IPv6 address (with optional embedded IPv4) is globally routable. */
export function isPublicIpv6(addr: string): boolean {
  const groups = parseIpv6Groups(addr)
  if (!groups) return false

  const [a, b, c, d, e, f, g, h] = groups

  // IPv4-mapped IPv6: ::ffff:a.b.c.d  → first 80 bits zero, then 0xffff
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return isPublicIpv4(embeddedIpv4(g, h))
  }

  // ::ffff:0:0:0/96 — IPv4-translated (RFC 2765 §2.1, dropped by RFC 6145). It
  // wraps an IPv4 address one group further along than the mapped form above,
  // so `::ffff:0:7f00:1` is loopback written in a way the mapped check does not
  // see. The whole prefix goes: it is obsolete, so no destination needs it.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) return false

  // ::/128 unspecified
  if (groups.every((x) => x === 0)) return false
  // ::1/128 loopback — must precede the IPv4-compatible check below so a
  // bare `::1` is not misclassified as `0.0.0.1` via the embedded path.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) {
    return false
  }
  // IPv4-compatible IPv6: ::a.b.c.d (RFC 4291 §2.5.5.1, deprecated). The
  // first 96 bits are zero and the trailing 32 bits are an IPv4 address.
  // Delegate to the IPv4 classifier so private/loopback/link-local/etc.
  // variants are rejected identically.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && (g !== 0 || h !== 0)) {
    return isPublicIpv4(embeddedIpv4(g, h))
  }
  // NAT64: 64:ff9b::/96 → last 32 bits are IPv4
  if (a === 0x0064 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return isPublicIpv4(embeddedIpv4(g, h))
  }
  // 64:ff9b:1::/48 — local-use NAT64 (RFC 8215). Unlike the well-known prefix
  // above it is chosen by whoever runs the network, and what it translates to is
  // their business, so the address says nothing about where the packet lands.
  if (a === 0x0064 && b === 0xff9b && c === 0x0001) return false
  // 2002::/16 — 6to4 (RFC 3056), deprecated by RFC 7526. The second and third
  // groups are an IPv4 address, so `2002:7f00:1::` is 127.0.0.1 in costume.
  if (a === 0x2002) return false
  // 100::/64 discard prefix — block the whole prefix, not just the all-zero
  // address (RFC 6666). Any address whose first 64 bits are 0x0100:: is
  // reserved for discard.
  if (a === 0x0100 && b === 0 && c === 0 && d === 0) return false
  // 2001:db8::/32 documentation
  if (a === 0x2001 && b === 0x0db8) return false
  // 2001::/23 — the IETF protocol assignments block (RFC 2928). Teredo
  // (2001::/32), benchmarking (2001:2::/48) and ORCHID (2001:10::/28 and
  // 2001:20::/28) all sit inside it, and so does whatever is assigned there
  // next. The neighbouring 2001:200::/23 and up are ordinary allocations and
  // stay public — only the first 512 blocks are reserved.
  if (a === 0x2001 && (b & 0xfe00) === 0) return false
  // 3fff::/20 — documentation (RFC 9637)
  if (a === 0x3fff && (b & 0xf000) === 0) return false
  // 5f00::/16 — segment routing identifiers (RFC 9602): inside one operator's
  // network by construction.
  if (a === 0x5f00) return false
  // fec0::/10 deprecated site-local (RFC 3879)
  if ((a & 0xffc0) === 0xfec0) return false
  // fc00::/7 unique local addresses (ULA)
  if ((a & 0xfe00) === 0xfc00) return false
  // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfe80) return false
  // ff00::/8 multicast
  if ((a & 0xff00) === 0xff00) return false

  return true
}

/** The IPv4 address carried in the last two groups of an IPv6 address. */
function embeddedIpv4(g: number, h: number): string {
  return `${g >> 8}.${g & 0xff}.${h >> 8}.${h & 0xff}`
}
