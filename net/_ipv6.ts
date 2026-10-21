/**
 * IPv6 text parsing shared by `url-policy.ts` and `ip.ts`.
 *
 * Its own module so neither of those two imports the other: `url-policy.ts` classifies addresses
 * with `ip.ts`, and `ip.ts` parses IPv6 with this. `url-policy.ts` re-exports `parseIpv6Groups`
 * under its published name.
 * @module
 */

/**
 * Parse an IPv6 address into 8 groups of 16-bit unsigned ints.
 * Accepts `::` compression and dotted-quad suffix (`::ffff:127.0.0.1`).
 * Returns null on malformed input.
 */
export function parseIpv6Groups(addr: string): number[] | null {
  if (!addr) return null
  // Strip zone IDs (`fe80::1%eth0`) — we don't make policy decisions on them.
  const pct = addr.indexOf("%")
  const clean = pct === -1 ? addr : addr.slice(0, pct)
  if (!clean) return null

  // Promote embedded IPv4 to two 16-bit groups in hex form so the rest of
  // the parser only has to deal with plain hex groups.
  let normalised = clean
  if (clean.includes(".")) {
    const lastColon = clean.lastIndexOf(":")
    if (lastColon === -1) return null
    const ipv4 = clean.slice(lastColon + 1)
    const octets = ipv4.split(".")
    if (octets.length !== 4) return null
    const nums: number[] = []
    for (const o of octets) {
      if (!/^\d+$/.test(o)) return null
      const n = Number(o)
      if (n < 0 || n > 255) return null
      nums.push(n)
    }
    const hi = (nums[0] << 8) | nums[1]
    const lo = (nums[2] << 8) | nums[3]
    normalised = clean.slice(0, lastColon + 1) +
      hi.toString(16) + ":" + lo.toString(16)
  }

  const dc = normalised.indexOf("::")
  if (dc !== -1) {
    if (normalised.indexOf("::", dc + 1) !== -1) return null
    const left = normalised.slice(0, dc)
    const right = normalised.slice(dc + 2)
    const leftGroups = left === "" ? [] : left.split(":")
    const rightGroups = right === "" ? [] : right.split(":")
    if (leftGroups.length + rightGroups.length > 7) return null
    const out: number[] = new Array(8).fill(0)
    let i = 0
    for (const g of leftGroups) {
      const n = parseHexGroup(g)
      if (n === null) return null
      out[i++] = n
    }
    const skip = 8 - leftGroups.length - rightGroups.length
    i += skip
    for (const g of rightGroups) {
      const n = parseHexGroup(g)
      if (n === null) return null
      out[i++] = n
    }
    return out
  }

  const parts = normalised.split(":")
  if (parts.length !== 8) return null
  const out: number[] = []
  for (const p of parts) {
    const n = parseHexGroup(p)
    if (n === null) return null
    out.push(n)
  }
  return out
}

function parseHexGroup(g: string): number | null {
  if (g.length === 0 || g.length > 4) return null
  if (!/^[0-9a-fA-F]+$/.test(g)) return null
  return parseInt(g, 16)
}
