// Behaviour tests for `platform/keyset-cursor.ts`. No clock, no network, no writes, no env reads.

import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert"
import { decodeBase64Url } from "@std/encoding/base64url"
import { type } from "arktype"
import {
  createKeysetCursorCodec,
  deriveCursorSecret,
  KeysetCursorError,
  KeysetCursorErrorCode,
} from "./keyset-cursor.ts"
import { createSignedPayloadCodec } from "./signed-payload.ts"
import { deriveSecret, TokenError, TokenErrorCode } from "./tokens.ts"

/** Obviously fake secret fixtures. Long enough for `MIN_SECRET_LENGTH`, never a realistic key. */
const SECRET = "test-secret-not-real-0123456789abcdef"
const OTHER_SECRET = "another-test-secret-0123456789abcdef"

const GROUP = "0b6f3c2e-5d4a-4c1b-9e8f-7a6b5c4d3e2f"
const OTHER_GROUP = "1c7a4d3f-6e5b-4d2c-8f9a-8b7c6d5e4f3a"
const SCOPE = { userId: 7, groupId: GROUP }
const PAGE = {
  updatedAt: new Date("2026-09-25T10:11:12.345Z"),
  id: "019237a1-7c3e-7b2d-9f10-1a2b3c4d5e6f",
}

function notesCodec(overrides: { secret?: string; purpose?: string } = {}) {
  return createKeysetCursorCodec({
    secret: overrides.secret ?? SECRET,
    purpose: overrides.purpose ?? "notes.list",
    scope: ["userId", "groupId"],
  })
}

/** Signs any object as a `notes.list` cursor would be signed, so a test can mint what `encode` never would. */
async function signOutsideEncoder(payload: object, context = JSON.stringify([7, GROUP])) {
  const codec = createSignedPayloadCodec({
    secret: await deriveCursorSecret(SECRET, "notes.list"),
    purpose: "notes.list",
    version: 1,
    schema: type("object"),
  })
  return codec.sign(payload, { context })
}

async function assertRefused(
  promise: Promise<unknown>,
  code: KeysetCursorErrorCode,
): Promise<void> {
  const error = await assertRejects(() => promise, KeysetCursorError)
  assertEquals(error.code, code)
}

Deno.test("keyset cursor — decodes back to the page key it encoded, with a Date", async () => {
  const codec = await notesCodec()
  const page = await codec.decode(await codec.encode(PAGE, SCOPE), SCOPE)
  assert(page.updatedAt instanceof Date)
  assertEquals(page, PAGE)
})

Deno.test("keyset cursor — a list with an empty scope round-trips", async () => {
  const codec = await createKeysetCursorCodec({ secret: SECRET, purpose: "posts.list", scope: [] })
  assertEquals(await codec.decode(await codec.encode(PAGE, {}), {}), PAGE)
})

Deno.test("keyset cursor — a custom page-key schema round-trips", async () => {
  const codec = await createKeysetCursorCodec({
    secret: SECRET,
    purpose: "scores.list",
    scope: ["userId"],
    pageKey: type({ score: "number.integer", id: "string", "+": "reject" }),
  })
  const page = { score: 42, id: "abc" }
  assertEquals(await codec.decode(await codec.encode(page, { userId: 1 }), { userId: 1 }), page)
})

Deno.test("keyset cursor — the cursor does not carry the scope values", async () => {
  const codec = await notesCodec()
  const cursor = await codec.encode(PAGE, SCOPE)
  const envelope = new TextDecoder().decode(decodeBase64Url(cursor.split(".")[0]))
  assert(!envelope.includes(GROUP), envelope)
  assert(!envelope.includes("userId"), envelope)
})

Deno.test("keyset cursor — changing any single character of a cursor is refused", async () => {
  const codec = await notesCodec()
  const cursor = await codec.encode(PAGE, SCOPE)
  for (let index = 0; index < cursor.length; index++) {
    const replacement = cursor[index] === "A" ? "B" : "A"
    const altered = cursor.slice(0, index) + replacement + cursor.slice(index + 1)
    const error = await assertRejects(() => codec.decode(altered, SCOPE), KeysetCursorError)
    assert(
      error.code === KeysetCursorErrorCode.BadSignature ||
        error.code === KeysetCursorErrorCode.Malformed,
      `index ${index} gave code ${error.code}`,
    )
  }
})

Deno.test("keyset cursor — a cursor presented under another scope is refused", async () => {
  const codec = await notesCodec()
  const cursor = await codec.encode(PAGE, SCOPE)
  for (
    const scope of [
      { userId: 8, groupId: GROUP },
      { userId: 7, groupId: OTHER_GROUP },
      { userId: "7", groupId: GROUP },
    ]
  ) {
    await assertRefused(codec.decode(cursor, scope), KeysetCursorErrorCode.BadSignature)
  }
})

Deno.test("keyset cursor — scope values cannot be shifted across a separator", async () => {
  const codec = await createKeysetCursorCodec({
    secret: SECRET,
    purpose: "notes.list",
    scope: ["a", "b"],
  })
  const cursor = await codec.encode(PAGE, { a: "1:2", b: "3" })
  await assertRefused(
    codec.decode(cursor, { a: "1", b: "2:3" }),
    KeysetCursorErrorCode.BadSignature,
  )
})

Deno.test("keyset cursor — a cursor of another purpose is refused under the same secret", async () => {
  const groups = await createKeysetCursorCodec({
    secret: SECRET,
    purpose: "groups.list",
    scope: ["userId", "groupId"],
  })
  const cursor = await groups.encode(PAGE, SCOPE)
  await assertRefused(
    (await notesCodec()).decode(cursor, SCOPE),
    KeysetCursorErrorCode.BadSignature,
  )
})

Deno.test("keyset cursor — a cursor signed with another secret is refused", async () => {
  const cursor = await (await notesCodec({ secret: OTHER_SECRET })).encode(PAGE, SCOPE)
  await assertRefused(
    (await notesCodec()).decode(cursor, SCOPE),
    KeysetCursorErrorCode.BadSignature,
  )
})

Deno.test("keyset cursor — a signed page key with an unknown extra key is refused", async () => {
  const cursor = await signOutsideEncoder({
    updatedAt: PAGE.updatedAt.toISOString(),
    id: PAGE.id,
    admin: true,
  })
  await assertRefused(
    (await notesCodec()).decode(cursor, SCOPE),
    KeysetCursorErrorCode.InvalidPageKey,
  )
})

Deno.test("keyset cursor — a signed page key with a bad value is refused", async () => {
  const codec = await notesCodec()
  const accepted = await signOutsideEncoder({
    updatedAt: PAGE.updatedAt.toISOString(),
    id: PAGE.id,
  })
  assertEquals(await codec.decode(accepted, SCOPE), PAGE)
  for (
    const payload of [
      { updatedAt: "2026-09-25T10:11:12Z", id: PAGE.id },
      { updatedAt: "not a date", id: PAGE.id },
      { updatedAt: PAGE.updatedAt.toISOString(), id: PAGE.id.toUpperCase() },
      { updatedAt: PAGE.updatedAt.toISOString(), id: "1" },
      { updatedAt: PAGE.updatedAt.toISOString() },
    ]
  ) {
    await assertRefused(
      codec.decode(await signOutsideEncoder(payload), SCOPE),
      KeysetCursorErrorCode.InvalidPageKey,
    )
  }
})

Deno.test("keyset cursor — malformed input is refused as malformed", async () => {
  const codec = await notesCodec()
  const cursor = await codec.encode(PAGE, SCOPE)
  for (
    const input of ["", "abc", `${cursor}.x`, cursor.replace(".", "+"), "a".repeat(5000)]
  ) {
    await assertRefused(codec.decode(input, SCOPE), KeysetCursorErrorCode.Malformed)
  }
})

Deno.test("keyset cursor — encoding a page key that would never decode throws", async () => {
  const codec = await notesCodec()
  await assertRefused(
    codec.encode({ updatedAt: new Date(Number.NaN), id: PAGE.id }, SCOPE),
    KeysetCursorErrorCode.InvalidPageKey,
  )
  await assertRefused(
    codec.encode({ updatedAt: PAGE.updatedAt, id: "not-a-uuid" }, SCOPE),
    KeysetCursorErrorCode.InvalidPageKey,
  )
})

Deno.test("keyset cursor — a missing or non-finite scope value is a TypeError", async () => {
  const codec = await notesCodec()
  const cursor = await codec.encode(PAGE, SCOPE)
  const missing = { userId: 7 } as unknown as typeof SCOPE
  await assertRejects(() => codec.encode(PAGE, missing), TypeError)
  await assertRejects(() => codec.decode(cursor, missing), TypeError)
  await assertRejects(() => codec.decode(cursor, { userId: Number.NaN, groupId: GROUP }), TypeError)
})

Deno.test("keyset cursor — the factory refuses repeated or empty scope field names", async () => {
  await assertRejects(
    () => createKeysetCursorCodec({ secret: SECRET, purpose: "x", scope: ["a", "a"] }),
    TypeError,
  )
  await assertRejects(
    () => createKeysetCursorCodec({ secret: SECRET, purpose: "x", scope: [""] }),
    TypeError,
  )
})

Deno.test("keyset cursor — the factory refuses a short secret", async () => {
  const error = await assertRejects(() => notesCodec({ secret: "short" }), TokenError)
  assertEquals(error.code, TokenErrorCode.InvalidSecret)
})

Deno.test("deriveCursorSecret — each purpose gets its own key, none equal to the master", async () => {
  const notes = await deriveCursorSecret(SECRET, "notes.list")
  const groups = await deriveCursorSecret(SECRET, "groups.list")
  assertNotEquals(notes, groups)
  assertNotEquals(notes, SECRET)
  assertNotEquals(notes, await deriveCursorSecret(OTHER_SECRET, "notes.list"))
  assertEquals(notes, await deriveSecret(SECRET, "spy4x.keyset-cursor.v1:notes.list"))
})

Deno.test("deriveCursorSecret — refuses a short secret and an empty purpose", async () => {
  await assertRejects(() => deriveCursorSecret("short", "notes.list"), TokenError)
  await assertRejects(() => deriveCursorSecret(SECRET, ""), TypeError)
})
