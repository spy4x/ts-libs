/**
 * {@link resolveDns}: one DNS lookup of an address record, on Deno, Node and Bun.
 *
 * `node:dns/promises` is imported on the first lookup on Node or Bun, never at import time, so
 * Deno code never loads it and its type check never sees Node's types.
 *
 * @example
 * ```ts
 * const v4 = await resolveDns("example.com", "A")
 * const v6 = await resolveDns("example.com", "AAAA")
 * ```
 *
 * @module
 */

import { type AddressRecordType, type DnsHost, dnsResolverOver, type NodeDns } from "./_dns-host.ts"

export type { AddressRecordType } from "./_dns-host.ts"

/**
 * The addresses of `hostname`'s `A` or `AAAA` records: `Deno.resolveDns` on Deno,
 * `node:dns/promises` on Node and Bun.
 *
 * A name with no record of that type, or no such name, resolves to an empty list. Every other
 * failure (a timeout, a refused or broken answer) rejects, so a caller can tell "no address" from
 * "could not tell". On Deno it needs `--allow-net`.
 */
export function resolveDns(hostname: string, type: AddressRecordType): Promise<string[]> {
  return lookup(hostname, type)
}

// The specifier is not a literal, so `deno check` does not pull `@types/node` into every program
// that imports this module: that retypes `setTimeout` as returning a `Timeout` and breaks code that
// stores its handle as a `number` (`server/db/testing/node-sqlite-driver.ts` measured the same).
const lookup = dnsResolverOver(
  () => globalThis as unknown as DnsHost,
  () => import(["node", "dns/promises"].join(":")) as Promise<NodeDns>,
)
