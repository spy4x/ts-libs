// Behaviour tests for `platform/signed-payload.ts`.
//
// The clock is injected everywhere expiry matters: no `Date.now()` in an assertion path, no sleeps,
// no network, no writes, no env reads.

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import { type } from "arktype"
import {
  createSignedPayloadCodec,
  MAX_SIGNED_PAYLOAD_LENGTH,
  SignedPayloadError,
  SignedPayloadErrorCode,
} from "./signed-payload.ts"
import { TokenError, TokenErrorCode } from "./tokens.ts"

/** Obviously fake secret fixtures. Long enough for `MIN_SECRET_LENGTH`, never a realistic key. */
const SECRET = "test-secret-not-real-0123456789abcdef"
const OTHER_SECRET = "another-test-secret-0123456789abcdef"

const pageKey = type({ updatedAt: "string", id: "string", "+": "reject" })
const PAGE = { updatedAt: "2026-09-25T00:00:00.000Z", id: "b3f1c2d4-0000-4000-8000-000000000001" }

/** A cursor-shaped codec with an injectable clock. */
function cursorCodec(overrides: { purpose?: string; version?: number; now?: () => number } = {}) {
  return createSignedPayloadCodec({
    secret: SECRET,
    purpose: overrides.purpose ?? "groups.list",
    version: overrides.version ?? 1,
    schema: pageKey,
    now: overrides.now,
  })
}

/**
 * Signs arbitrary envelope bytes exactly as the codec does, so a test can build a token whose
 * signature is valid but whose content the codec itself would never produce.
 */
async function signRawEnvelope(envelope: Uint8Array, context = ""): Promise<string> {
  const encoded = encodeBase64Url(envelope)
  const domain = new TextEncoder().encode("spy4x.signed-payload.v1")
  const contextBytes = new TextEncoder().encode(context)
  const body = new TextEncoder().encode(encoded)
  const input = new Uint8Array(domain.length + 5 + contextBytes.length + body.length)
  input.set(domain, 0)
  new DataView(input.buffer).setUint32(domain.length + 1, contextBytes.length)
  input.set(contextBytes, domain.length + 5)
  input.set(body, domain.length + 5 + contextBytes.length)
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, input))
  return `${encoded}.${encodeBase64Url(signature)}`
}

/** Reads a token's envelope without verifying it. */
function readEnvelope(token: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(token.split(".")[0])))
}

Deno.test("signed payload — a signed payload verifies back to the same value", async () => {
  const codec = cursorCodec()
  const token = await codec.sign(PAGE, { context: "42" })
  assertEquals(await codec.verify(token, { context: "42" }), { ok: true, value: PAGE })
})

Deno.test("signed payload — verify returns the schema's output, not the raw JSON", async () => {
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "dated",
    version: 1,
    schema: type({ at: "string.date.iso.parse" }),
  })
  const result = await codec.verify(await codec.sign({ at: "2026-09-25T00:00:00.000Z" }))
  assert(result.ok)
  assert(result.value.at instanceof Date)
  assertEquals(result.value.at.toISOString(), "2026-09-25T00:00:00.000Z")
})

Deno.test("signed payload — a token signed for one purpose is refused under another", async () => {
  const token = await cursorCodec({ purpose: "groups.list" }).sign(PAGE)
  assertEquals(await cursorCodec({ purpose: "users.list" }).verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.WrongPurpose,
  })
})

Deno.test("signed payload — structurally broken tokens are refused as malformed", async () => {
  const codec = cursorCodec()
  const token = await codec.sign(PAGE)
  const [encoded, signature] = token.split(".")
  const broken = [
    "",
    ".",
    encoded,
    `${encoded}.`,
    `.${signature}`,
    `${token}.${signature}`,
    `${signature}.${encoded}`,
    `${encoded}.${signature}=`,
    `${encoded}!.${signature}`,
    `${encoded}.${signature.slice(0, -1)}`,
  ]
  for (const candidate of broken) {
    assertEquals(
      await codec.verify(candidate),
      { ok: false, error: SignedPayloadErrorCode.Malformed },
      JSON.stringify(candidate),
    )
  }
})

Deno.test("signed payload — a non-canonical base64url spelling of the signature is malformed", async () => {
  const codec = cursorCodec()
  const token = await codec.sign(PAGE)
  const [encoded, signature] = token.split(".")
  // 32 bytes leave two unused low bits in the last character; setting one keeps the bytes the same.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const last = alphabet.indexOf(signature.at(-1) as string)
  const variant = signature.slice(0, -1) + alphabet[last ^ 1]
  assertEquals(decodeBase64Url(variant), decodeBase64Url(signature))
  assertEquals(await codec.verify(`${encoded}.${variant}`), {
    ok: false,
    error: SignedPayloadErrorCode.Malformed,
  })
})

Deno.test("signed payload — a token longer than the cap is refused before decoding", async () => {
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "notes",
    version: 1,
    schema: type({ text: "string" }),
  })
  const fits = await codec.sign({ text: "x".repeat(2900) })
  assert(fits.length <= MAX_SIGNED_PAYLOAD_LENGTH)
  assert((await codec.verify(fits)).ok)
  const tooLong = await codec.sign({ text: "x".repeat(3100) })
  assert(tooLong.length > MAX_SIGNED_PAYLOAD_LENGTH)
  assertEquals(await codec.verify(tooLong), { ok: false, error: SignedPayloadErrorCode.Malformed })
})

Deno.test("signed payload — a validly signed envelope that is not JSON is malformed, not a SyntaxError", async () => {
  const token = await signRawEnvelope(new TextEncoder().encode("{not json"))
  assertEquals(await cursorCodec().verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.Malformed,
  })
})

Deno.test("signed payload — a validly signed envelope with an extra key is malformed", async () => {
  const envelope = { purpose: "groups.list", version: 1, payload: PAGE, admin: true }
  const token = await signRawEnvelope(new TextEncoder().encode(JSON.stringify(envelope)))
  assertEquals(await cursorCodec().verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.Malformed,
  })
})

Deno.test("signed payload — an altered payload keeps its old signature and is refused", async () => {
  const codec = cursorCodec()
  const token = await codec.sign(PAGE)
  const envelope = readEnvelope(token)
  envelope.payload = { ...PAGE, id: "b3f1c2d4-0000-4000-8000-000000000002" }
  const forged = `${encodeBase64Url(new TextEncoder().encode(JSON.stringify(envelope)))}.${
    token.split(".")[1]
  }`
  assertEquals(await codec.verify(forged), {
    ok: false,
    error: SignedPayloadErrorCode.BadSignature,
  })
})

Deno.test("signed payload — a token signed with another secret is refused", async () => {
  const other = createSignedPayloadCodec({
    secret: OTHER_SECRET,
    purpose: "groups.list",
    version: 1,
    schema: pageKey,
  })
  assertEquals(await cursorCodec().verify(await other.sign(PAGE)), {
    ok: false,
    error: SignedPayloadErrorCode.BadSignature,
  })
})

Deno.test("signed payload — a token verified with another bound context is refused", async () => {
  const codec = cursorCodec()
  const token = await codec.sign(PAGE, { context: "42" })
  for (const context of ["43", "", undefined]) {
    assertEquals(
      await codec.verify(token, { context }),
      { ok: false, error: SignedPayloadErrorCode.BadSignature },
      String(context),
    )
  }
})

Deno.test("signed payload — an absent context and an empty one are the same context", async () => {
  const codec = cursorCodec()
  assert((await codec.verify(await codec.sign(PAGE), { context: "" })).ok)
  assert((await codec.verify(await codec.sign(PAGE, { context: "" }))).ok)
})

Deno.test("signed payload — the bound context is not carried in the token", async () => {
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "unsubscribe",
    version: 1,
    schema: type({ "+": "reject" }),
  })
  const token = await codec.sign({}, { context: "reader@example.com" })
  assertEquals(readEnvelope(token), { purpose: "unsubscribe", version: 1, payload: {} })
  assert((await codec.verify(token, { context: "reader@example.com" })).ok)
})

Deno.test("signed payload — a token is refused once the clock reaches its expiry", async () => {
  let clock = 1_000_000
  const codec = cursorCodec({ now: () => clock })
  const token = await codec.sign(PAGE, { ttlMs: 60_000 })
  assertEquals(readEnvelope(token).expiresAt, 1_060_000)
  clock = 1_059_999
  assert((await codec.verify(token)).ok)
  clock = 1_060_000
  assertEquals(await codec.verify(token), { ok: false, error: SignedPayloadErrorCode.Expired })
})

Deno.test("signed payload — a token signed without a lifetime never expires", async () => {
  let clock = 0
  const codec = cursorCodec({ now: () => clock })
  const token = await codec.sign(PAGE)
  assertEquals("expiresAt" in readEnvelope(token), false)
  clock = Number.MAX_SAFE_INTEGER
  assert((await codec.verify(token)).ok)
})

Deno.test("signed payload — a payload the schema rejects is refused as invalid", async () => {
  const loose = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "groups.list",
    version: 1,
    schema: type({ updatedAt: "string", id: "string", "extra?": "boolean" }),
  })
  const token = await loose.sign({ ...PAGE, extra: true })
  assertEquals(await cursorCodec().verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.InvalidPayload,
  })
})

Deno.test("signed payload — a token of another payload version is refused as invalid", async () => {
  const token = await cursorCodec({ version: 1 }).sign(PAGE)
  assertEquals(await cursorCodec({ version: 2 }).verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.InvalidPayload,
  })
})

Deno.test("signed payload — sign refuses a payload that would not verify", async () => {
  const error = await assertRejects(
    // Deliberately off-schema, the way an untyped caller could send it.
    () => cursorCodec().sign({ ...PAGE, admin: true } as unknown as typeof PAGE),
    SignedPayloadError,
  )
  assertEquals(error.code, SignedPayloadErrorCode.InvalidPayload)
})

Deno.test("signed payload — sign refuses a lifetime that is not a positive integer", async () => {
  const codec = cursorCodec()
  for (const ttlMs of [0, -1, 1.5, Number.NaN]) {
    await assertRejects(() => codec.sign(PAGE, { ttlMs }), RangeError)
  }
})

Deno.test("signed payload — a secret shorter than the minimum is refused", () => {
  const error = assertThrows(
    () => createSignedPayloadCodec({ secret: "short", purpose: "p", version: 1, schema: pageKey }),
    TokenError,
  )
  assertEquals(error.code, TokenErrorCode.InvalidSecret)
})

Deno.test("signed payload — an empty purpose or a non-positive version is refused", () => {
  assertThrows(
    () => createSignedPayloadCodec({ secret: SECRET, purpose: "", version: 1, schema: pageKey }),
    TypeError,
  )
  for (const version of [0, 1.5]) {
    assertThrows(
      () => createSignedPayloadCodec({ secret: SECRET, purpose: "p", version, schema: pageKey }),
      TypeError,
    )
  }
})
