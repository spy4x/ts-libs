// DKIM verifier, step 3: parse and fetch the public key record (RFC 6376 §3.6).

import { decodeBase64 } from "@std/encoding"
import { resolveTxt } from "@spy4x/net/dns"
import { scanTagList } from "./dkim-signature.ts"
import { DkimParseError, type DkimPublicKey, type DkimVerifyOptions } from "./dkim-types.ts"

/**
 * Parse a DKIM TXT record's `p=` field into a public key. The record must
 * already be concatenated and dequoted per RFC 6376 §3.6.2.2.
 *
 * Returns `null` when the key is revoked — `p=` present but empty. Throws
 * {@link DkimParseError} on a missing `p=`, an unknown `k=`, an unknown `v=`, a
 * `v=` that is not the first tag, an empty `h=` or `s=` list, a repeated tag, or
 * a `p=` whose base64 does not decode.
 *
 * The restriction tags — `h=`, `s=`, `t=` — are read here and applied by
 * {@link verifyDkim}, which is the only place that knows which hash the
 * signature used and that the service is email.
 */
export function parseDkimPublicKey(txtRecord: string): DkimPublicKey | null {
  const tags = scanTagList(txtRecord)
  // §3.6.1: "v= ... MUST be the first tag in the record", and the only value it
  // defines is DKIM1. A record from a future version is not one this verifier
  // may guess at, so it is a syntax error rather than an ignored tag.
  const version = tags.get("v")?.value
  if (version !== undefined) {
    if (version !== "DKIM1") {
      throw new DkimParseError(`unsupported DKIM key record version: ${version}`)
    }
    if ([...tags.keys()][0] !== "v") {
      throw new DkimParseError("DKIM TXT record v= tag must come first")
    }
  }
  if (!tags.has("p")) {
    throw new DkimParseError("DKIM TXT record has no p= tag")
  }
  const p = tags.get("p")!.value
  // `p=` with no value is how RFC 6376 §3.6.1 revokes a key; a `p=` that was
  // never there at all is a malformed record and was rejected above.
  if (p === "") return null
  const algorithm = (tags.get("k")?.value ?? "rsa").toLowerCase()
  if (algorithm !== "rsa" && algorithm !== "ed25519") {
    throw new DkimParseError(`unsupported DKIM key algorithm: ${algorithm}`)
  }
  return {
    algorithm,
    keyBytes: base64Decode(p),
    version,
    hashAlgorithms: parseRecordList(tags.get("h")?.value, "h"),
    serviceTypes: parseRecordList(tags.get("s")?.value, "s"),
    flags: parseRecordList(tags.get("t")?.value, "t"),
  }
}

/**
 * Split a colon-separated key-record list (`h=`, `s=`, `t=`) into lowercase
 * entries, or `undefined` when the tag is absent.
 *
 * A tag that is present but lists nothing is a syntax error rather than "no
 * restriction": `s=` names the service types the key may be used for, and reading
 * an empty list as "any" would turn a typo into a wider permission.
 */
function parseRecordList(value: string | undefined, tag: string): string[] | undefined {
  if (value === undefined) return undefined
  const entries = value.toLowerCase().split(":").map((entry) => entry.replace(/[ \t]+/g, ""))
    .filter(Boolean)
  if (entries.length === 0) {
    throw new DkimParseError(`DKIM TXT record ${tag}= tag is empty`)
  }
  return entries
}

/**
 * Fetch and parse a DKIM public key from DNS, from
 * `<selector>._domainkey.<domain>`.
 *
 * The resolver defaults to `resolveTxt` of `@spy4x/net/dns` (Deno, Node and
 * Bun; `--allow-net` on Deno), which answers a name with no TXT record, or no
 * such name, with no record. A resolver that returns no record causes a
 * {@link DkimParseError} rather than a missing-key result, so a resolver bug
 * cannot be mistaken for a revoked key. Resolver failures are not swallowed.
 */
export async function fetchDkimPublicKey(
  domain: string,
  selector: string,
  options: DkimVerifyOptions = {},
): Promise<DkimPublicKey | null> {
  assertDnsLabels(domain, "d=")
  assertDnsLabels(selector, "s=")
  const name = `${selector}._domainkey.${domain}`
  const { resolveTxt = defaultResolveTxt } = options.resolver ?? {}
  const records = await resolveTxt(name)
  // §3.6.2.2: concatenate the strings of *one* record, with no separator — a long
  // key is published as several strings of one record and joining them with
  // anything at all corrupts it. §3.6.2.2 also leaves the order of several
  // records unspecified, so an unrelated TXT record at the front is not an
  // answer: each record is tried and the first one that parses is the key. When
  // none parses, the first record's own error is what the caller sees.
  if (records.length === 0) return parseDkimPublicKey("")
  let firstError: unknown
  for (const record of records) {
    try {
      return parseDkimPublicKey(record.join(""))
    } catch (err) {
      firstError ??= err
    }
  }
  throw firstError
}

/**
 * Reject a domain or selector that is not a dot-separated run of RFC 5321
 * `sub-domain` labels, before it is interpolated into a query name.
 *
 * `d=` and `s=` come from the message, and an injected resolver may put the name
 * into a URL (DNS over HTTPS) or a command line. Letters, digits and interior
 * hyphens are all RFC 6376 §3.1's grammar allows, so anything else is a
 * malformed signature rather than a name to look up.
 */
function assertDnsLabels(value: string, tag: string): void {
  const labels = value.split(".")
  const valid = labels.length > 0 &&
    labels.every((label) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))
  if (!valid) {
    throw new DkimParseError(`DKIM ${tag} tag is not a domain name: ${JSON.stringify(value)}`)
  }
}

function defaultResolveTxt(name: string): Promise<string[][]> {
  return resolveTxt(name)
}

export function base64Decode(input: string): Uint8Array {
  // Strip WSP: a folded b=/bh= and a TXT record split across quoted strings
  // both leave whitespace inside the base64.
  try {
    return decodeBase64(input.replace(/\s+/g, ""))
  } catch {
    throw new DkimParseError("value is not valid base64")
  }
}
