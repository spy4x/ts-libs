// Tests for the RFC 6376 verifier.
//
// Two independent sources of truth, neither of which is this package:
//
//  1. `fixtures/` — messages signed with dkimpy 1.1.8's canonicalizers plus
//     `openssl dgst -sha256 -sign`, every one asserted valid by dkimpy itself.
//     The RFC 6376 example *message*, re-signed in 2018 with a published key, is
//     among them. These catch a verifier that agrees only with itself, which is
//     exactly how the first port of this file shipped a canonicalization bug
//     behind a green suite.
//  2. `sign()` below — a deliberately hand-written second implementation of
//     §3.4 canonicalization and §3.7 hash steps, used for the tamper cases. It
//     shares no code with `dkim-verify.ts`: importing the module's own
//     canonicalizers would make "valid" prove only that two copies of one
//     mistake agree.
//
// Nothing here touches the network. Keys are fixture records or generated
// in-process by Web Crypto; no private key is committed.

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  canonicalizeBody,
  canonicalizeHeader,
  DEFAULT_MAX_MESSAGE_LENGTH,
  DEFAULT_MAX_SIGNATURES,
  DkimParseError,
  type DkimPublicKey,
  type DnsTxtResolver,
  fetchDkimPublicKey,
  parseDkimPublicKey,
  parseDkimSignature,
  sha256Base64,
  splitMessage,
  verifyDkim,
  verifyDkimSignatures,
} from "./dkim-verify.ts"

const FIXTURE_DIR = new URL("./fixtures/", import.meta.url)

async function fixture(name: string): Promise<{ raw: string; record: string }> {
  const raw = await Deno.readTextFile(new URL(`${name}.msg`, FIXTURE_DIR))
  const record = (await Deno.readTextFile(new URL(`${name}.key`, FIXTURE_DIR))).trim()
  return { raw, record }
}

/**
 * Rename the message's DKIM-Signature field, changing nothing else.
 *
 * RFC 6376 §3.7 step 2 hashes "the DKIM-Signature header field that exists" in
 * the message, and §3.4.1's simple canonicalization keeps the name's case, so
 * the field name is signed bytes under `c=…/simple`.
 */
function renameSignatureField(raw: string, name: string): string {
  const at = raw.toLowerCase().indexOf("dkim-signature:")
  if (at === -1) throw new Error("fixture has no DKIM-Signature field")
  return raw.slice(0, at) + `${name}:` + raw.slice(at + "dkim-signature:".length)
}

/** Offset at which the signature field starts, found by name, never by index. */
function signatureFieldStart(raw: string): number {
  const at = raw.toLowerCase().indexOf("dkim-signature:")
  if (at === -1) throw new Error("message has no DKIM-Signature field")
  return at
}

/** Offset just past the header field beginning at `at`, folded lines included. */
function endOfField(raw: string, at: number): number {
  let pos = at
  for (;;) {
    const eol = raw.indexOf("\r\n", pos)
    if (eol === -1) return raw.length
    pos = eol + 2
    if (raw[pos] !== " " && raw[pos] !== "\t") return pos
  }
}

/**
 * Append `payload` to the message's DKIM-Signature field itself, so the payload
 * lands inside the bytes §3.7 step 2 hashes.
 *
 * The field is located by name: the whole point of these attacks is *which*
 * field they extend, and a line index silently follows a fixture that inserted
 * a field above it — which is how these cases were passing against `From:`.
 */
function appendToSignatureField(raw: string, payload: string): string {
  const end = endOfField(raw, signatureFieldStart(raw))
  // `end` sits just past the field's closing CRLF — for the signature field, which
  // is the last field of these messages, that is the CRLF before the empty line.
  // The payload belongs inside the field, so it goes before it; inserting at
  // `end` would open the body with it instead.
  const contentEnd = raw.slice(end - 2, end) === "\r\n" ? end - 2 : end
  return raw.slice(0, contentEnd) + payload + raw.slice(contentEnd)
}

/**
 * Add a second instance of `field` to a message that was already signed. Both
 * positions are outside the bytes the signature covers; only §5.4.2's "the
 * message grew a field of a name h= consumed" check can see them.
 */
function injectHeader(raw: string, field: string, where: "top" | "below-signature"): string {
  const injected = `${field}: injected\r\n`
  if (where === "top") return injected + raw
  const end = endOfField(raw, signatureFieldStart(raw))
  return raw.slice(0, end) + injected + raw.slice(end)
}

// --- an independent signer, written from the RFC text -----------------------

/** §3.4.1 simple / §3.4.2 relaxed, written independently of the module. */
function canonHeader(name: string, value: string, mode: string): string {
  if (mode === "simple") return `${name}:${value}\r\n`
  const unfolded = value.replace(/\r?\n/g, "")
  const squashed = unfolded.replace(/[ \t]+/g, " ")
  return `${name.toLowerCase().replace(/[ \t]+/g, "")}:${squashed.trim()}\r\n`
}

/** §3.4.3 simple / §3.4.4 relaxed, written independently of the module. */
function canonBody(body: string, mode: string): string {
  const crlf = body.replace(/\r\n|\r|\n/g, "\r\n")
  if (mode === "simple") {
    const trimmed = crlf.replace(/(?:\r\n)+$/, "")
    return trimmed === "" ? "\r\n" : `${trimmed}\r\n`
  }
  const lines = crlf.replace(/[ \t]+\r\n/g, "\r\n").replace(/[ \t]+/g, " ")
  const trimmed = lines.replace(/(?:\r\n)+$/, "")
  return trimmed === "" ? "" : `${trimmed}\r\n`
}

function ascii(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code > 0xff) throw new Error("signer helper handles single-byte text only")
    out[i] = code
  }
  return out
}

function base64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const rsaPairs = new Map<string, Promise<CryptoKeyPair>>()
const ed25519Pairs = new Map<string, Promise<CryptoKeyPair>>()

/**
 * Memoised RSA pair, generated in-process; 2048 bits unless asked otherwise.
 *
 * `slot` selects the pair: "primary" is the one messages are signed with, any
 * other slot is a second key of the same shape — which is what a wrong-key test
 * needs, since a key of the *other* algorithm never reaches the crypto.
 * `modulusLength` is what the RFC 8301 floor is tested with, and it is part of
 * the memo key, so a short key can never stand in for the ordinary one.
 */
function rsa(slot = "primary", modulusLength = 2048): Promise<CryptoKeyPair> {
  const memo = `${slot}:${modulusLength}`
  let pair = rsaPairs.get(memo)
  if (!pair) {
    pair = crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    ) as Promise<CryptoKeyPair>
    rsaPairs.set(memo, pair)
  }
  return pair
}

/** Memoised Ed25519 pair, generated in-process; `slot` as in {@link rsa}. */
function ed25519(slot = "primary"): Promise<CryptoKeyPair> {
  let pair = ed25519Pairs.get(slot)
  if (!pair) {
    pair = crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ]) as Promise<CryptoKeyPair>
    ed25519Pairs.set(slot, pair)
  }
  return pair
}

async function rsaKey(pair: CryptoKeyPair): Promise<DkimPublicKey> {
  // The platform's SPKI export is a shape §3.6.1 permits, so it is used as-is.
  const exported = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  return parseDkimPublicKey(`v=DKIM1; k=rsa; p=${base64(exported)}`)!
}

async function ed25519Key(pair: CryptoKeyPair): Promise<DkimPublicKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return parseDkimPublicKey(`v=DKIM1; k=ed25519; p=${base64(raw)}`)!
}

/** Insert WSP into a base64 value at `at`, standing in for a signer's folding. */
function spliceWsp(value: string, wsp: { at: number; kind: "fold" | "space" }): string {
  const inserted = wsp.kind === "fold" ? "\r\n\t" : " "
  return value.slice(0, wsp.at) + inserted + value.slice(wsp.at)
}

interface SignOptions {
  mode?: "simple" | "relaxed"
  /** The body half of `c=` when it differs from `mode`: a mixed `c=` value. */
  bodyMode?: "simple" | "relaxed"
  /** Header names to sign, in h= order. */
  names?: string[]
  /** Extra tags before b=, e.g. `l=17` or `x=1800000000`. */
  extraTags?: string
  /** Tags placed *after* b=, which §3.7 step 2 leaves inside the signed bytes. */
  afterB?: string
  /**
   * Put WSP inside the `bh=` value at `at`, as §3.5 invites a signer to do when
   * the value reaches the folding column: `"fold"` inserts CRLF + HTAB, `"space"`
   * a single SP. The message is signed *after* the insertion, so the WSP is part
   * of the bytes the signature covers — a vector a real signer emits, rather than
   * an already-signed message edited afterwards.
   */
  bodyHashWsp?: { at: number; kind: "fold" | "space" }
  ed25519?: boolean
  foldSignature?: boolean
  /** Modulus length of the RSA pair to sign with. Defaults to 2048. */
  rsaBits?: number
}

/**
 * Sign a message the way §3.7 says to: hash every header named in `h=` in that
 * order, then the DKIM-Signature field with its `b=` value deleted and without a
 * trailing CRLF, then sign that. The body hash lives in the field's own `bh=`
 * tag, so nothing is appended after the field.
 */
async function sign(
  headers: string[],
  body: string,
  options: SignOptions = {},
): Promise<{ raw: string; publicKey: DkimPublicKey; publicKeyRecord: string; input: string }> {
  const mode = options.mode ?? "relaxed"
  // §3.4 gives c= a header half and a body half, and they need not match.
  const bodyMode = options.bodyMode ?? mode
  const names = options.names ?? ["from", "to", "subject"]
  const bodyHash = await sha256Base64(canonBody(body, bodyMode))
  const signedBodyHash = options.bodyHashWsp ? spliceWsp(bodyHash, options.bodyHashWsp) : bodyHash
  const stub = `v=1; a=${options.ed25519 ? "ed25519-sha256" : "rsa-sha256"}; ` +
    `c=${mode}/${bodyMode}; d=example.com; s=sel; h=${names.join(":")}; bh=${signedBodyHash}` +
    (options.extraTags ? `; ${options.extraTags}` : "")

  const used = new Map<string, number>()
  const head: string[] = []
  for (const name of names) {
    const seen = used.get(name) ?? 0
    const matching = headers.filter((h) => h.slice(0, h.indexOf(":")).toLowerCase() === name)
    if (seen >= matching.length) continue // §3.5: absent names contribute nothing
    used.set(name, seen + 1)
    // §5.4.2: instances are signed from the bottom of the block upwards.
    const header = matching[matching.length - 1 - seen]
    const colon = header.indexOf(":")
    head.push(canonHeader(header.slice(0, colon), header.slice(colon + 1), mode))
  }
  // The value of a header field starts after the colon, so it carries the WSP
  // that followed it. Simple canonicalization keeps that byte verbatim (dkimpy:
  // `DKIM-Signature: v=1; …`), and relaxed mode strips it again, so one call
  // shape serves both modes.
  const tail = options.afterB ?? ""
  const field = canonHeader("DKIM-Signature", ` ${stub}; b=${tail}`, mode).replace(/\r\n$/, "")
  const input = head.join("") + field

  const pair = options.ed25519 ? await ed25519() : await rsa("primary", options.rsaBits)
  let message = ascii(input)
  if (options.ed25519) {
    // RFC 8463 §3: Ed25519 DKIM signs SHA-256 of the canonicalized input, not
    // the input itself. Signing the raw input here certified this file's own
    // convention and hid the bug it was meant to catch.
    message = new Uint8Array(await crypto.subtle.digest("SHA-256", message))
  }
  const signature = new Uint8Array(
    options.ed25519
      ? await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message)
      : await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pair.privateKey, message),
  )

  const rendered = `${stub}; b=${base64(signature)}${tail}`
  const block = options.foldSignature ? rendered.replace(/; /g, "; \r\n\t") : rendered
  const publicKey = options.ed25519
    ? await ed25519Key(await ed25519())
    : await rsaKey(await rsa("primary", options.rsaBits))
  return {
    raw: `${[...headers, `DKIM-Signature: ${block}`].join("\r\n")}\r\n\r\n${body}`,
    publicKey,
    publicKeyRecord: `v=DKIM1; k=${publicKey.algorithm}; p=${base64(publicKey.keyBytes)}`,
    input,
  }
}

const TEST_HEADERS = [
  "From: Sender <sender@example.com>",
  "To: recipient@example.org",
  "Subject: DKIM port smoke test",
]

// --- RFC 6376's own examples -----------------------------------------------

describe("RFC 6376 examples", () => {
  it("verifies the RFC 6376 §3.5 example message re-signed by dkimpy in 2018", async () => {
    // The title states the provenance because the old one ("the RSA-signed
    // example from §3.5") claimed the RFC's *printed* signature, which cannot be
    // verified at all — its private key is unpublished, as `fixtures/SOURCES.md`
    // records. The vector is dkimpy's 2018 re-signature of the RFC's example
    // message, and `t=` is what distinguishes the two, so it is pinned here
    // rather than left to a comment: a fixture swapped for any other RSA-signed
    // message would otherwise keep the test name honest but the claim false.
    const { raw, record } = await fixture("rfc6376-rsa")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.domain, "football.example.com")
    assertEquals(result.parsed?.selector, "test")
    assertEquals(result.parsed?.timestamp, 1527915362n)
    assertEquals(result.parsed?.canonicalization, { header: "simple", body: "simple" })
  })

  it("verifies RFC 8463's Appendix A.3 Ed25519 example", async () => {
    // The only Ed25519 vector from a standards document that is available
    // offline. It verifies solely over SHA-256 of the canonical input, so it
    // fails against any implementation that feeds the raw input instead.
    const { raw, record } = await fixture("rfc8463-a3")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.algorithm, "ed25519-sha256")
    assertEquals(result.parsed?.selector, "brisbane")
    // A.3 also carries an RSA signature over the same message.
    assert(result.computedBodyHash === result.parsed?.bodyHash)
  })

  it("verifies the same example with CRLF rather than LF endings", async () => {
    const { raw, record } = await fixture("rfc6376-rsa-crlf")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("hashes the example body to the hash the example publishes", async () => {
    const { raw } = await fixture("rfc6376-rsa")
    const { body } = splitMessage(raw)
    assertEquals(
      await sha256Base64(canonicalizeBody(body, "simple")),
      "4bLNXImK9drULnmePzZNEBleUanJCX5PIsDIFoH4KTQ=",
    )
  })

  it("canonicalizes §3.4.5 Example 1 headers as the RFC shows", () => {
    // relaxed gives "a:X" and "b:Y Z"; simple changes nothing at all.
    assertEquals(canonicalizeHeader("A", " X", "relaxed"), "a:X\r\n")
    assertEquals(canonicalizeHeader("B ", " Y\t\r\n\t Z  ", "relaxed"), "b:Y Z\r\n")
    assertEquals(canonicalizeHeader("A", " X", "simple"), "A: X\r\n")
    assertEquals(canonicalizeHeader("B ", " Y\t\r\n\t Z  ", "simple"), "B : Y\t\r\n\t Z  \r\n")
  })

  it("canonicalizes §3.4.5 Example 3 bodies as the RFC shows", () => {
    const body = " C \r\nD \t E\r\n\r\n\r\n"
    assertEquals(canonicalizeBody(body, "relaxed"), " C\r\nD E\r\n")
    assertEquals(canonicalizeBody(body, "simple"), " C \r\nD \t E\r\n")
  })

  it("reproduces §3.4.5's published digests for the empty-body cases", async () => {
    // simple hashes the CRLF the algorithm appends; relaxed hashes nothing.
    assertEquals(
      await sha256Base64(canonicalizeBody("", "simple")),
      "frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=",
    )
    assertEquals(
      await sha256Base64(canonicalizeBody("   \r\n", "relaxed")),
      "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
    )
  })
})

// --- differential suite against dkimpy -------------------------------------

/**
 * Messages signed with dkimpy 1.1.8's canonicalizers plus `openssl dgst
 * -sha256 -sign`, each asserted valid by dkimpy itself. The regeneration recipe
 * is in `fixtures/SOURCES.md`; these are the cases that separate "implements RFC
 * 6376" from "agrees with itself".
 */
const DKIMPY_VERIFIED = [
  "dkimpy-relaxed",
  "dkimpy-simple",
  "dkimpy-empty-body-simple",
  "dkimpy-two-empty-lines",
  "dkimpy-relaxed-empty-body",
  "dkimpy-wsp-only-body-relaxed",
  "dkimpy-folded-hdr-simple",
  "dkimpy-folded-hdr-relaxed",
  "dkimpy-folded-b",
  "dkimpy-h-fws",
  "dkimpy-h-repeat",
  "dkimpy-received-bottomup",
  "dkimpy-rsa4096",
  "dkimpy-l0",
  "dkimpy-l8",
  "dkimpy-l18",
  "dkimpy-l25",
]

/**
 * Messages signed by `fixtures/SOURCES.md`'s OpenSSL-only script: no dkimpy, a
 * canonicalizer written from the RFC text, and the signature checked with
 * `openssl dgst -sha256 -verify` before the fixture was written. They pin the
 * §2.2 header/body boundary (a body that starts with SP or HTAB) and a simple
 * signature made over a lower-case field name.
 */
const OPENSSL_VERIFIED = [
  "openssl-sp-body-simple",
  "openssl-sp-body-relaxed",
  "openssl-tab-body-simple",
  "openssl-tab-body-relaxed",
  "openssl-lower-field-simple",
]

describe("differential: messages dkimpy signs and itself verifies", () => {
  for (const name of DKIMPY_VERIFIED) {
    it(`verifies ${name}`, async () => {
      const { raw, record } = await fixture(name)
      const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
      assert(result.valid, `reason=${result.reason}`)
    })
  }

  it("verifies a signature whose x= tag follows b=", async () => {
    // §3.7 step 2 deletes only the *value* of b=, so everything after it is
    // inside the signed bytes. Refusing such signatures rejected conformant,
    // dkimpy-valid mail for no security gain: moving a tag into the message no
    // longer verifies at all.
    const { raw, record } = await fixture("dkimpy-unsigned-trailing-tag")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.expiration, 1800000000n)
  })

  it("verifies a signature whose x= tag follows b= under simple", async () => {
    // The claim that a `b=` tag which is not final cannot be emptied byte-exactly
    // was false in either mode: the deletion is bounded by the parsed value, so
    // what follows `b=` stays inside the signed field and is authenticated.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      mode: "simple",
      extraTags: "l=17",
      afterB: "; x=1800000000",
    })
    const result = await verifyDkim(raw, publicKey, { now: 1700001000n })
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.expiration, 1800000000n)
  })

  // Every payload is appended to the DKIM-Signature field itself. That is the
  // only position that tests anything: the field's own bytes are part of the
  // signed input (§3.7 step 2), so a tag added to it changes what the signature
  // covers. An earlier revision appended to `lines[0]`, which is the `From:`
  // field of this fixture — so the tests never touched the signature at all and
  // passed because `From:` is signed bytes for a different reason.
  const SIGNATURE_ATTACKS = [
    { payload: "; x=9999999999", reason: "signature did not verify against public key" },
    // An `i=` in a foreign domain never reaches the signature check: §6.1.1 makes
    // the d=/i= relation a check of its own and it runs first. The subdomain
    // payload below is the same attack with an `i=` that satisfies §6.1.1, so the
    // signature mismatch stays pinned too.
    {
      payload: "; i=@attacker.invalid",
      reason: "i= domain attacker.invalid is not d= (example.com) or a subdomain of it",
    },
    {
      payload: "; i=@mail.example.com",
      reason: "signature did not verify against public key",
    },
    // The injected `l=` is caught one step earlier, by the body hash: the bound
    // re-truncates the canonical body, so `bh=` stops matching before the
    // signature is ever checked. The tag still took effect — on `From:` it had
    // none, and the reason was the signature mismatch above.
    { payload: "; l=1", reason: "body hash mismatch (body modified after signing)" },
  ] as const

  for (const attack of SIGNATURE_ATTACKS) {
    it(`rejects ${attack.payload} appended to a genuine signature`, async () => {
      const { raw, record } = await fixture("dkimpy-relaxed")
      const attacked = appendToSignatureField(raw, attack.payload)
      const field = splitMessage(attacked).headers.find((line) =>
        line.toLowerCase().startsWith("dkim-signature:")
      )
      assert(
        field !== undefined && field.includes(attack.payload),
        "the payload must land inside the DKIM-Signature field, not on another field",
      )
      const result = await verifyDkim(attacked, parseDkimPublicKey(record) ?? undefined)
      assertEquals(result.valid, false)
      assertEquals(result.reason, attack.reason)
    })
  }
})

describe("differential: openssl-signed vectors for the §2.2 boundary", () => {
  // §3.4.5 Example 1's own body begins with a space, so these are the ordinary
  // case, not an exotic one. Every message here was signed by an independent
  // script (`fixtures/SOURCES.md`) whose canonicalization shares no code with
  // this package, and each signature was checked with `openssl dgst -verify`
  // before the fixture was written.
  for (const name of OPENSSL_VERIFIED) {
    it(`verifies ${name}`, async () => {
      const { raw, record } = await fixture(name)
      const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
      assert(result.valid, `reason=${result.reason}`)
      assert(result.computedBodyHash === result.parsed?.bodyHash)
    })
  }
})

describe("header/body boundary (§2.2)", () => {
  it("rejects a body smuggled in behind a leading SP", async () => {
    // The forgery this pins: `dkimpy-empty-body-simple` signs an empty body, so
    // its bh= is the §3.4.5 empty-body digest. Injecting " \r\n<payload>" after
    // the first empty line used to leave the boundary unfound, the whole message
    // classified as headers and the body hashed as empty — the attacker's text
    // verified with the originally signed digest, i.e. was never hashed.
    const { raw, record } = await fixture("dkimpy-empty-body-simple")
    const key = parseDkimPublicKey(record) ?? undefined
    assert((await verifyDkim(raw, key)).valid)

    const payload = " \r\nPlease send the payment to attacker.example\r\n"
    const boundary = raw.indexOf("\r\n\r\n") + 4
    const forged = raw.slice(0, boundary) + payload + raw.slice(boundary)
    assert(forged.includes("attacker.example"), "the payload must be in the message")
    assertEquals(splitMessage(forged).body, payload)

    const result = await verifyDkim(forged, key)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "body hash mismatch (body modified after signing)")
    assert(
      result.computedBodyHash !== "frcCV1k9oG9oKj3dpUqdJg1PxRT2RSN/XKdLCPjaYaY=",
      "the payload must not hash to the empty-body digest",
    )
  })
})

describe("the DKIM-Signature field name", () => {
  it("rejects a simple signature whose field name was renamed", async () => {
    // Hashing a literal "DKIM-Signature" verified a field renamed to
    // `dkim-signature:` under c=simple/simple: the verifier hashed bytes the
    // message no longer contained.
    const { raw, record } = await fixture("dkimpy-simple")
    const key = parseDkimPublicKey(record) ?? undefined
    assert((await verifyDkim(raw, key)).valid)

    const result = await verifyDkim(renameSignatureField(raw, "dkim-signature"), key)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "signature did not verify against public key")
    assertEquals((await verifyDkim(renameSignatureField(raw, "DKIM-SIGNATURE"), key)).valid, false)
  })

  it("verifies a simple signature made over a lower-case field name", async () => {
    // The other direction of the same defect: a signer that emitted the field as
    // `dkim-signature:` was rejected, because the literal name was hashed instead.
    const { raw, record } = await fixture("openssl-lower-field-simple")
    assert(raw.startsWith("From: "))
    assert(raw.includes("\r\ndkim-signature: v=1;"))
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("ignores the field name's case under relaxed, which lower-cases it", async () => {
    // §3.4.2 lower-cases the name, so under c=relaxed/relaxed the case carries no
    // information and a renamed field must still verify.
    const { raw, record } = await fixture("dkimpy-relaxed")
    const key = parseDkimPublicKey(record) ?? undefined
    assertEquals((await verifyDkim(renameSignatureField(raw, "DKIM-SIGNATURE"), key)).valid, true)
  })
})

// --- verifier policy RFC 6376 leaves to the caller -------------------------

describe("the l= body bound is counted in octets", () => {
  // RFC 6376 §3.5 / §3.7 count canonical **octets**. `String.prototype.slice`
  // counts UTF-16 code units, so a verifier that bounds the canonical body string
  // hashes a different byte range than the signer did as soon as a non-ASCII
  // character sits before the bound — and rejects valid mail. Each fixture here
  // was signed by the OpenSSL-only script in `fixtures/SOURCES.md` and asserted
  // with `openssl dgst -sha256 -verify` before it was written.
  const vectors = [
    {
      name: "openssl-utf8-l4",
      body: "héllo",
      bodyLength: 4,
      bodyHash: "nCjUmslET0eKzs9FV7zzkWhR/r2ik2CJIgWSlEPYf6A=",
    },
    {
      name: "openssl-utf8-l6",
      body: "heloéé",
      bodyLength: 6,
      bodyHash: "sZ0NsYvV5Rbv3pELbhdaYgWpIl+a0NmYlxJvzRwfLhc=",
    },
    {
      // Two octets, and the second is the first byte of the three-octet euro sign:
      // the bound lands inside a character, so decoding the slice back to a string
      // yields U+FFFD (0xEF 0xBF 0xBD) — three octets no signer signed.
      name: "openssl-utf8-split-l2",
      body: "h\u20acllo",
      bodyLength: 2,
      bodyHash: "BnwhlmstcOW74w+XBvVGZvPGRVnBN23k4FCq43WUwBw=",
    },
  ]

  for (const vector of vectors) {
    it(`verifies ${vector.name}`, async () => {
      const { raw, record } = await fixture(vector.name)
      const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
      assert(result.valid, `reason=${result.reason}`)
      assertEquals(result.parsed?.bodyLength, vector.bodyLength)
      assertEquals(result.computedBodyHash, vector.bodyHash)

      // The two counts the fixture separates: the bound is the octet count, so a
      // canonical body read as UTF-16 code units is longer than it is in octets,
      // and the code-unit slice covers more characters than the signer signed.
      const canonical = `${vector.body}\r\n`
      const bytes = new TextEncoder().encode(canonical)
      assert(
        vector.body.length < new TextEncoder().encode(vector.body).length,
        "the body must contain a multi-octet character",
      )
      const bounded = bytes.slice(0, vector.bodyLength)
      assertEquals(bounded.length, vector.bodyLength)
      assert(
        canonical.slice(0, vector.bodyLength) !== new TextDecoder().decode(bounded),
        "the code-unit slice and the octet slice must differ",
      )
    })
  }

  it("hashes the octets the l= bound names, not the UTF-16 code units", async () => {
    // The one line the whole file is about: `computedBodyHash` must be the digest
    // of the first `l=` canonical octets. `String.prototype.slice` produces the
    // fourth of these values, and it is exactly what a signer that declared the
    // bound did not hash.
    const { raw, record } = await fixture("openssl-utf8-l4")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)

    const canonical = canonicalizeBody(splitMessage(raw).body, "relaxed")
    const covered = "h\u00e9l"
    assertEquals(canonical, `${covered}lo\r\n`)
    assertEquals(new TextEncoder().encode(covered).length, 4)
    assertEquals(covered.length, 3, "four octets are three UTF-16 code units")

    assertEquals(result.computedBodyHash, await sha256Base64(covered))
    assertEquals(
      await sha256Base64(covered),
      "nCjUmslET0eKzs9FV7zzkWhR/r2ik2CJIgWSlEPYf6A=",
    )
    assertEquals(result.computedBodyHash, result.parsed?.bodyHash)

    // The pre-fix behaviour, recorded as an inequality rather than prose: a
    // code-unit slice hashes "héll" (5 octets) and must not be what this
    // verifier computes.
    assertEquals(canonical.slice(0, 4), "h\u00e9ll")
    assertEquals(
      await sha256Base64(canonical.slice(0, 4)),
      "V/OrDY5eigJU1Zmgo+zLEbepPnNVUwupIRgyjsfEE4g=",
    )
    assert(result.computedBodyHash !== await sha256Base64(canonical.slice(0, 4)))
  })

  it("hashes a slice that ends inside a character", async () => {
    // Decoding the byte slice back to a string cannot work: the slice stops
    // mid-character, so the two octets come back as U+FFFD (0xEF 0xBF 0xBD) and a
    // decode-then-hash verifier would hash three octets where the signer signed
    // two.
    const { raw, record } = await fixture("openssl-utf8-split-l2")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)

    const bounded = new TextEncoder().encode("h\u20acllo").slice(0, 2)
    assertEquals([...bounded], [0x68, 0xe2])
    assertEquals(result.computedBodyHash, await sha256Base64(bounded))
    assertEquals(result.computedBodyHash, result.parsed?.bodyHash)

    // The round-trip the issue warns about, recorded with its digest.
    const decoded = new TextDecoder().decode(bounded)
    assertEquals(decoded, "h" + String.fromCodePoint(0xfffd))
    assertEquals([...new TextEncoder().encode(decoded)], [0x68, 0xef, 0xbf, 0xbd])
    assertEquals(
      await sha256Base64(decoded),
      "4b5JJzu7A+6PSXw3/SguYfWFYGMPbuteZ+mHdZDLaxM=",
    )
    assert(
      result.computedBodyHash !== await sha256Base64(decoded),
      "the decoded form must not match",
    )
  })

  it("rejects an edit inside the bits the l= bound covers", async () => {
    // Tightening the bound is not a free pass: truncation to l= is what makes the
    // hash reproducible, and every octet it names is still authenticated. The
    // byte before the bound is a continuation octet, so the tamper is inside it.
    const { raw, record } = await fixture("openssl-utf8-l4")
    const key = parseDkimPublicKey(record) ?? undefined
    assert((await verifyDkim(raw, key)).valid)

    const tampered = raw.replace("h\u00e9llo", "h\u00e8llo")
    assert(tampered !== raw, "the body must have changed")
    const result = await verifyDkim(tampered, key)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "body hash mismatch (body modified after signing)")
  })
})

describe("policy RFC 6376 leaves to the caller", () => {
  it("accepts an l= bound longer than the body without enlarging what it covers", async () => {
    // §3.5: "the signer MUST NOT use a value in the l= tag that is greater than
    // the actual body length". That binds the signer. Verifier-side, §3.7 step 1
    // truncates to l=, and truncating past the end covers the whole body, so the
    // bound cannot buy an extra acceptance path.
    const { raw, record } = await fixture("dkimpy-l25")
    const key = parseDkimPublicKey(record) ?? undefined
    const result = await verifyDkim(raw, key)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.bodyLength, 25)
    assertEquals(result.computedBodyHash, await sha256Base64("0123456789abcdef\r\n"))

    const grown = raw.replace("0123456789abcdef\r\n", "0123456789abcdefg\r\n")
    assertEquals(grown.length, raw.length + 1)
    const tampered = await verifyDkim(grown, key)
    assertEquals(tampered.valid, false)
    assertEquals(tampered.reason, "body hash mismatch (body modified after signing)")
  })
})

// --- several signatures on one message (§6.1) -------------------------------

/**
 * RFC 6376 §6.1 treats each `DKIM-Signature` field independently: a message is
 * signed by any one of them that verifies. This verifier looked at the first
 * field only, so a mailing list that re-signed above a broken signature was
 * rejected, and a signature an attacker prepended was the only one examined.
 */
describe("a message carrying several signatures (§6.1)", () => {
  const BODY = "This is a test.\r\n"

  /** The message's DKIM-Signature field, as one line. */
  function signatureField(raw: string): string {
    const line = splitMessage(raw).headers.find((header) =>
      header.toLowerCase().startsWith("dkim-signature:")
    )
    if (line === undefined) throw new Error("message has no DKIM-Signature field")
    return line
  }

  /** The same field with one base64 character of `b=` flipped. */
  function breakSignature(field: string): string {
    const signature = /; b=([A-Za-z0-9+/=]+)/.exec(field)![1]
    const flipped = signature.slice(0, 5) +
      (signature[5] === "A" ? "B" : "A") + signature.slice(6)
    return field.replace(`; b=${signature}`, `; b=${flipped}`)
  }

  /** The message with `fields` inserted above every header it already has. */
  function prependFields(raw: string, fields: string[]): string {
    return `${fields.map((field) => `${field}\r\n`).join("")}${raw}`
  }

  it("verifies a mail whose first signature is broken and second is good", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY)
    const attacked = prependFields(raw, [breakSignature(signatureField(raw))])
    assertEquals(
      splitMessage(attacked).headers.filter((header) =>
        header.toLowerCase().startsWith("dkim-signature:")
      ).length,
      2,
    )

    const result = await verifyDkim(attacked, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("returns one result per signature, in the order they appear", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY)
    const attacked = prependFields(raw, [breakSignature(signatureField(raw))])

    const results = await verifyDkimSignatures(attacked, publicKey)
    assertEquals(results.length, 2)
    assertEquals(results[0].valid, false)
    assertEquals(results[0].reason, "signature did not verify against public key")
    assertEquals(results[1].valid, true)
    // Each result names the domain that signed, which is what lets a caller
    // decide whether the signer has anything to do with the From address.
    assertEquals(results[0].parsed?.domain, "example.com")
    assertEquals(results[1].parsed?.domain, "example.com")
  })

  it("checks no more signatures than the cap allows", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY)
    const broken = breakSignature(signatureField(raw))
    const attacked = prependFields(raw, [broken, broken])

    const capped = await verifyDkimSignatures(attacked, publicKey, { maxSignatures: 2 })
    assertEquals(capped.length, 3)
    assertEquals(capped[2].valid, false)
    assertEquals(
      capped[2].reason,
      "not verified: only the first 2 DKIM-Signature fields of a message are checked",
    )
    assertEquals(capped[2].parsed, undefined)
    assertEquals((await verifyDkim(attacked, publicKey, { maxSignatures: 2 })).valid, false)

    // One more slot and the genuine signature is reached.
    assert((await verifyDkim(attacked, publicKey, { maxSignatures: 3 })).valid)
    assertEquals(DEFAULT_MAX_SIGNATURES, 10)
  })

  it("reports the first signature's diagnosis when none verifies", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY)
    const broken = breakSignature(signatureField(raw))
    const allBroken = prependFields(
      raw.replace(signatureField(raw), broken),
      [broken],
    )
    const result = await verifyDkim(allBroken, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "signature did not verify against public key")
  })
})

// --- §6.1.1 and §3.6.1: the checks a verifier owes the standard -------------

/**
 * The fourth finding of issue #62: the signer's identity was parsed and never
 * compared with the signing domain, and nothing in the published key record was
 * read beyond `k=` and `p=`. A key published for another service, restricted to
 * another hash, or marked as testing was accepted as if it said nothing.
 *
 * Each test signs a message in-process and verifies it through an injected
 * resolver, so the only thing that varies is the tag under test.
 */
describe("the identity and key-record checks (§6.1.1, §3.6.1)", () => {
  const BODY = "This is a test.\r\n"

  /** A resolver that answers every query with one record. */
  function resolverFor(record: string): DnsTxtResolver {
    return { resolveTxt: () => Promise.resolve([[record]]) }
  }

  /** The signed message plus a key record carrying `tags` before `p=`. */
  async function signedWithRecord(
    tags: string,
    options: SignOptions = {},
  ): Promise<{ raw: string; record: string }> {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, options)
    const p = base64(publicKey.keyBytes)
    return { raw, record: `v=DKIM1; k=${publicKey.algorithm};${tags} p=${p}` }
  }

  it("rejects an i= whose domain is not d= or below it", async () => {
    // §6.1.1: "Verifiers MUST confirm that the domain specified in the 'd=' tag
    // is the same as or a parent domain of the domain part of the 'i=' tag."
    // The signature itself is genuine: only the identity it claims is foreign.
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, {
      extraTags: "i=ceo@bank.example",
    })
    const result = await verifyDkim(raw, publicKey)
    assertEquals(result.valid, false)
    assertEquals(
      result.reason,
      "i= domain bank.example is not d= (example.com) or a subdomain of it",
    )
  })

  it("accepts an i= in a subdomain of d=", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, {
      extraTags: "i=agent@mail.example.com",
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.identity, "agent@mail.example.com")
  })

  it("rejects a subdomain i= when the key record sets t=s", async () => {
    // §3.6.1 on the `s` flag: the domain part of `i=` "MUST be the same as the
    // value of the d= tag", so the parent-domain allowance is withdrawn.
    const { raw, record } = await signedWithRecord(" t=s;", {
      extraTags: "i=agent@mail.example.com",
    })
    const result = await verifyDkim(raw, undefined, { resolver: resolverFor(record) })
    assertEquals(result.valid, false)
    assertEquals(
      result.reason,
      "i= domain mail.example.com is not exactly d= (example.com), which t=s requires",
    )

    // The same record without the flag accepts the same message.
    const relaxedRecord = record.replace(" t=s;", "")
    assert((await verifyDkim(raw, undefined, { resolver: resolverFor(relaxedRecord) })).valid)
  })

  it("rejects a key record marked as testing (t=y)", async () => {
    // §3.6.1: "Verifiers MUST NOT treat messages from signers in testing mode
    // differently from unsigned email", and "valid" is exactly that different
    // treatment.
    const { raw, record } = await signedWithRecord(" t=y;")
    const result = await verifyDkim(raw, undefined, { resolver: resolverFor(record) })
    assertEquals(result.valid, false)
    assertEquals(
      result.reason,
      "key record is in testing mode (t=y), so the signature authenticates nothing",
    )
  })

  it("rejects a key record that does not allow sha256", async () => {
    const { raw, record } = await signedWithRecord(" h=sha1;")
    const result = await verifyDkim(raw, undefined, { resolver: resolverFor(record) })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "key record does not allow sha256 (h=sha1)")

    const both = record.replace(" h=sha1;", " h=sha1:sha256;")
    assert((await verifyDkim(raw, undefined, { resolver: resolverFor(both) })).valid)
  })

  it("rejects a key record published for another service", async () => {
    const { raw, record } = await signedWithRecord(" s=calendar;")
    const result = await verifyDkim(raw, undefined, { resolver: resolverFor(record) })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "key record is not published for email (s=calendar)")

    for (const service of [" s=email;", " s=*;", " s=calendar:email;"]) {
      const allowed = record.replace(" s=calendar;", service)
      const verified = await verifyDkim(raw, undefined, { resolver: resolverFor(allowed) })
      assert(verified.valid, `s=${service}: ${verified.reason}`)
    }
  })

  it("rejects a key record from another version of the standard", async () => {
    const { raw, record } = await signedWithRecord("")
    const future = record.replace("v=DKIM1", "v=DKIM2")
    const result = await verifyDkim(raw, undefined, { resolver: resolverFor(future) })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "unsupported DKIM key record version: DKIM2")
  })

  it("rejects a key record whose v= is not the first tag", async () => {
    // §3.6.1: "v= ... MUST be the first tag in the record."
    assertThrows(
      () => parseDkimPublicKey("k=rsa; v=DKIM1; p=AAECAw=="),
      DkimParseError,
      "v= tag must come first",
    )
  })

  it("rejects a key record whose s= or h= list is empty", async () => {
    // Present and empty is a typo, not "no restriction": reading it as "any
    // service" would widen the key's permission rather than narrow it.
    for (const tag of ["s", "h"]) {
      assertThrows(
        () => parseDkimPublicKey(`v=DKIM1; ${tag}=; p=AAECAw==`),
        DkimParseError,
        `${tag}= tag is empty`,
      )
    }
  })

  it("reads the restriction tags onto the parsed key", async () => {
    const key = parseDkimPublicKey("v=DKIM1; h=sha256; s=email:*; t=y:s; p=AAECAw==")!
    assertEquals(key.version, "DKIM1")
    assertEquals(key.hashAlgorithms, ["sha256"])
    assertEquals(key.serviceTypes, ["email", "*"])
    assertEquals(key.flags, ["y", "s"])
  })

  it("rejects a q= that names no query method this verifier speaks", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, { extraTags: "q=http/ldap" })
    const result = await verifyDkim(raw, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "unsupported q= query method: http/ldap")

    // The default and the one every signer publishes.
    const { raw: viaDns, publicKey: dnsKey } = await sign(TEST_HEADERS, BODY, {
      extraTags: "q=dns/txt",
    })
    assert((await verifyDkim(viaDns, dnsKey)).valid)
  })

  it("rejects a signature that expires no later than it was made", async () => {
    // §3.5: "The value of the 'x=' tag MUST be greater than the value of the 't='
    // tag if both are present."
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, {
      extraTags: "t=1700000000; x=1700000000",
    })
    const result = await verifyDkim(raw, publicKey, { now: 1600000000n })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "x= (1700000000) is not later than t= (1700000000)")
  })

  it("ignores a signature tag no RFC defines, whatever its value", async () => {
    // §3.2: "Unrecognized tags MUST be ignored." An earlier revision rejected a
    // `dt=` tag with any value but `1` — an invented rule, unreachable in
    // practice, that the README described as an ignored tag (#74).
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=xxx; dt=2; r=y",
    )
    assertEquals(parsed.domain, "example.com")

    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, { extraTags: "dt=2" })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("rejects an i= tag that carries no domain", async () => {
    assertThrows(
      () =>
        parseDkimSignature(
          "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=x; i=nobody",
        ),
      DkimParseError,
      "i= tag has no domain",
    )
  })
})

// --- RFC 8301: the RSA key size floor ---------------------------------------

/**
 * RFC 8301 §3.2: "Verifiers MUST NOT consider signatures using RSA keys of less
 * than 1024 bits as valid."
 *
 * The keys here are generated in-process and the message is signed with them, so
 * the signature is cryptographically perfect and only the key's size separates
 * the two cases. A 512-bit modulus is factorable on one machine in hours, which
 * is what makes "valid" the wrong answer for it.
 */
describe("the RSA key size floor (RFC 8301)", () => {
  it("rejects a signature made with a 512-bit RSA key", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", { rsaBits: 512 })
    const result = await verifyDkim(raw, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "RSA key is 512 bits; RFC 8301 requires at least 1024")
    // The body was never in question: the rejection is the key, not the message.
    assertEquals(result.computedBodyHash, result.parsed?.bodyHash)
  })

  it("verifies the same message signed with a 1024-bit key", async () => {
    // The floor itself, so "rejects a short key" cannot be satisfied by rejecting
    // every key that is not the suite's usual 2048-bit one.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", { rsaBits: 1024 })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })
})

// --- §6.1.1: the From field must be signed ----------------------------------

/**
 * RFC 6376 §6.1.1: "If the 'h=' tag does not include the From header field, the
 * Verifier MUST ignore the DKIM-Signature header field and return PERMFAIL (From
 * field not signed)."
 *
 * Two tests used to pin the opposite, on the reading that §5.4 binds only the
 * signer. The consequence is the first finding of issue #62: a message signed
 * with `h=to:subject` keeps a valid signature while its From line is rewritten to
 * anybody's address, so "valid" said nothing about who sent the mail.
 */
describe("the From field must be signed (§6.1.1)", () => {
  it("rejects a mail whose From is not named in h=", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["to", "subject"],
    })
    const result = await verifyDkim(raw, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "From field not signed (h= does not name from)")
    assertEquals(result.parsed?.signedHeaders.includes("from"), false)
  })

  it("rejects a forged sender the signature never covered", async () => {
    // The attack itself: the signature is genuine and the body is untouched, so
    // every other check in this file agrees with the attacker. Only the From
    // check sees that the address a person reads was never signed.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["to", "subject"],
    })
    const forged = raw.replace(
      "From: Sender <sender@example.com>",
      "From: Your Bank <security@bank.example>",
    )
    assert(forged.includes("security@bank.example"), "the forged sender must be in the message")
    const result = await verifyDkim(forged, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "From field not signed (h= does not name from)")
  })

  it("rejects a message that has no From at all", async () => {
    // `h=from` over a message with no From field hashes nothing for it (§3.5's
    // "null input"), so the signature says nothing about the author. RFC 5322
    // requires the field; a message without one is not authenticated here.
    const headers = ["To: recipient@example.org", "Subject: DKIM port smoke test"]
    const { raw, publicKey } = await sign(headers, "This is a test.\r\n", {
      names: ["from", "to", "subject"],
    })
    assert(!raw.includes("From:"))
    const result = await verifyDkim(raw, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "From field not signed (the message has no From field)")
  })

  it("verifies the same message once From is signed", async () => {
    // The control: nothing else about the message changed, so the rejections
    // above are the From check and not a broken signer helper.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["from", "to", "subject"],
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })
})

// --- splitMessage ----------------------------------------------------------

describe("splitMessage", () => {
  it("splits a CRLF message into headers and body", () => {
    const raw = "From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nbody\r\n"
    const { headers, body } = splitMessage(raw)
    assertEquals(headers.length, 3)
    assertEquals(body, "body\r\n")
  })

  it("splits an LF-only message, as stored by an IMAP server", () => {
    const { headers, body } = splitMessage("From: a@example.com\nTo: b@example.com\n\nbody\n")
    assertEquals(headers.length, 2)
    assertEquals(body, "body\n")
  })

  it("keeps a folded continuation attached across mixed line endings", () => {
    const raw = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com\r\n" +
      "\th=from:to; bh=abc; b=xxx;\nFrom: a@example.com\n\nbody\n"
    const { headers, body } = splitMessage(raw)
    assertEquals(headers.length, 2)
    assert(headers[0].includes("\th=from:to;"))
    assertEquals(body, "body\n")
  })

  it("does not split at a folded continuation", () => {
    const raw = "H1: v1\r\n\tcontinuation\r\n\r\nbody\r\n"
    const { headers, body } = splitMessage(raw)
    assertEquals(headers.length, 1)
    assertEquals(headers[0], "H1: v1\r\n\tcontinuation")
    assertEquals(body, "body\r\n")
  })

  it("ends the header section at the first empty line, WSP-led body and all", () => {
    // RFC 5322 §2.2 ends the header section at the first empty line, whatever
    // follows it. A fold is a line ending *directly* followed by WSP (§2.2.3),
    // never an empty line followed by WSP, so a body beginning with SP or HTAB
    // is body. Treating it as headers left it outside the body hash entirely.
    assertEquals(splitMessage("H: v\r\n\r\n body\r\n").body, " body\r\n")
    assertEquals(splitMessage("H: v\r\n\r\n\tbody\r\n").body, "\tbody\r\n")
    assertEquals(splitMessage("H: v\n\n body\n").body, " body\n")
    assertEquals(splitMessage("H: v\r\n\r\n \r\nmore\r\n").body, " \r\nmore\r\n")
  })

  it("returns an empty body for a message with no body separator", () => {
    assertEquals(splitMessage("From: a@example.com\r\n").body, "")
  })
})

// --- canonicalizeHeader ----------------------------------------------------

describe("canonicalizeHeader", () => {
  it("relaxed lowercases the name with no SP after the colon", () => {
    assertEquals(
      canonicalizeHeader("Subject", "  Hello World  ", "relaxed"),
      "subject:Hello World\r\n",
    )
    assertEquals(canonicalizeHeader("FROM", "a@example.com", "relaxed"), "from:a@example.com\r\n")
  })

  it("relaxed unfolds a continuation into one SP", () => {
    // §3.4.2 unfolds by deleting the CRLF, then compresses the WSP that
    // followed it, so `one<CRLF><HTAB>two` becomes `one two` — not `onetwo`.
    // dkimpy's Relaxed.canonicalize_headers gives the same answer.
    assertEquals(canonicalizeHeader("X-Test", "one\r\n\ttwo", "relaxed"), "x-test:one two\r\n")
    assertEquals(canonicalizeHeader("X-Test", "one\r\n two", "relaxed"), "x-test:one two\r\n")
  })

  it("relaxed collapses WSP runs and trims the value", () => {
    assertEquals(canonicalizeHeader("X-Test", "  a\t\t b   c ", "relaxed"), "x-test:a b c\r\n")
    assertEquals(canonicalizeHeader("X-Gap", "", "relaxed"), "x-gap:\r\n")
  })

  it("simple preserves the name case, the value and the colon WSP", () => {
    assertEquals(canonicalizeHeader("Subject", "Hello World", "simple"), "Subject:Hello World\r\n")
    assertEquals(
      canonicalizeHeader("X-Keep", "  spaces  kept ", "simple"),
      "X-Keep:  spaces  kept \r\n",
    )
  })

  it("simple leaves a folded header byte for byte", () => {
    // §3.4.1 changes nothing and §3.4.5 Example 2 keeps the fold. An earlier
    // version unfolded here and hashed bytes no signer had hashed.
    assertEquals(canonicalizeHeader("X-Fold", "one\r\n\ttwo", "simple"), "X-Fold:one\r\n\ttwo\r\n")
  })

  it("treats a bare LF inside a value as content, not a line ending", () => {
    // §3.4.1 changes nothing, so the LF survives under simple; §3.4.2 unfolds
    // every LF with nothing in its place, which is what dkimpy's
    // `unfold_header_value` does.
    assertEquals(canonicalizeHeader("X-Lf", "value\n", "simple"), "X-Lf:value\n\r\n")
    assertEquals(canonicalizeHeader("X-Lf", "a\nb", "relaxed"), "x-lf:ab\r\n")
  })

  it("treats a lone CR inside a value as a literal CR", () => {
    // RFC 5322 §2.3: a bare CR is not a line ending, and §3.4.2 unfolds CRLF
    // only, so the CR survives in both modes.
    assertEquals(canonicalizeHeader("X-Cr", "a\rb", "simple"), "X-Cr:a\rb\r\n")
    assertEquals(canonicalizeHeader("X-Cr", "a\rb", "relaxed"), "x-cr:a\rb\r\n")
    assertEquals(
      [...canonicalizeHeader("X-Cr", "a\rb", "relaxed")].map((c) => c.charCodeAt(0)),
      [120, 45, 99, 114, 58, 97, 13, 98, 13, 10],
    )
    // At the ends of the value it is a different story: the relaxed path trims
    // with `String.trim()`, for which CR is whitespace, so a trailing lone CR is
    // stripped there and kept by simple.
    assertEquals(canonicalizeHeader("X-Cr", "a\r", "simple"), "X-Cr:a\r\r\n")
    assertEquals(canonicalizeHeader("X-Cr", "a\r", "relaxed"), "x-cr:a\r\n")
    assertEquals(canonicalizeHeader("X-Cr", "\ra", "relaxed"), "x-cr:a\r\n")
  })
})

// --- canonicalizeBody ------------------------------------------------------

describe("canonicalizeBody", () => {
  it("simple strips trailing empty lines and ends in one CRLF", () => {
    assertEquals(canonicalizeBody("Hello world.\r\n\r\n\r\n", "simple"), "Hello world.\r\n")
    assertEquals(canonicalizeBody("Hello world.", "simple"), "Hello world.\r\n")
  })

  it("simple preserves internal whitespace exactly", () => {
    assertEquals(canonicalizeBody("a  b \t\r\n", "simple"), "a  b \t\r\n")
    assertEquals(canonicalizeBody(" C \r\nD \t E\r\n\r\n\r\n", "simple"), " C \r\nD \t E\r\n")
  })

  it("simple renders an empty body as a single CRLF", () => {
    // §3.4.5 publishes frcCV1k9…, the digest of exactly that CRLF.
    assertEquals(canonicalizeBody("", "simple"), "\r\n")
    assertEquals(canonicalizeBody("\r\n\r\n", "simple"), "\r\n")
  })

  it("relaxed renders an empty body as the empty string", () => {
    // §3.4.5 publishes 47DEQpj8…, the digest of zero bytes.
    assertEquals(canonicalizeBody("", "relaxed"), "")
    assertEquals(canonicalizeBody("\r\n\r\n", "relaxed"), "")
    assertEquals(canonicalizeBody("   \r\n", "relaxed"), "")
  })

  it("relaxed strips WSP before every line ending, not just the last", () => {
    assertEquals(canonicalizeBody("a  \r\nb\t\r\n", "relaxed"), "a\r\nb\r\n")
    assertEquals(canonicalizeBody("foo   bar\r\n", "relaxed"), "foo bar\r\n")
  })

  it("normalises LF-only input to the canonical CRLF body", () => {
    assertEquals(canonicalizeBody("Hello world.\n", "simple"), "Hello world.\r\n")
    assertEquals(canonicalizeBody("a\n\n\n", "relaxed"), "a\r\n")
  })

  it("treats a lone CR in a body as a line ending", () => {
    // Mailbox storage rewrites line endings and nothing else references the
    // body's original bytes, so every ending — CRLF, bare LF, lone CR — becomes
    // one canonical CRLF. Deleting this rewrite left the suite green before
    // (#74), because every other body test uses CRLF or LF.
    assertEquals(canonicalizeBody("line one\rline two\r\n", "simple"), "line one\r\nline two\r\n")
    assertEquals(canonicalizeBody("a\rb", "relaxed"), "a\r\nb\r\n")
    assertEquals(canonicalizeBody("a\r\r\r", "simple"), "a\r\n")
    // A CR that ends the body is a line ending too, so the trailing empty line
    // it opens is dropped rather than kept as content.
    assertEquals(canonicalizeBody("a\r", "relaxed"), "a\r\n")
  })

  it("keeps the internal empty lines and drops only the trailing ones", () => {
    assertEquals(canonicalizeBody("a\r\n\r\n\r\nb\r\n\r\n\r\n", "simple"), "a\r\n\r\n\r\nb\r\n")
    assertEquals(canonicalizeBody("a\r\n \r\n \r\nb\r\n \r\n", "relaxed"), "a\r\n\r\n\r\nb\r\n")
  })
})

// --- the cost of canonicalizing a body --------------------------------------

/**
 * The third finding of issue #62: `canonicalizeBody` used two regular
 * expressions that backtrack — `/[ \t]+\r\n/g` retried a whole run of spaces at
 * every offset inside it, and `/(?:\r\n)+$/` did the same for a run of line
 * endings — so the work grew with the square of the body. Measured on the code
 * before this change: 20 000 characters took 257 ms, 40 000 took 1 015 ms and
 * 80 000 took 4 291 ms. The body comes from whoever sent the message, the work
 * is synchronous, and one large message froze the process.
 *
 * The budget below is a multiple of a linear pass over the same strings, timed on
 * the machine running the test, rather than a number of milliseconds: a slow or
 * loaded machine moves both sides of the comparison together. The factor is
 * enormous on purpose. A linear implementation comes in at well under 10x the
 * reference and the quadratic one at several thousand times it, so anything in
 * between is still a clear failure.
 */
describe("the cost of canonicalizing a large body", () => {
  const REFERENCE_PASSES = 5
  const LINEAR_BUDGET_FACTOR = 200

  it("canonicalizes 128 KiB of the pathological shapes within a linear budget", () => {
    const size = 128 * 1024
    const spaces = `${" ".repeat(size)}x\r\n`
    const endings = `x${"\r\n".repeat(size / 2)}`

    // The reference: split and re-join the same strings, which is the same order
    // of work the canonicalizer does and is unambiguously linear. The length is
    // accumulated so the optimiser cannot drop the loop.
    let referenceChars = 0
    const referenceStart = performance.now()
    for (let pass = 0; pass < REFERENCE_PASSES; pass++) {
      referenceChars += spaces.split("\r\n").join("\r\n").length
      referenceChars += endings.split("\r\n").join("\r\n").length
    }
    const reference = (performance.now() - referenceStart) / REFERENCE_PASSES
    assert(referenceChars > 0, "the reference pass must not be optimised away")
    assert(reference > 0, `the reference pass was too fast to time: ${reference}ms`)

    const start = performance.now()
    const relaxed = canonicalizeBody(spaces, "relaxed")
    const simple = canonicalizeBody(endings, "simple")
    const elapsed = performance.now() - start

    // The results are asserted too: a canonicalizer that returned early would be
    // fast and wrong.
    assertEquals(relaxed, " x\r\n")
    assertEquals(simple, "x\r\n")
    assert(
      elapsed < reference * LINEAR_BUDGET_FACTOR,
      `canonicalizing ${size} characters took ${elapsed.toFixed(1)}ms, over ` +
        `${LINEAR_BUDGET_FACTOR}x the ${reference.toFixed(1)}ms linear reference`,
    )
  })
})

// --- parseDkimSignature ----------------------------------------------------

describe("parseDkimSignature", () => {
  it("parses the tag list and defaults canonicalization to simple", () => {
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=Example.COM; s=SEL; h=from:to; bh=abc; b=xxx",
    )
    assertEquals(parsed.version, "1")
    assertEquals(parsed.algorithm, "rsa-sha256")
    assertEquals(parsed.domain, "example.com")
    assertEquals(parsed.selector, "sel")
    assertEquals(parsed.signedHeaders, ["from", "to"])
    assertEquals(parsed.canonicalization, { header: "simple", body: "simple" })
  })

  it("accepts FWS around the colons in h=", () => {
    // §3.5: "Folding whitespace (FWS) MAY be included on either side of the
    // colon separator", which is how RFC 6376's own example is written.
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=example.com; s=sel; h=from : to : subject; bh=abc; b=xxx",
    )
    assertEquals(parsed.signedHeaders, ["from", "to", "subject"])
  })

  it("strips internal whitespace from a folded value", () => {
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abcXXX\r\n\tYYYdef; b=z",
    )
    assertEquals(parsed.bodyHash, "abcXXXYYYdef")
  })

  it("parses optional tags, the length bound and a quoted value", () => {
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=xxx; " +
        'c=relaxed/simple; t=1700000000; x=1800000000; l=17; q=dns/txt; i="@example.com"',
    )
    assertEquals(parsed.timestamp, 1700000000n)
    assertEquals(parsed.expiration, 1800000000n)
    assertEquals(parsed.bodyLength, 17)
    assertEquals(parsed.queryMethod, "dns/txt")
    assertEquals(parsed.identity, "@example.com")
  })

  it("rejects a signature with no b= tag", () => {
    assertThrows(
      () =>
        parseDkimSignature(
          "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc",
        ),
      DkimParseError,
      "missing required tag: b",
    )
  })

  it("rejects a signature with an empty bh= value", () => {
    assertThrows(
      () => parseDkimSignature("v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=; b=x"),
      DkimParseError,
      "missing required tag: bh",
    )
  })

  it("rejects a repeated tag", () => {
    assertThrows(
      () =>
        parseDkimSignature(
          "v=1; a=rsa-sha256; d=evil.example; d=example.com; s=sel; h=from; bh=abc; b=xxx",
        ),
      DkimParseError,
      "DKIM tag repeats: d",
    )
  })

  it("rejects h= that names dkim-signature", () => {
    // §3.5: the field "MUST NOT include the DKIM-Signature header field that is
    // being created or verified". Requiring it instead — as an earlier version
    // did — rejected every standard signer, RFC 6376's own examples included.
    assertThrows(
      () =>
        parseDkimSignature(
          "v=1; a=rsa-sha256; d=example.com; s=sel; h=from:dkim-signature; bh=abc; b=xxx",
        ),
      DkimParseError,
      "must not name dkim-signature",
    )
  })

  it("rejects an unsupported algorithm", () => {
    assertThrows(
      () => parseDkimSignature("v=1; a=rsa-sha1; d=example.com; s=sel; h=from; bh=abc; b=x"),
      DkimParseError,
      "unsupported DKIM algorithm: rsa-sha1",
    )
  })

  it("rejects an unsupported canonicalization", () => {
    assertThrows(
      () =>
        parseDkimSignature(
          "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=xxx; c=novel/simple",
        ),
      DkimParseError,
      "unsupported header canonicalization",
    )
  })

  it("rejects a non-numeric t= tag", () => {
    assertThrows(
      () => parseDkimSignature("v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=x; t=l"),
      DkimParseError,
      "t= tag is not a number",
    )
  })

  it("ignores a tag RFC 6376 does not define", () => {
    const parsed = parseDkimSignature(
      "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; bh=abc; b=xxx; future=1",
    )
    assertEquals(parsed.domain, "example.com")
  })
})

// --- parseDkimPublicKey ----------------------------------------------------

describe("parseDkimPublicKey", () => {
  it("reads a bare PKCS#1 RSA key, the shape §3.6.1 specifies", () => {
    const key = parseDkimPublicKey(
      "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
    )
    assert(key !== null)
    assertEquals(key!.algorithm, "rsa")
    assert(key!.keyBytes.length > 0)
  })

  it("reads the complete SubjectPublicKeyInfo that RFC 6376's example publishes", async () => {
    const { raw, record } = await fixture("rfc6376-rsa")
    const key = parseDkimPublicKey(record)
    assert(key !== null)
    assertEquals(key!.algorithm, "rsa")
    assertEquals(Array.from(key!.keyBytes.slice(0, 2)), [0x30, 0x81])
    assert((await verifyDkim(raw, key)).valid)
  })

  it("defaults k= to rsa when the tag is absent", () => {
    const key = parseDkimPublicKey("v=DKIM1; p=AAECAw==")
    assertEquals(key!.algorithm, "rsa")
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
  })

  it("returns null for a revoked key whose p= is empty", () => {
    assertEquals(parseDkimPublicKey("v=DKIM1; k=rsa; p="), null)
    assertEquals(parseDkimPublicKey("v=DKIM1; k=rsa; p= ;"), null)
  })

  it("reads an Ed25519 key", () => {
    const key = parseDkimPublicKey(
      "v=DKIM1; k=ed25519; p=33CMZqe4Ls/aN5t24/BYKcgvLOKMsxd15ySdfaE4yhE=",
    )
    assertEquals(key!.algorithm, "ed25519")
    assertEquals(key!.keyBytes.length, 32)
  })

  it("ignores whitespace inside a split base64 value", () => {
    const key = parseDkimPublicKey("v=DKIM1; k=rsa; p=AAEC Aw==")
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
  })

  it("rejects a record with no p= tag", () => {
    assertThrows(() => parseDkimPublicKey("v=DKIM1; k=rsa"), DkimParseError, "no p= tag")
    assertThrows(() => parseDkimPublicKey(""), DkimParseError, "no p= tag")
  })

  it("rejects an unsupported key algorithm", () => {
    assertThrows(
      () => parseDkimPublicKey("v=DKIM1; k=dsa; p=AAECAw=="),
      DkimParseError,
      "unsupported DKIM key algorithm: dsa",
    )
  })

  it("rejects a p= value that is not base64", () => {
    assertThrows(
      () => parseDkimPublicKey("v=DKIM1; k=rsa; p=!!!!"),
      DkimParseError,
      "not valid base64",
    )
  })
})

// --- injected resolver -----------------------------------------------------

describe("fetchDkimPublicKey", () => {
  it("queries <selector>._domainkey.<domain> and parses the answer", async () => {
    const calls: string[] = []
    const resolver: DnsTxtResolver = {
      resolveTxt: (name) => {
        calls.push(name)
        return Promise.resolve([["v=DKIM1; k=rsa; p=AAECAw=="]])
      },
    }
    const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
    assertEquals(calls, ["sel._domainkey.example.com"])
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
  })

  it("concatenates the strings of one TXT record without a separator", async () => {
    // §3.6.2.2: the strings of one record are joined with nothing at all. This
    // split lands inside `k=rsa`, so a separator does not merely pad the record,
    // it changes a tag's value and the record stops naming an algorithm. The old
    // vector split between tags, where a stray space is swallowed again by the
    // tag scanner and by the base64 decoder — which is how joining the parts with
    // a space stayed invisible to this suite (#74).
    const resolver: DnsTxtResolver = {
      resolveTxt: () => Promise.resolve([["v=DKIM1; k=r", "sa; p=AAEC", "Aw=="]]),
    }
    const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
    assertEquals(key!.algorithm, "rsa")
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
  })

  it("passes over a TXT record that is not a DKIM key", async () => {
    // §3.6.2.2 leaves the order of several records unspecified, and a domain may
    // publish anything beside its key. Reading the first record only threw the
    // whole lookup away when an unrelated record came back first.
    const resolver: DnsTxtResolver = {
      resolveTxt: () =>
        Promise.resolve([
          ["v=spf1 include:_spf.example.com ~all"],
          ["v=DKIM1; k=rsa; p=AAECAw=="],
        ]),
    }
    const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
  })

  it("reports the first record's error when no record holds a key", async () => {
    const resolver: DnsTxtResolver = {
      resolveTxt: () => Promise.resolve([["v=spf1 ~all"], ["also not a key"]]),
    }
    // The first record's own diagnosis, not a generic one: an SPF record read as
    // a DKIM one fails on its version tag, and saying so is what tells a caller
    // which record the resolver actually returned.
    await assertRejects(
      () => fetchDkimPublicKey("example.com", "sel", { resolver }),
      DkimParseError,
      "unsupported DKIM key record version: spf1",
    )
  })

  it("refuses to look up a domain or selector that is not a domain name", async () => {
    // The name is interpolated into whatever an injected resolver does with it —
    // a URL, for a DNS-over-HTTPS resolver — and `d=`/`s=` come from the message.
    // §3.1 allows letters, digits and interior hyphens only.
    let asked = 0
    const resolver: DnsTxtResolver = {
      resolveTxt: () => {
        asked += 1
        return Promise.resolve([["v=DKIM1; k=rsa; p=AAECAw=="]])
      },
    }
    await assertRejects(
      () => fetchDkimPublicKey("x.example/../?q=1&type=a #", "sel", { resolver }),
      DkimParseError,
      "d= tag is not a domain name",
    )
    await assertRejects(
      () => fetchDkimPublicKey("example.com", "sel/../evil", { resolver }),
      DkimParseError,
      "s= tag is not a domain name",
    )
    assertEquals(asked, 0, "a name that fails the check must never be looked up")
  })

  it("returns null when the answer holds a revoked key", async () => {
    const resolver: DnsTxtResolver = { resolveTxt: () => Promise.resolve([["v=DKIM1; p="]]) }
    assertEquals(await fetchDkimPublicKey("example.com", "sel", { resolver }), null)
  })

  it("rejects an empty answer rather than reporting a revoked key", async () => {
    const empty: DnsTxtResolver = { resolveTxt: () => Promise.resolve([]) }
    await assertRejects(
      () => fetchDkimPublicKey("example.com", "sel", { resolver: empty }),
      DkimParseError,
      "no p= tag",
    )
  })

  it("propagates a resolver failure", async () => {
    const failing: DnsTxtResolver = {
      resolveTxt: () => Promise.reject(new Error("dns lookup failed")),
    }
    await assertRejects(
      () => fetchDkimPublicKey("example.com", "sel", { resolver: failing }),
      Error,
      "dns lookup failed",
    )
  })
})

describe("verifyDkim with an injected resolver", () => {
  it("verifies using only the key the resolver returns", async () => {
    const { raw, record } = await fixture("dkimpy-relaxed")
    let calls = 0
    const resolver: DnsTxtResolver = {
      resolveTxt: () => {
        calls += 1
        return Promise.resolve([[record]])
      },
    }
    const result = await verifyDkim(raw, undefined, { resolver })
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(calls, 1)
  })

  it("reports a resolver failure as an invalid result", async () => {
    const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const resolver: DnsTxtResolver = {
      resolveTxt: () => Promise.reject(new Error("dns lookup failed")),
    }
    const result = await verifyDkim(raw, undefined, { resolver })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "dns lookup failed")
  })

  it("reports an empty DNS answer as an invalid result", async () => {
    const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const resolver: DnsTxtResolver = { resolveTxt: () => Promise.resolve([]) }
    const result = await verifyDkim(raw, undefined, { resolver })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "DKIM TXT record has no p= tag")
  })

  it("assembles a key split across several TXT strings", async () => {
    const { record, raw } = await fixture("dkimpy-relaxed")
    const half = Math.floor(record.length / 2)
    const resolver: DnsTxtResolver = {
      resolveTxt: () => Promise.resolve([[record.slice(0, half), record.slice(half)]]),
    }
    const result = await verifyDkim(raw, undefined, { resolver })
    assert(result.valid, `reason=${result.reason}`)
  })

  it("reports a revoked key when p= is empty", async () => {
    const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const resolver: DnsTxtResolver = { resolveTxt: () => Promise.resolve([["v=DKIM1; p="]]) }
    const result = await verifyDkim(raw, undefined, { resolver })
    assertEquals(result.valid, false)
    assertEquals(result.reason, "DKIM key revoked (p= is empty)")
  })
})

// --- end-to-end with the independent signer --------------------------------

describe("verifyDkim", () => {
  it("verifies a relaxed message signed by a second implementation", async () => {
    const { raw, publicKey, input } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      extraTags: "t=1700000000",
    })
    const result = await verifyDkim(raw, publicKey, { now: 1700001000n })
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.domain, "example.com")
    // §3.7 step 2: the input ends at the emptied b= tag with no trailing CRLF,
    // and the body hash is not appended — it is the bh= tag inside the field.
    assert(input.endsWith("; b="), `signer input tail: ${JSON.stringify(input.slice(-20))}`)
  })

  it("verifies a simple-mode message signed by a second implementation", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", { mode: "simple" })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  // §3.4 lets the header and body halves of c= differ, and nothing else in this
  // file pairs them: every fixture and every other sign() call uses one mode for
  // both halves, so a verifier that read one half twice — or applied the header
  // mode to the body — passed the entire suite. The body carries WSP that the two
  // algorithms canonicalize differently, so their digests are distinct and a
  // swapped half cannot hide behind a coincidentally equal hash.
  for (const [header, body] of [["relaxed", "simple"], ["simple", "relaxed"]] as const) {
    it(`verifies a mixed c=${header}/${body} message end to end`, async () => {
      const bodyText = "This is  a test. \r\n"
      const { raw, publicKey } = await sign(TEST_HEADERS, bodyText, {
        mode: header,
        bodyMode: body,
      })
      const result = await verifyDkim(raw, publicKey)
      assert(result.valid, `reason=${result.reason}`)
      assertEquals(result.parsed?.canonicalization, { header, body })
      assert(
        await sha256Base64(canonBody(bodyText, header)) !==
          await sha256Base64(canonBody(bodyText, body)),
        "the two body canonicalizations must differ, or the body half is untested",
      )
      assertEquals(result.computedBodyHash, await sha256Base64(canonBody(bodyText, body)))
      assertEquals(
        result.computedBodyHash,
        result.parsed?.bodyHash,
        "the body half of c= is the one that hashes the body",
      )
    })
  }

  it("verifies a message whose DKIM-Signature is folded over three lines", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      foldSignature: true,
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("verifies an Ed25519 message signed by a second implementation", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", { ed25519: true })
    assertEquals(publicKey.algorithm, "ed25519")
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("rejects a body with one flipped byte", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n")
    assert((await verifyDkim(raw, publicKey)).valid)

    const tampered = raw.replace("This is a test.", "This is a tesu.")
    assertEquals(tampered.length, raw.length)
    const result = await verifyDkim(tampered, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "body hash mismatch (body modified after signing)")
  })

  it("keeps verifying when a byte is appended after the signed length", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      extraTags: "l=17",
    })
    assert((await verifyDkim(raw, publicKey)).valid)
    const result = await verifyDkim(`${raw}one more line\r\n`, publicKey)
    assert(result.valid, `l= covers only the signed octets; reason=${result.reason}`)
  })

  it("rejects a modified header", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const tampered = raw.replace("Subject: DKIM port smoke test", "Subject: DKIM port smoke tesu")
    const result = await verifyDkim(tampered, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "signature did not verify against public key")
  })

  it("verifies a repeated header using both occurrences bottom-up", async () => {
    const headers = [
      "Received: from one.example by mx.example; Fri, 1 Jan 2027 00:00:00 +0000",
      "Received: from two.example by mx.example; Fri, 1 Jan 2027 00:00:01 +0000",
      ...TEST_HEADERS,
    ]
    const { raw, publicKey } = await sign(headers, "This is a test.\r\n", {
      names: ["received", "received", "from", "to", "subject"],
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.signedHeaders, ["received", "received", "from", "to", "subject"])
  })

  it("verifies when h= names a header the message does not have", async () => {
    // §3.5: a listed name with no matching field contributes nothing.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["from", "to", "subject", "x-absent"],
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
  })

  it("rejects a new instance of a header the h= list already consumed", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["from", "to", "subject"],
    })
    const withExtra = raw.replace(
      "Subject: DKIM port smoke test",
      "Subject: DKIM port smoke test\r\nSubject: injected",
    )
    const result = await verifyDkim(withExtra, publicKey)
    assertEquals(result.valid, false)
    // The exact reason is the assertion: `valid === false` on its own is also what
    // a body hash mismatch and a signature mismatch return, which is how this test
    // stayed green with the §5.4.2 guard deleted. See the appended-instance suite
    // at the end of this file for the position where that acceptance is reachable.
    assertEquals(result.reason, "unsigned additional instances of a signed header: subject")
  })

  it("reports an expired signature", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      extraTags: "x=1800000000",
    })
    assert((await verifyDkim(raw, publicKey, { now: 1700000000n })).valid)
    const expired = await verifyDkim(raw, publicKey, { now: 1900000000n })
    assertEquals(expired.valid, false)
    assertEquals(expired.reason, "signature expired")
  })

  // A positive suite is only as strong as its negatives. Each mutation below is
  // applied to a message that must first verify, across both canonicalization
  // modes and both algorithms, so no single mode can carry the whole matrix.
  for (const mode of ["relaxed", "simple"] as const) {
    for (const useEd25519 of [false, true]) {
      const label = `${mode}/${useEd25519 ? "ed25519" : "rsa"}`
      const tamper = (raw: string, from: string, to: string) => raw.replace(from, to)

      it(`rejects a one-bit body change (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)
        const result = await verifyDkim(tamper(raw, "This is a tes", "This is a tez"), publicKey)
        assertEquals(result.valid, false)
        assertEquals(result.reason, "body hash mismatch (body modified after signing)")
      })

      it(`rejects a signed-header change (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)
        const result = await verifyDkim(
          tamper(raw, "Subject: DKIM port smoke test", "Subject: DKIM port smoke tesu"),
          publicKey,
        )
        assertEquals(result.valid, false)
        assertEquals(result.reason, "signature did not verify against public key")
      })

      it(`rejects a one-bit change to the signature itself (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)
        const match = /b=([A-Za-z0-9+/=]+)/.exec(raw)!
        const original = match[1]
        const at = 5
        const flipped = original.slice(0, at) +
          (original[at] === "A" ? "B" : "A") + original.slice(at + 1)
        const result = await verifyDkim(raw.replace(original, flipped), publicKey)
        assertEquals(result.valid, false)
      })

      it(`rejects a removed signed header (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)
        const result = await verifyDkim(
          raw.replace("To: recipient@example.org\r\n", ""),
          publicKey,
        )
        assertEquals(result.valid, false)
      })

      it(`rejects a signature checked against a different key of the same algorithm (${label})`, async () => {
        const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        // A second key of the same algorithm, so the crypto actually runs. The
        // cross-algorithm key below is rejected by the algorithm guard before any
        // verification, which is why it cannot stand in for this case: it left
        // `signature did not verify against public key` — the reason a forged
        // message really produces — untested for both algorithms.
        const other = useEd25519
          ? await ed25519Key(await ed25519("other"))
          : await rsaKey(await rsa("other"))
        const result = await verifyDkim(raw, other)
        assertEquals(result.valid, false)
        assertEquals(result.reason, "signature did not verify against public key")
        assert(
          result.computedBodyHash === result.parsed?.bodyHash,
          "the body is untouched, so the rejection must come from the signature",
        )
      })

      it(`rejects a signature checked against the other algorithm's key (${label})`, async () => {
        const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        // The other algorithm's key material: a distinct check from the one above,
        // and the one that names the algorithm mismatch in the reason.
        const other = useEd25519 ? await rsaKey(await rsa()) : await ed25519Key(await ed25519())
        const result = await verifyDkim(raw, other)
        assertEquals(result.valid, false)
        assertEquals(
          result.reason,
          useEd25519
            ? "algorithm/key mismatch (signature ed25519-sha256 vs key rsa)"
            : "algorithm/key mismatch (signature rsa-sha256 vs key ed25519)",
        )
      })
    }
  }

  it("reports a message with no DKIM-Signature header", async () => {
    const result = await verifyDkim("From: a@example.com\r\n\r\nbody\r\n")
    assertEquals(result.valid, false)
    assertEquals(result.reason, "no DKIM-Signature header found")
  })

  it("reports an unparsable DKIM-Signature header", async () => {
    const raw = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com\r\n\r\nbody\r\n"
    const result = await verifyDkim(raw, await rsaKey(await rsa()))
    assertEquals(result.valid, false)
    assertEquals(result.reason, "DKIM-Signature missing required tag: s")
  })

  it("refuses a message larger than the cap it was given", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const result = await verifyDkim(raw, publicKey, { maxMessageLength: raw.length - 1 })
    assertEquals(result.valid, false)
    assertEquals(
      result.reason,
      `message is ${raw.length} characters, over the ${raw.length - 1}-character limit`,
    )
    // Nothing was parsed or hashed: the message never reached the verifier.
    assertEquals(result.parsed, undefined)
    assertEquals(result.computedBodyHash, undefined)
  })

  it("verifies a message that is exactly the size of the cap", async () => {
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const result = await verifyDkim(raw, publicKey, { maxMessageLength: raw.length })
    assert(result.valid, `reason=${result.reason}`)
  })

  it("refuses a message over the default cap", async () => {
    // The default has to be enforced, not merely available: a caller that passes
    // no options is the one this protects.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n")
    const oversized = raw + " ".repeat(DEFAULT_MAX_MESSAGE_LENGTH)
    const result = await verifyDkim(oversized, publicKey)
    assertEquals(result.valid, false)
    assertStringIncludes(result.reason ?? "", `over the ${DEFAULT_MAX_MESSAGE_LENGTH}-character`)
    assertEquals(DEFAULT_MAX_MESSAGE_LENGTH, 10 * 1024 * 1024)
  })
})

// --- an appended instance of a header the signature already covers ----------

/**
 * RFC 6376 §5.4.2: listing a name in `h=` as many times as the message held
 * instances of it is how a signer notices that the message grew another one.
 * `selectSignedHeaders` pairs the list with the message bottom-up and then
 * refuses a message that still holds an instance of a name it was asked for.
 *
 * That guard is load-bearing and was invisible to this suite: with the throw
 * replaced by nothing at all, every other test here still passed, while an
 * appended header was accepted outright (`valid: true`) in the "top" position
 * below — the location where header selection happens to consume the *original*
 * instance and leaves the attacker's copy outside the hash. The reason string is
 * what makes these tests discriminating: `valid === false` is also returned by a
 * body hash mismatch and by a signature mismatch, so it cannot tell the guard
 * from a rejection by accident.
 */
describe("an appended instance of a header the signature covers (§5.4.2)", () => {
  const GUARD_REASON = "unsigned additional instances of a signed header: subject"

  for (const mode of ["relaxed", "simple"] as const) {
    for (const useEd25519 of [false, true]) {
      const label = `${mode}/${useEd25519 ? "ed25519" : "rsa"}`

      it(`rejects a Subject: prepended above the block (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)

        // The acceptance case. Bottom-up selection reaches the signed instance
        // first when the injected copy sits at the top of the block, so every
        // other check agrees with the attacker: the header hash is unchanged and
        // the message verifies with a Subject: the signer never saw.
        const attacked = injectHeader(raw, "Subject", "top")
        assert(
          !raw.startsWith("Subject:") && attacked.startsWith("Subject: injected"),
          "the injected field must be new to the message",
        )
        const result = await verifyDkim(attacked, publicKey)
        assertEquals(result.valid, false)
        assertEquals(result.reason, GUARD_REASON)
      })

      it(`rejects a Subject: appended below the signature (${label})`, async () => {
        const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        assert((await verifyDkim(raw, publicKey)).valid)

        // The other position, where an unguarded verifier would select the
        // injected instance and then fail the signature check — a rejection for a
        // reason that has nothing to do with §5.4.2. Asserting the guard's own
        // reason is what separates "refused by rule" from "failed by accident".
        const attacked = injectHeader(raw, "Subject", "below-signature")
        const result = await verifyDkim(attacked, publicKey)
        assertEquals(result.valid, false)
        assertEquals(result.reason, GUARD_REASON)
      })
    }
  }
})

// --- §3.5: whitespace inside the bh= tag ------------------------------------

/**
 * RFC 6376 §3.5, on bh=: "Whitespace is ignored in this value and MUST be ignored
 * when reassembling the original signature. In particular, the signing process
 * can safely insert FWS in this value in arbitrary places to conform to
 * line-length limits." §3.2 states the rule the exception sits in: whitespace
 * inside a value "MUST be retained unless explicitly excluded by the specific tag
 * description", and bh= is one of the tags that excludes it.
 *
 * Every vector here is signed *with* the whitespace in place, so the whitespace
 * is inside the bytes the signature covers and the message is one a conformant
 * signer can emit. That distinction matters: whitespace inserted into a message
 * after signing changes the canonical field, and rejecting such a message is
 * correct — see "still rejects whitespace added to a signed signature field"
 * below, which pins exactly that.
 */
describe("whitespace inside the bh= tag (§3.5)", () => {
  const BODY = "This is a test.\r\n"

  // A bare SP or HTAB inside a single-line bh= value. The verifier compared the
  // tag's text against a digest that never contains WSP, so one space made the
  // two unequal by length alone and the message came back "body modified after
  // signing" — rejecting mail that was signed exactly as it arrived.
  for (const mode of ["relaxed", "simple"] as const) {
    it(`verifies a message whose bh= carries a literal SP (${mode})`, async () => {
      const { raw, publicKey } = await sign(TEST_HEADERS, BODY, {
        mode,
        bodyHashWsp: { at: 20, kind: "space" },
      })
      const expected = await sha256Base64(canonBody(BODY, mode))
      assert(
        raw.includes(`bh=${expected.slice(0, 20)} ${expected.slice(20)}`),
        "the message must carry the SP inside its bh= value",
      )

      const result = await verifyDkim(raw, publicKey)
      assert(result.valid, `reason=${result.reason}`)
      assertEquals(result.computedBodyHash, expected)
      assertEquals(result.parsed?.bodyHash, expected)
      assert(
        !/\s/.test(result.parsed!.bodyHash),
        "the parsed bh= value must carry no WSP",
      )
    })
  }

  // A fold inside bh=, which §3.5 names explicitly as safe for a signer. These
  // already verified — `unfold` drops a fold entirely, so the parsed value was
  // clean — and they are here so that a future change to how the value is
  // normalised cannot quietly take the fold path with it.
  for (const mode of ["relaxed", "simple"] as const) {
    it(`verifies a message whose bh= is folded mid-value (${mode})`, async () => {
      const { raw, publicKey } = await sign(TEST_HEADERS, BODY, {
        mode,
        bodyHashWsp: { at: 20, kind: "fold" },
      })
      assert(raw.includes("bh="), "the fixture must carry a folded bh= value")
      assert(
        raw.includes(`bh=${(await sha256Base64(canonBody(BODY, mode))).slice(0, 20)}\r\n\t`),
        "the fold must land inside the bh= value",
      )

      const result = await verifyDkim(raw, publicKey)
      assert(result.valid, `reason=${result.reason}`)
      assertEquals(result.parsed?.bodyHash, await sha256Base64(canonBody(BODY, mode)))
    })
  }

  it("still rejects whitespace added to a signed signature field", async () => {
    // The other direction, and the reason the fix is not simply "strip WSP
    // wherever it appears in the field": §3.7 step 2 hashes the field as the
    // message carries it, so whitespace that was not there when the signer signed
    // changes the signed bytes. Under relaxed canonicalization a fold becomes one
    // SP, which is enough to break the signature.
    const { raw, publicKey } = await sign(TEST_HEADERS, BODY, { mode: "relaxed" })
    assert((await verifyDkim(raw, publicKey)).valid)

    const value = /bh=([A-Za-z0-9+/=]+)/.exec(raw)![1]
    const folded = raw.replace(`bh=${value}`, `bh=${value.slice(0, 20)}\r\n\t${value.slice(20)}`)
    const result = await verifyDkim(folded, publicKey)
    assertEquals(result.valid, false)
    assertEquals(result.reason, "signature did not verify against public key")
  })
})
