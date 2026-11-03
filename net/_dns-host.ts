/**
 * The runtime lookups behind `./dns.ts`, written over an injected host object so a unit test can
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

/** Options of one DNS lookup. */
export interface DnsLookupOptions {
  /** Abandons the lookup: it rejects with the signal's reason. */
  signal?: AbortSignal
}

/** The globals a lookup reads: `Deno` on Deno, `process` on Node and Bun. */
export interface DnsHost {
  Deno?: {
    resolveDns?(
      hostname: string,
      type: AddressRecordType | "TXT",
      options?: DnsLookupOptions,
    ): Promise<string[] | string[][]>
  }
  process?: unknown
}

/** The members of `node:dns/promises` a lookup calls. */
export interface NodeDns {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  resolveTxt(hostname: string): Promise<string[][]>
}

/** Node's codes for a name with no record of the type (`ENODATA`) or no name at all (`ENOTFOUND`). */
const NODE_NOT_FOUND = new Set(["ENODATA", "ENOTFOUND"])

/**
 * One lookup over `host`, with `loadNodeDns` standing in for `node:dns/promises`: `onDeno` with
 * `Deno.resolveDns`, `onNode` with Node's module. Deno is asked first, since Deno 2 also defines
 * `process`. No record of the type, or no such name, answers `[]`; every other failure rejects.
 */
async function lookUp<T>(
  host: () => DnsHost,
  loadNodeDns: () => Promise<NodeDns>,
  signal: AbortSignal | undefined,
  onDeno: (resolveDns: NonNullable<NonNullable<DnsHost["Deno"]>["resolveDns"]>) => Promise<T[]>,
  onNode: (dns: NodeDns) => Promise<T[]>,
): Promise<T[]> {
  const { Deno, process } = host()
  try {
    signal?.throwIfAborted()
    if (Deno) {
      if (!Deno.resolveDns) throw new Error("no DNS: this Deno has no Deno.resolveDns")
      return await onDeno(Deno.resolveDns.bind(Deno))
    }
    if (!process) throw new Error("unsupported runtime: neither Deno nor process is defined")
    const dns = await loadNodeDns()
    // Node's module takes no signal: an abort stops the wait, and the answer is dropped.
    return await untilAborted(onNode(dns), signal)
  } catch (error) {
    // Deno's `NotFound` and Node's two codes all mean the same: no record of this type.
    if ((error as Error | null)?.name === "NotFound") return []
    if (NODE_NOT_FOUND.has((error as { code?: string } | null)?.code ?? "")) return []
    throw error
  }
}

/** `promise`, or a rejection with the signal's reason once `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    // The signal may have aborted while `node:dns/promises` loaded: its event has fired already.
    if (signal.aborted) return reject(signal.reason)
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** `resolveDns` of `./dns.ts` over `host`, with `loadNodeDns` standing in for `node:dns/promises`. */
export function dnsResolverOver(
  host: () => DnsHost,
  loadNodeDns: () => Promise<NodeDns>,
): (hostname: string, type: AddressRecordType, options?: DnsLookupOptions) => Promise<string[]> {
  return (hostname, type, options) =>
    lookUp(
      host,
      loadNodeDns,
      options?.signal,
      (resolveDns) => resolveDns(hostname, type, options) as Promise<string[]>,
      (dns) => type === "A" ? dns.resolve4(hostname) : dns.resolve6(hostname),
    )
}

/** `resolveTxt` of `./dns.ts` over `host`, with `loadNodeDns` standing in for `node:dns/promises`. */
export function txtResolverOver(
  host: () => DnsHost,
  loadNodeDns: () => Promise<NodeDns>,
): (hostname: string, options?: DnsLookupOptions) => Promise<string[][]> {
  return (hostname, options) =>
    lookUp(
      host,
      loadNodeDns,
      options?.signal,
      (resolveDns) => resolveDns(hostname, "TXT", options) as Promise<string[][]>,
      async (dns) => {
        const records = await dns.resolveTxt(hostname)
        const versions = (host().process as { versions?: { bun?: string } }).versions
        return versions?.bun === undefined ? records : rejoinSplitTxt(records)
      },
    )
}

/** The most octets one string of a TXT record holds (RFC 1035 §3.3, `<character-string>`). */
const TXT_STRING_MAX = 255

/**
 * Bun (1.4.4) answers each string of a TXT record as a record of its own, where Node and Deno keep
 * a record's strings together: a 2048-bit DKIM key, published as two strings of one record, comes
 * back as two records, and neither parses. A long value is split into strings of the most a string
 * holds, so a string of that length is joined with the ones after it until a shorter one ends the
 * record. Records are left as they are when any of them has more than one string: that is the
 * shape of an answer this bug did not flatten.
 */
export function rejoinSplitTxt(records: string[][]): string[][] {
  if (records.some((record) => record.length !== 1)) return records
  const joined: string[][] = []
  let open: string[] | undefined
  for (const [text] of records) {
    if (open === undefined) joined.push(open = [])
    open.push(text)
    if (text.length < TXT_STRING_MAX) open = undefined
  }
  return joined
}
