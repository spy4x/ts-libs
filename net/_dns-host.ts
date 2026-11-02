/**
 * The runtime lookup behind `./dns.ts`, written over an injected host object so a unit test can
 * drive the Deno, Node and Bun branches without the runtime it is running on. It follows the host
 * pattern of `@spy4x/platform/server/process`, which this package cannot import: `@spy4x/platform`
 * already depends on `@spy4x/net`.
 *
 * Not an entry point: nothing here is exported from the package.
 *
 * @module
 */

/** The address record types a lookup asks for. */
export type AddressRecordType = "A" | "AAAA"

/** The globals a lookup reads: `Deno` on Deno, `process` on Node and Bun. */
export interface DnsHost {
  Deno?: { resolveDns?(hostname: string, type: AddressRecordType): Promise<string[]> }
  process?: unknown
}

/** The members of `node:dns/promises` a lookup calls. */
export interface NodeDns {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

/** Node's codes for a name with no record of the type (`ENODATA`) or no name at all (`ENOTFOUND`). */
const NODE_NOT_FOUND = new Set(["ENODATA", "ENOTFOUND"])

/**
 * `resolveDns` of `./dns.ts` over `host`, with `loadNodeDns` standing in for `node:dns/promises`.
 * Deno is asked first, since Deno 2 also defines `process`.
 */
export function dnsResolverOver(
  host: () => DnsHost,
  loadNodeDns: () => Promise<NodeDns>,
): (hostname: string, type: AddressRecordType) => Promise<string[]> {
  return async (hostname, type) => {
    const { Deno, process } = host()
    try {
      if (Deno) {
        if (!Deno.resolveDns) throw new Error("no DNS: this Deno has no Deno.resolveDns")
        return await Deno.resolveDns(hostname, type)
      }
      if (!process) throw new Error("unsupported runtime: neither Deno nor process is defined")
      const dns = await loadNodeDns()
      return await (type === "A" ? dns.resolve4(hostname) : dns.resolve6(hostname))
    } catch (error) {
      // Deno's `NotFound` and Node's two codes all mean the same: no record of this type.
      if ((error as Error | null)?.name === "NotFound") return []
      if (NODE_NOT_FOUND.has((error as { code?: string } | null)?.code ?? "")) return []
      throw error
    }
  }
}
