/**
 * Keyset pagination cursor: an opaque, signed page key bound to the scope it was issued for.
 *
 * Ported from spy4x/template's `libs/server/groups/group-list-cursor.ts` and
 * `libs/server/notes/note-list-cursor.ts`, which were near-copies (#314). A cursor is a
 * {@link createSignedPayloadCodec} token under the cursor's purpose, so this module only adds what a
 * list endpoint needs on top of it: a default `{ updatedAt, id }` page key, scope fields bound as the
 * signed context, a signing key derived from one master secret per purpose, and a single error type.
 *
 * The scope (the signed-in user, a group) is covered by the signature but not carried in the token,
 * so a cursor copied to another account or another group fails its check and never reveals the ids
 * it was bound to.
 *
 * @example Note list cursor bound to the user and the group
 * ```ts
 * const notes = await createKeysetCursorCodec({
 *   secret: cookieSecret,
 *   purpose: "notes.list",
 *   scope: ["userId", "groupId"],
 * })
 * const cursor = await notes.encode(lastRow, { userId: 7, groupId })
 * try {
 *   const after = await notes.decode(cursor, { userId: 7, groupId })
 * } catch (error) {
 *   if (error instanceof KeysetCursorError) throw new NoteError("INVALID_CURSOR")
 *   throw error
 * }
 * ```
 *
 * @module
 */

import { type Out, type Type, type } from "arktype"
import {
  createSignedPayloadCodec,
  SignedPayloadError,
  SignedPayloadErrorCode,
} from "./signed-payload.ts"
import { deriveSecret } from "./tokens.ts"

/**
 * Why a cursor was refused. Callers map the code to their own error and never branch on a message;
 * no refusal carries text from the cursor.
 */
export enum KeysetCursorErrorCode {
  /** Not a cursor this codec could have minted: wrong shape, wrong length, not base64url. */
  Malformed = 1,
  /** Altered, signed with another secret, issued for another purpose (each purpose has its own key),
   * or presented under another scope than it was issued for. */
  BadSignature = 2,
  /** Signed, but its page key does not satisfy the page-key schema (an unknown key, a bad value). On
   * `encode`, a page key that would never decode. */
  InvalidPageKey = 3,
}

/** The one error every refusal raises. Its message is a constant; read {@link code}. */
export class KeysetCursorError extends Error {
  readonly code: KeysetCursorErrorCode

  constructor(code: KeysetCursorErrorCode, options?: { cause?: unknown }) {
    super("keyset cursor is invalid", options)
    this.name = "KeysetCursorError"
    this.code = code
  }
}

/** Domain label of every cursor key: the purpose follows it, so each purpose gets its own key. */
const KEY_LABEL_PREFIX = "spy4x.keyset-cursor.v1:"

/** Payload version handed to the signed-payload codec. Raising it voids every issued cursor. */
const PAYLOAD_VERSION = 1

/** A lower-case UUID of any version, the form Postgres and `crypto.randomUUID` print. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * An instant exactly as `Date.prototype.toISOString` prints it, so a decoded cursor names the same
 * millisecond the encoder saw. `2026-01-01T00:00:00Z` (no milliseconds) and any offset other than
 * `Z` are refused.
 */
const isoInstant: Type<string> = type("string").narrow((value, ctx) => {
  const date = new Date(value)
  return (!Number.isNaN(date.valueOf()) && date.toISOString() === value) ||
    ctx.mustBe("an ISO instant as toISOString prints it")
})

/**
 * The default page key, `{ updatedAt, id }`: the last row of a page ordered by `updated_at` then
 * `id`. Its input is the JSON form (`updatedAt` an ISO string), its output holds a `Date`, and no
 * other key is accepted.
 *
 * A `Date` holds milliseconds, and a cursor refuses anything finer. A Postgres `TIMESTAMPTZ` column
 * holds microseconds, so two rows inside one millisecond would be skipped (descending order) or
 * repeated (ascending order). Declare the column `TIMESTAMPTZ(3)`, or compare the cursor against
 * `date_trunc('milliseconds', updated_at)` and order by that expression.
 */
export const updatedAtIdPageKey: Type<{ updatedAt: (In: string) => Out<Date>; id: string }> = type({
  updatedAt: isoInstant.pipe((value) => new Date(value)),
  id: type(UUID_PATTERN),
  "+": "reject",
})

/** The decoded default page key: `{ updatedAt: Date, id: string }`. */
export type UpdatedAtIdPageKey = typeof updatedAtIdPageKey.infer

/** A scope value: a string, or a finite number. `1` and `"1"` are different scopes. */
export type ScopeValue = string | number

/** Settings fixed for the codec's lifetime. */
export interface KeysetCursorCodecOptions<F extends string, S extends Type<object>> {
  /**
   * The master secret, such as the session-cookie secret: at least `MIN_SECRET_LENGTH` printable
   * characters. Cursors are signed with {@link deriveCursorSecret} of it, never with it directly.
   */
  secret: string
  /** What the cursor pages through, such as `"notes.list"`. A cursor decodes only under it. */
  purpose: string
  /**
   * Names of the fields that bind a cursor to its scope, such as `["userId", "groupId"]`, in a fixed
   * order. Empty for a list that is the same for everyone.
   */
  scope: readonly F[]
  /**
   * Page-key schema. Its input is the page key's JSON form, its output what `encode` takes and
   * `decode` returns; `JSON.stringify` of an output must satisfy the input. Defaults to
   * {@link updatedAtIdPageKey}. Add `"+": "reject"` to refuse unknown keys.
   */
  pageKey?: S
}

/** Encodes and decodes one list's cursors. Made by {@link createKeysetCursorCodec}. */
export interface KeysetCursorCodec<F extends string, S extends Type<object>> {
  /**
   * Signs `pageKey` into a cursor bound to `scope`.
   *
   * @throws {KeysetCursorError} `InvalidPageKey` when the page key would not decode (an invalid
   *     date, a non-UUID id); `Malformed` when the cursor would exceed the signed-payload length cap.
   * @throws {TypeError} When a scope field is missing or is not a string or a finite number.
   */
  encode(pageKey: S["infer"], scope: Readonly<Record<F, ScopeValue>>): Promise<string>
  /**
   * Verifies `cursor` under `scope` and returns the page key.
   *
   * @throws {KeysetCursorError} For every cursor it refuses; see {@link KeysetCursorErrorCode}.
   * @throws {TypeError} When a scope field is missing or is not a string or a finite number. That is
   *     the caller's bug, not a bad cursor.
   */
  decode(cursor: string, scope: Readonly<Record<F, ScopeValue>>): Promise<S["infer"]>
}

/**
 * The cursor signing key for `purpose`: {@link deriveSecret} of the master secret under the label
 * `spy4x.keyset-cursor.v1:<purpose>`, 64 hex characters.
 *
 * The master is typically the session-cookie secret. Hono's signed cookie is an HMAC of the bare
 * cookie value under that raw secret, so signing cursors with it directly would mix two MAC schemes
 * under one key; the derived key keeps them apart without a second environment variable. Each
 * purpose derives its own key, so a cursor of one list does not even verify against another.
 *
 * @throws {TokenError} `InvalidSecret` when the secret is missing, not printable or shorter than
 *     `MIN_SECRET_LENGTH`.
 * @throws {TypeError} When `purpose` is not a non-empty string.
 */
export async function deriveCursorSecret(secret: string, purpose: string): Promise<string> {
  if (typeof purpose !== "string" || purpose === "") {
    throw new TypeError("purpose must be a non-empty string")
  }
  return await deriveSecret(secret, `${KEY_LABEL_PREFIX}${purpose}`)
}

/**
 * Creates a cursor codec for one list. Async because the signing key is derived with WebCrypto.
 *
 * @throws {TokenError} `InvalidSecret` when the secret is missing, not printable or shorter than
 *     `MIN_SECRET_LENGTH`.
 * @throws {TypeError} When `purpose` is empty, or a scope field name is empty or repeated.
 */
export async function createKeysetCursorCodec<
  F extends string,
  S extends Type<object> = typeof updatedAtIdPageKey,
>(options: KeysetCursorCodecOptions<F, S>): Promise<KeysetCursorCodec<F, S>> {
  const { purpose } = options
  const fields = [...options.scope]
  if (fields.some((field) => typeof field !== "string" || field === "")) {
    throw new TypeError("scope field names must be non-empty strings")
  }
  if (new Set(fields).size !== fields.length) {
    throw new TypeError("scope field names must be unique")
  }
  const codec = createSignedPayloadCodec({
    secret: await deriveCursorSecret(options.secret, purpose),
    purpose,
    version: PAYLOAD_VERSION,
    schema: (options.pageKey ?? updatedAtIdPageKey) as S,
  })

  /**
   * The signed context: the scope values as a JSON array in declared order. JSON quotes strings and
   * escapes every separator and lone surrogate, so no two scopes share a context.
   */
  const context = (scope: Readonly<Record<F, ScopeValue>>): string =>
    JSON.stringify(fields.map((field) => {
      const value: unknown = scope?.[field]
      if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
        return value
      }
      throw new TypeError(`scope field ${JSON.stringify(field)} must be a string or finite number`)
    }))

  return {
    async encode(pageKey, scope) {
      const bound = context(scope)
      try {
        return await codec.sign(pageKey as S["inferIn"], { context: bound })
      } catch (error) {
        if (error instanceof SignedPayloadError) {
          throw new KeysetCursorError(toCursorCode(error.code), { cause: error })
        }
        throw error
      }
    },

    async decode(cursor, scope) {
      const result = await codec.verify(cursor, { context: context(scope) })
      if (!result.ok) throw new KeysetCursorError(toCursorCode(result.error))
      return result.value
    },
  }
}

/**
 * Maps a signed-payload refusal onto a cursor refusal. Neither `WrongPurpose` nor `Expired` can
 * occur for a token minted here: each purpose signs with its own key, so another purpose's cursor
 * already fails its signature, and cursors carry no lifetime. They map to the nearest code.
 */
function toCursorCode(code: SignedPayloadErrorCode): KeysetCursorErrorCode {
  switch (code) {
    case SignedPayloadErrorCode.BadSignature:
    case SignedPayloadErrorCode.WrongPurpose:
      return KeysetCursorErrorCode.BadSignature
    case SignedPayloadErrorCode.InvalidPayload:
      return KeysetCursorErrorCode.InvalidPageKey
    case SignedPayloadErrorCode.Malformed:
    case SignedPayloadErrorCode.Expired:
      return KeysetCursorErrorCode.Malformed
  }
}
