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

/** A notes codec whose envelope JSON is 53 bytes plus the text's length. */
function notesCodec() {
  return createSignedPayloadCodec({
    secret: SECRET,
    purpose: "notes",
    version: 1,
    schema: type({ text: "string" }),
  })
}

/** The envelope bytes `notesCodec` signs for `text`. */
function notesEnvelope(text: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ purpose: "notes", version: 1, payload: { text } }),
  )
}

Deno.test("signed payload — a token of exactly the cap signs and verifies", async () => {
  // 3,039 envelope bytes encode to 4,052 characters; with "." and the 43-character signature, 4,096.
  const token = await notesCodec().sign({ text: "x".repeat(3039 - 53) })
  assertEquals(token.length, MAX_SIGNED_PAYLOAD_LENGTH)
  assert((await notesCodec().verify(token)).ok)
})

Deno.test("signed payload — a validly signed token over the cap is refused as malformed", async () => {
  // One more envelope byte gives 4,098 characters: unpadded base64url has no length of 4,053, so no
  // well-formed token is 4,097 characters long.
  const token = await signRawEnvelope(notesEnvelope("x".repeat(3040 - 53)))
  assertEquals(token.length, MAX_SIGNED_PAYLOAD_LENGTH + 2)
  assertEquals(await notesCodec().verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.Malformed,
  })
})

Deno.test("signed payload — sign refuses a payload whose token would exceed the cap", async () => {
  const error = await assertRejects(
    () => notesCodec().sign({ text: "x".repeat(3040 - 53) }),
    SignedPayloadError,
  )
  assertEquals(error.code, SignedPayloadErrorCode.Malformed)
})

Deno.test("signed payload — a token that is not a string is refused as malformed", async () => {
  for (const token of [123, null, undefined, { length: 1 }]) {
    assertEquals(
      await cursorCodec().verify(token as unknown as string),
      { ok: false, error: SignedPayloadErrorCode.Malformed },
      String(token),
    )
  }
})

Deno.test("signed payload — a validly signed envelope that is not UTF-8 is malformed", async () => {
  // Valid JSON once a lenient decoder turns the 0xFF byte into U+FFFD, so only strict decoding
  // refuses it.
  const prefix = new TextEncoder().encode(
    `{"purpose":"groups.list","version":1,"payload":{"updatedAt":"`,
  )
  const suffix = new TextEncoder().encode(`","id":"x"}}`)
  const envelope = new Uint8Array([...prefix, 0xff, ...suffix])
  assertEquals(await cursorCodec().verify(await signRawEnvelope(envelope)), {
    ok: false,
    error: SignedPayloadErrorCode.Malformed,
  })
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

Deno.test("signed payload — context bytes cannot be shifted into the envelope", async () => {
  // "ICAg" is base64url for three spaces, which JSON.parse skips. Without the context's length in
  // the MAC input, the bytes signed for context "abcICAg" + envelope equal "abc" + "ICAg" + envelope.
  const codec = cursorCodec()
  const [encoded, signature] = (await codec.sign(PAGE, { context: "abcICAg" })).split(".")
  assertEquals(await codec.verify(`ICAg${encoded}.${signature}`, { context: "abc" }), {
    ok: false,
    error: SignedPayloadErrorCode.BadSignature,
  })
})

Deno.test("signed payload — the signed-bytes layout for a bound context is fixed", async () => {
  // Changing the layout would invalidate every token already sent, such as unsubscribe links.
  const expected = "eyJwdXJwb3NlIjoidW5zdWJzY3JpYmUiLCJ2ZXJzaW9uIjoxLCJwYXlsb2FkIjp7fX0." +
    "BR64ZVCbUkj8VrsJfrXzG47D9zLnsQAaRMuyuvVIoQI"
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "unsubscribe",
    version: 1,
    schema: type({ "+": "reject" }),
  })
  assertEquals(await codec.sign({}, { context: "reader@example.com" }), expected)
  const envelope = new TextEncoder().encode(`{"purpose":"unsubscribe","version":1,"payload":{}}`)
  assertEquals(await signRawEnvelope(envelope, "reader@example.com"), expected)
})

Deno.test("signed payload — sign refuses a value that JSON turns into another type", async () => {
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "dated",
    version: 1,
    schema: type({ at: "Date" }),
  })
  const error = await assertRejects(() => codec.sign({ at: new Date(0) }), SignedPayloadError)
  assertEquals(error.code, SignedPayloadErrorCode.InvalidPayload)
})

Deno.test("signed payload — sign refuses a payload JSON cannot serialise", async () => {
  const codec = createSignedPayloadCodec({
    secret: SECRET,
    purpose: "any",
    version: 1,
    schema: type("unknown"),
  })
  const circular: Record<string, unknown> = {}
  circular.self = circular
  for (const payload of [{ big: 1n }, circular, undefined, () => 1]) {
    const error = await assertRejects(() => codec.sign(payload), SignedPayloadError)
    assertEquals(error.code, SignedPayloadErrorCode.InvalidPayload)
  }
})

Deno.test("signed payload — a context with a lone surrogate is refused", async () => {
  const codec = cursorCodec()
  for (const context of ["user-\uD800", "user-\uDBFF"]) {
    await assertRejects(() => codec.sign(PAGE, { context }), TypeError)
  }
  // Both lone surrogates encode to the same UTF-8 bytes as U+FFFD.
  const token = await codec.sign(PAGE, { context: "user-\uFFFD" })
  assertEquals(await codec.verify(token, { context: "user-\uD800" }), {
    ok: false,
    error: SignedPayloadErrorCode.BadSignature,
  })
})

Deno.test("signed payload — an expiring token is refused when the clock is not an integer", async () => {
  let clock = 1_000_000
  const codec = cursorCodec({ now: () => clock })
  const token = await codec.sign(PAGE, { ttlMs: 60_000 })
  for (const broken of [Number.NaN, 1_000_000.5, Number.POSITIVE_INFINITY]) {
    clock = broken
    assertEquals(
      await codec.verify(token),
      { ok: false, error: SignedPayloadErrorCode.Expired },
      String(broken),
    )
  }
})

Deno.test("signed payload — sign refuses a lifetime when the clock is not an integer", async () => {
  for (const broken of [1000.5, Number.NaN]) {
    await assertRejects(
      () => cursorCodec({ now: () => broken }).sign(PAGE, { ttlMs: 1 }),
      RangeError,
    )
  }
})

Deno.test("signed payload — a wrong purpose is reported before an expiry", async () => {
  let clock = 0
  const token = await cursorCodec({ purpose: "groups.list", now: () => clock }).sign(PAGE, {
    ttlMs: 1,
  })
  clock = 10
  assertEquals(await cursorCodec({ purpose: "users.list", now: () => clock }).verify(token), {
    ok: false,
    error: SignedPayloadErrorCode.WrongPurpose,
  })
})
