/**
 * IP address parsing and CIDR range checks (#221).
 *
 * `parseIp` accepts exactly one bare IPv4 or IPv6 address and nothing around it: no port, no
 * brackets, no zone id, no whitespace. It returns the address in one canonical spelling, so two
 * spellings of the same address compare equal as strings. `ipInRanges` tells whether an address
 * lies inside any of a list of CIDR ranges, for example a proxy's published edge ranges.
 *
 * Pure: no DNS, no I/O, no permissions.
 */

import { parseIpv6Groups } from "./url-policy.ts"

/** An address that {@link parseIp} accepted. */
export interface ParsedIp {
  /** `4` for IPv4, `6` for IPv6. An IPv4-mapped IPv6 address is reported as `4`. */
  version: 4 | 6
  /**
   * The canonical spelling: dotted decimal for IPv4, and for IPv6 the RFC 5952 form (lowercase,
   * no leading zeros, the longest run of two or more zero groups written as `::`).
   */
  address: string
  /** The address in network byte order: 4 bytes for IPv4, 16 for IPv6. */
  bytes: Uint8Array
}

/** The longest valid spelling, `ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255`. */
const MAX_ADDRESS_LENGTH = 45

const DOTTED_QUAD = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/
const IPV6_CHARACTERS = /^[0-9a-fA-F:.]+$/
const PREFIX_LENGTH = /^(0|[1-9]\d{0,2})$/

/**
 * Parse one IPv4 or IPv6 address.
 *
 * IPv4 must be four dotted decimal octets, each 0–255 with no leading zero (`010.0.0.1` is
 * refused: some parsers read it as octal). IPv6 takes any RFC 4291 text form, including `::`
 * compression and an embedded dotted quad. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) is
 * returned as the IPv4 address it carries, because it is that client.
 *
 * Returns `null` for anything else: a port (`192.0.2.1:80`, `[2001:db8::1]:80`), brackets, a zone
 * id (`fe80::1%eth0`), surrounding whitespace, a hostname, an empty string, or more than 45
 * characters.
 */
export function parseIp(input: string): ParsedIp | null {
  if (input.length === 0 || input.length > MAX_ADDRESS_LENGTH) return null
  const v4 = parseIpv4(input)
  if (v4) return fromIpv4(v4)
  if (!input.includes(":") || !IPV6_CHARACTERS.test(input)) return null
  // `parseIpv6Groups` is lenient about an embedded dotted quad (`::1.2.3.0004`); hold it to the
  // same rule as a bare IPv4 address.
  if (input.includes(".") && !parseIpv4(input.slice(input.lastIndexOf(":") + 1))) return null
  const groups = parseIpv6Groups(input)
  if (!groups) return null
  const bytes = new Uint8Array(16)
  groups.forEach((group, i) => {
    bytes[i * 2] = group >> 8
    bytes[i * 2 + 1] = group & 0xff
  })
  const mapped = bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff &&
    bytes[11] === 0xff
  if (mapped) return fromIpv4(bytes.slice(12))
  return { version: 6, address: formatIpv6(groups), bytes }
}

/** The canonical spelling of `input` ({@link parseIp}), or `null` when it is not an address. */
export function normalizeIp(input: string): string | null {
  return parseIp(input)?.address ?? null
}

/**
 * True when `ip` lies inside at least one of `cidrs`.
 *
 * `ip` goes through {@link parseIp}; anything it refuses is in no range, so the answer is `false`.
 * An IPv4-mapped IPv6 address counts as the IPv4 address it carries and is compared with IPv4
 * ranges only; write IPv4 ranges in IPv4 notation. An address is never compared with a range of
 * the other family.
 *
 * Each entry is `<address>/<prefix length>` (`104.16.0.0/13`, `2606:4700::/32`) or a bare address,
 * which means that one address. Bits after the prefix are ignored, so `10.0.0.1/8` is `10.0.0.0/8`.
 *
 * @throws {RangeError} when an entry is not a valid range. A typo in a trusted-proxy list must
 *   fail loudly, not quietly match nothing.
 */
export function ipInRanges(ip: string, cidrs: readonly string[]): boolean {
  const parsed = parseIp(ip)
  let found = false
  for (const cidr of cidrs) {
    const range = parseCidr(cidr)
    if (!found && parsed && range.bytes.length === parsed.bytes.length) {
      found = matchesPrefix(parsed.bytes, range.bytes, range.prefix)
    }
  }
  return found
}

interface Cidr {
  bytes: Uint8Array
  prefix: number
}

function parseCidr(cidr: string): Cidr {
  const slash = cidr.indexOf("/")
  const base = slash === -1 ? cidr : cidr.slice(0, slash)
  const bytes = parseIpv4(base) ?? parseIpv6Bytes(base)
  if (!bytes) throw new RangeError(`not an IP range: ${JSON.stringify(cidr)}`)
  const bits = bytes.length * 8
  if (slash === -1) return { bytes, prefix: bits }
  const prefixText = cidr.slice(slash + 1)
  const prefix = Number(prefixText)
  if (!PREFIX_LENGTH.test(prefixText) || prefix > bits) {
    throw new RangeError(`not an IP range: ${JSON.stringify(cidr)}`)
  }
  return { bytes, prefix }
}

/** An IPv6 range base as written, without folding a mapped address into IPv4. */
function parseIpv6Bytes(base: string): Uint8Array | null {
  const parsed = parseIp(base)
  if (!parsed) return null
  if (parsed.version === 6) return parsed.bytes
  if (!base.includes(":")) return null
  const bytes = new Uint8Array(16)
  bytes[10] = 0xff
  bytes[11] = 0xff
  bytes.set(parsed.bytes, 12)
  return bytes
}

function matchesPrefix(address: Uint8Array, base: Uint8Array, prefix: number): boolean {
  const whole = prefix >> 3
  for (let i = 0; i < whole; i++) {
    if (address[i] !== base[i]) return false
  }
  const rest = prefix & 7
  if (rest === 0) return true
  const mask = (0xff << (8 - rest)) & 0xff
  return (address[whole] & mask) === (base[whole] & mask)
}

function parseIpv4(text: string): Uint8Array | null {
  const match = DOTTED_QUAD.exec(text)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  if (octets.some((octet) => octet > 255)) return null
  return Uint8Array.from(octets)
}

function fromIpv4(bytes: Uint8Array): ParsedIp {
  return { version: 4, address: Array.from(bytes).join("."), bytes }
}

/** RFC 5952 §4: lowercase hex, no leading zeros, the longest (first on a tie) zero run of two
 * or more groups compressed to `::`. */
function formatIpv6(groups: number[]): string {
  let bestStart = -1
  let bestLength = 1
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let end = i
    while (end < 8 && groups[end] === 0) end++
    if (end - i > bestLength) {
      bestStart = i
      bestLength = end - i
    }
    i = end
  }
  const hex = groups.map((group) => group.toString(16))
  if (bestStart === -1) return hex.join(":")
  const head = hex.slice(0, bestStart).join(":")
  const tail = hex.slice(bestStart + bestLength).join(":")
  return `${head}::${tail}`
}
