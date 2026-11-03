/**
 * {@link resolveDns} and {@link resolveTxt}: one DNS lookup, on Deno, Node and Bun.
 *
 * `node:dns/promises` is imported on the first lookup on Node or Bun, never at import time, so
 * Deno code never loads it and its type check never sees Node's types.
 *
 * @example
 * ```ts
 * const v4 = await resolveDns("example.com", "A")
 * const v6 = await resolveDns("example.com", "AAAA")
 * const txt = await resolveTxt("example.com")
 * ```
 *
 * @module
 */

import {
  type AddressRecordType,
  type DnsHost,
  type DnsLookupOptions,
  dnsResolverOver,
  type NodeDns,
  txtResolverOver,
} from "./_dns-host.ts"

export type { AddressRecordType, DnsLookupOptions } from "./_dns-host.ts"

/**
 * The addresses of `hostname`'s `A` or `AAAA` records: `Deno.resolveDns` on Deno,
 * `node:dns/promises` on Node and Bun.
 *
 * A name with no record of that type, or no such name, resolves to an empty list. Every other
 * failure (a timeout, a refused or broken answer) rejects, so a caller can tell "no address" from
 * "could not tell". An aborted `signal` rejects with its reason. On Deno it needs `--allow-net`.
 */
export function resolveDns(
  hostname: string,
  type: AddressRecordType,
  options?: DnsLookupOptions,
): Promise<string[]> {
  return lookupAddress(hostname, type, options)
}

/**
 * `hostname`'s `TXT` records, one array per record holding its strings as they came, unjoined:
 * `Deno.resolveDns(hostname, "TXT")` on Deno, `node:dns/promises` on Node and Bun, which answer
 * in that same shape.
 *
 * A name with no `TXT` record, or no such name, resolves to an empty list; every other failure
 * rejects, as for {@link resolveDns}. On Deno it needs `--allow-net`.
 */
export function resolveTxt(hostname: string, options?: DnsLookupOptions): Promise<string[][]> {
  return lookupTxt(hostname, options)
}

const host = () => globalThis as unknown as DnsHost
// The specifier is not a literal, so `deno check` does not pull `@types/node` into every program
// that imports this module: that retypes `setTimeout` as returning a `Timeout` and breaks code that
// stores its handle as a `number` (`server/db/testing/node-sqlite-driver.ts` measured the same).
const loadNodeDns = () => import(["node", "dns/promises"].join(":")) as Promise<NodeDns>
const lookupAddress = dnsResolverOver(host, loadNodeDns)
const lookupTxt = txtResolverOver(host, loadNodeDns)
