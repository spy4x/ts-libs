// Tests for the RFC 6376 verifier.
//
// Two independent sources of truth, neither of which is this package:
//
//  1. `fixtures/` — messages signed with dkimpy 1.1.8's canonicalizers plus
//     `openssl dgst -sha256 -sign`, every one asserted valid by dkimpy itself.
//     RFC 6376's own signed example is among them. These catch a verifier that
//     agrees only with itself, which is exactly how the first port of this file
//     shipped a canonicalization bug behind a green suite.
//  2. `sign()` below — a deliberately hand-written second implementation of
//     §3.4 canonicalization and §3.7 hash steps, used for the tamper cases. It
//     shares no code with `dkim-verify.ts`: importing the module's own
//     canonicalizers would make "valid" prove only that two copies of one
//     mistake agree.
//
// Nothing here touches the network. Keys are fixture records or generated
// in-process by Web Crypto; no private key is committed.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  canonicalizeBody,
  canonicalizeHeader,
  DkimParseError,
  type DkimPublicKey,
  type DnsTxtResolver,
  fetchDkimPublicKey,
  parseDkimPublicKey,
  parseDkimSignature,
  sha256Base64,
  splitMessage,
  verifyDkim,
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

let rsaPair: Promise<CryptoKeyPair> | undefined
let ed25519Pair: Promise<CryptoKeyPair> | undefined

/** Memoised 2048-bit RSA pair, generated in-process. */
function rsa(): Promise<CryptoKeyPair> {
  rsaPair ??= crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>
  return rsaPair
}

/** Memoised Ed25519 pair, generated in-process. */
function ed25519(): Promise<CryptoKeyPair> {
  ed25519Pair ??= crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as Promise<CryptoKeyPair>
  return ed25519Pair
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

interface SignOptions {
  mode?: "simple" | "relaxed"
  /** Header names to sign, in h= order. */
  names?: string[]
  /** Extra tags before b=, e.g. `l=17` or `x=1800000000`. */
  extraTags?: string
  /** Tags placed *after* b=, which §3.7 step 2 leaves inside the signed bytes. */
  afterB?: string
  ed25519?: boolean
  foldSignature?: boolean
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
  const names = options.names ?? ["from", "to", "subject"]
  const bodyHash = await sha256Base64(canonBody(body, mode))
  const stub = `v=1; a=${options.ed25519 ? "ed25519-sha256" : "rsa-sha256"}; ` +
    `c=${mode}/${mode}; d=example.com; s=sel; h=${names.join(":")}; bh=${bodyHash}` +
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

  const pair = options.ed25519 ? await ed25519() : await rsa()
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
  const publicKey = options.ed25519 ? await ed25519Key(await ed25519()) : await rsaKey(await rsa())
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
  it("verifies the RSA-signed example from §3.5", async () => {
    const { raw, record } = await fixture("rfc6376-rsa")
    const result = await verifyDkim(raw, parseDkimPublicKey(record) ?? undefined)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.domain, "football.example.com")
    assertEquals(result.parsed?.selector, "test")
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

  for (const attack of ["; x=9999999999", "; i=@attacker.invalid", "; l=1"]) {
    it(`rejects ${attack} appended to a genuine signature`, async () => {
      // The payload lands inside the hashed field, so it changes the signed
      // bytes: an attacker cannot move the expiry or the identity this way.
      const { raw, record } = await fixture("dkimpy-relaxed")
      const lines = raw.split("\r\n")
      lines[0] = `${lines[0]}${attack}`
      const result = await verifyDkim(
        lines.join("\r\n"),
        parseDkimPublicKey(record) ?? undefined,
      )
      assertEquals(result.valid, false)
      assertEquals(result.reason, "signature did not verify against public key")
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

  it("verifies an unsigned From: — §5.4 binds the signer, not the verifier", async () => {
    // §5.4 requires a signer to include From in h=; §6.1.1 and §6.1.2 add no
    // verifier check that it did. Requiring it here would reject conformant
    // verification results, so it is caller policy: read `h=` yourself.
    const { raw, publicKey } = await sign(TEST_HEADERS, "This is a test.\r\n", {
      names: ["to", "subject"],
    })
    const result = await verifyDkim(raw, publicKey)
    assert(result.valid, `reason=${result.reason}`)
    assertEquals(result.parsed?.signedHeaders.includes("from"), false)
  })

  it("verifies a message that has no From: at all", async () => {
    // RFC 5322 requires From:, but DKIM verification is not where it is enforced:
    // a From-less message is malformed mail, not an invalid signature.
    const headers = ["To: recipient@example.org", "Subject: DKIM port smoke test"]
    const { raw, publicKey } = await sign(headers, "This is a test.\r\n", {
      names: ["to", "subject"],
    })
    assert(!raw.includes("From:"))
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
    const resolver: DnsTxtResolver = {
      resolveTxt: () => Promise.resolve([["v=DKIM1; k=rsa; ", "p=AAEC", "Aw=="]]),
    }
    const key = await fetchDkimPublicKey("example.com", "sel", { resolver })
    assertEquals(Array.from(key!.keyBytes), [0, 1, 2, 3])
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

      it(`rejects a signature checked against the wrong key (${label})`, async () => {
        const { raw } = await sign(TEST_HEADERS, "This is a test.\r\n", {
          mode,
          ed25519: useEd25519,
        })
        // The other algorithm's key material: same curve/format, different key.
        const other = useEd25519 ? await rsaKey(await rsa()) : await ed25519Key(await ed25519())
        const result = await verifyDkim(raw, other)
        assertEquals(result.valid, false)
        assert(
          result.reason !== undefined,
          "a wrong key must produce a reason",
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
})
