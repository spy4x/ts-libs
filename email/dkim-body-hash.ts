/**
 * Caches a message body's canonical-octet hash per canonicalisation mode and
 * `l=` bound, for the lifetime of one verification call.
 *
 * RFC 6376 §6.1 verifies every `DKIM-Signature` field independently, but
 * almost every real message signs the body once, however many fields it
 * carries. `createBodyHashCache` gives every field of one message a shared
 * cache keyed by `c=` and `l=`, so the canonicalisation pass and the digest
 * each run at most once per distinct combination the message asks for.
 *
 * A module of its own so a test can import this seam directly. It is internal
 * to the package: not in `email/deno.json`'s `exports` map and not
 * re-exported by `mod.ts`; the DKIM verifier imports it as a sibling module.
 */

/** Canonicalisation modes RFC 6376 §3.4 defines for a body. */
type BodyCanonicalization = "simple" | "relaxed"

/**
 * What {@link createBodyHashCache} needs injected. Dependency injection here
 * is what lets a test count real canonicalisation and hashing passes without
 * reaching into module-private state, and it keeps this file free of any
 * opinion about which canonicaliser or digest `dkim-verify.ts` uses.
 */
export interface BodyHashDependencies {
  /** Canonicalise the whole body once, for one mode. */
  canonicalize: (algorithm: BodyCanonicalization) => string
  /** Turn a canonical string into the exact octets that get hashed. */
  encode: (canonical: string) => Uint8Array
  /** Digest a byte slice, base64-encoded. */
  digest: (bytes: Uint8Array) => Promise<string>
}

/** One `c=`/`l=` combination's body hash, plus what {@link DkimBodyCoverage} needs. */
export interface BodyHashResult {
  hash: string
  signedOctets: number
  totalOctets: number
}

export interface BodyHashCache {
  /**
   * The hash and octet counts for one canonicalisation mode and `l=` bound,
   * computed at most once no matter how many times it is asked for.
   */
  get(algorithm: BodyCanonicalization, bodyLength: number | undefined): Promise<BodyHashResult>
}

/**
 * Build one cache for one message. `deps.canonicalize` runs at most once per
 * distinct `algorithm` value that {@link BodyHashCache.get} is called with,
 * however many `(algorithm, bodyLength)` pairs share it; `deps.digest` runs
 * at most once per distinct pair.
 *
 * Two concurrent `get` calls for the same pair, before the first resolves,
 * share the one pending computation rather than starting a second: the cache
 * stores the `Promise`, not just its eventual result.
 */
export function createBodyHashCache(deps: BodyHashDependencies): BodyHashCache {
  const canonicalBytes = new Map<BodyCanonicalization, Uint8Array>()
  const results = new Map<string, Promise<BodyHashResult>>()

  function bytesFor(algorithm: BodyCanonicalization): Uint8Array {
    let bytes = canonicalBytes.get(algorithm)
    if (bytes === undefined) {
      bytes = deps.encode(deps.canonicalize(algorithm))
      canonicalBytes.set(algorithm, bytes)
    }
    return bytes
  }

  return {
    get(algorithm, bodyLength) {
      const key = `${algorithm}:${bodyLength ?? "*"}`
      let pending = results.get(key)
      if (pending === undefined) {
        pending = (async () => {
          const canonical = bytesFor(algorithm)
          const signedOctets = bodyLength === undefined
            ? canonical.length
            : Math.min(bodyLength, canonical.length)
          const slice = signedOctets === canonical.length
            ? canonical
            : canonical.slice(0, signedOctets)
          const hash = await deps.digest(slice)
          return { hash, signedOctets, totalOctets: canonical.length }
        })()
        results.set(key, pending)
      }
      return pending
    },
  }
}
