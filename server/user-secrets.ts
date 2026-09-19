/**
 * BYOK (bring-your-own-key) secret store: validate → encrypt at rest → keep a masked hint →
 * upsert per `(user, provider)` → delete.
 *
 * Ported from `offer-lens/apps/api/routes/keys.ts` (the Hono routes stay out — no framework
 * here) and the persistence semantics of `offer-lens/libs/db/mod.ts`. The SQL stays out too:
 * persistence is an injected {@link UserSecretPort}, so this module holds no driver, no
 * connection and no query text.
 *
 * What was fixed at port time, and why:
 *
 * - `keys.ts:22-27` validated by hand in the route and `keys.ts:93` interpolated the caller's
 *   provider into a user-facing message. Here every failure is a {@link UserSecretError} with a
 *   **constant** message: no caller value is ever echoed.
 * - `keys.ts:133` returned `err.message` — in the encrypt/decrypt path that message can be a
 *   cipher error naming key material. Here a thrown {@link UserSecretError} carries a code, a
 *   constant message and the identity of a known rejection type — never the rejection itself, its
 *   `message`, its `stack`, its `cause` or any string it chose (including its `name`). A port or a
 *   cipher that echoes its input (a driver quoting the row it failed on, a cipher quoting the value
 *   it refused) therefore cannot leak a plaintext or a ciphertext through this module's error
 *   object.
 * - Provider names are normalised to lower case at this boundary, so `OpenAI` and `openai` cannot
 *   become two rows of one user (see {@link PROVIDER_PATTERN}).
 * - Failures are classified by **type and position, never by message text** (the
 *   `offer-lens/libs/scraper/mod.ts:132` anti-pattern): any cipher rejection becomes
 *   {@link UserSecretErrorCode.DecryptionFailed}, whatever the underlying error says.
 * - The source accepted any non-empty provider string, which stores rows no adapter can ever
 *   match; {@link PROVIDER_PATTERN} bounds that at the edge.
 *
 * The mask and the cipher have exactly one implementation in this package (`./crypto.ts`); this
 * module never re-implements AES or masking.
 */

import { type } from "arktype"

import { CryptoError, maskKey } from "./crypto.ts"
import type { SecretCipher } from "./crypto.ts"

/**
 * Failure codes, stable integers so a caller can switch without string matching.
 *
 * `1`-`4` are input rejections, `5` a missing (or inactive) row, `6` a stored secret the cipher
 * could not open, `7` a rejection from the injected port or cipher. `6`-`7` report the identity of
 * a known rejection type and nothing else the rejection carried — no message, no stack, no cause,
 * no implementation-supplied name.
 */
export enum UserSecretErrorCode {
  InvalidUserId = 1,
  InvalidProvider = 2,
  InvalidApiKey = 3,
  InvalidBaseUrl = 4,
  NotFound = 5,
  DecryptionFailed = 6,
  PortFailure = 7,
}

/**
 * The only error this module throws — a code, a constant message and a rejection type identity.
 *
 * The message is deliberately not parameterised: a caller value in a message is how a provider
 * name (`keys.ts:93`) or a raw driver message (`keys.ts:133`) ends up rendered to a user next to
 * secret material. The error therefore carries **no `cause`** either: `cause` is a live handle on
 * a rejection that a driver or cipher may have populated with the value it failed on, and the
 * reviewer recovered a plaintext api key from exactly that handle. `server/http/redact.ts:50-57`
 * is the house rule — only the error's *name* crosses a boundary, never `message`, `stack`,
 * `cause` or any field of the error.
 *
 * What a caller gets for an underlying failure is {@link UserSecretError.rejectionName}: one of a
 * closed set of known type identities, or a primitive `typeof` for a non-`Error` throw (see
 * {@link rejectionNameOf}). Enough to tell a `TypeError` from a `CryptoError` in a log or a metric
 * label; not enough to carry a payload, because no string the rejection supplied is ever read.
 */
export class UserSecretError extends Error {
  readonly code: UserSecretErrorCode

  /**
   * Identity of the known error type this error stands in for — one of `"CryptoError"`,
   * `"DOMException"`, `"TypeError"`, `"RangeError"`, `"SyntaxError"`, `"Error"`, or a primitive
   * `typeof` — or `undefined` when the failure was raised here (validation, `NotFound`). Never a
   * message, never a string the rejection supplied, never the rejection object.
   */
  readonly rejectionName: string | undefined

  constructor(code: UserSecretErrorCode, message: string, rejectionName?: string) {
    super(message)
    this.name = "UserSecretError"
    this.code = code
    this.rejectionName = rejectionName
  }
}

/** Shortest accepted api key, mirroring the `keys.ts:25` rule. */
export const MIN_API_KEY_LENGTH = 8

/**
 * Longest accepted api key. The source had no ceiling; an unbounded string is an unbounded
 * cipher row and an unbounded request body, so the port rejects it by type instead.
 */
export const MAX_API_KEY_LENGTH = 4096

/** Longest accepted provider name — long enough for `azure-openai-eu-west`, short enough to key on. */
export const MAX_PROVIDER_LENGTH = 64

/**
 * Shape of a provider name an adapter can actually match.
 *
 * Decision (the source accepted any non-empty string, `keys.ts:22-23`): a provider is a slug —
 * a leading alphanumeric followed by alphanumerics, dot, underscore or dash, case-insensitive.
 * Rejecting anything else at the edge keeps `(user, provider)` rows addressable, keeps a provider
 * out of any URL path or query unescaped, and makes an adapter lookup a pure switch instead of a
 * normalising hunt. Deliberately not anchored to a known list: a custom OpenAI-compatible
 * endpoint is a legitimate provider, so this validates shape, not membership.
 *
 * The pattern accepting both cases is a promise about the *row key*, not just about the check, so
 * the store normalises with {@link providerKey} on every path that touches the port: a caller can
 * `save("OpenAI", …)` and `openSecret(userId, "openai")`, and `OpenAI` cannot be a second row
 * beside `openai` (the same provider would otherwise hold two secrets, one of them unreadable).
 */
export const PROVIDER_PATTERN: RegExp = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * The provider as it is keyed: lower case, locale-independent (`toLowerCase`, never
 * `toLocaleLowerCase` — a Turkish locale would map `I` to a dotless `ı` and split a row).
 */
function providerKey(provider: string): string {
  return provider.toLowerCase()
}

/** A stored row, as the port sees it. `secretEncrypted` is the only place a secret may live. */
export interface StoredUserSecret {
  userId: string
  provider: string
  secretEncrypted: string
  keyHint: string
  baseUrl: string
  model: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/**
 * The injected persistence port. `upsert` MUST behave like the source's
 * `ON CONFLICT (user_id, provider) DO UPDATE`: replace secretEncrypted/keyHint/baseUrl/model, force
 * isActive true, set updatedAt from the incoming record, and **preserve the stored createdAt**.
 * No SQL, no driver and no connection lives in this module.
 */
export interface UserSecretPort {
  upsert(record: StoredUserSecret): Promise<void>
  listByUser(userId: string): Promise<StoredUserSecret[]>
  /** Only the active row for the pair, or null. */
  findActive(userId: string, provider: string): Promise<StoredUserSecret | null>
  remove(userId: string, provider: string): Promise<void>
}

export interface SaveUserSecretInput {
  provider: string
  apiKey: string
  baseUrl?: string
  model?: string
}

/** What a list/UI may see: metadata plus a hint. There is no field that can carry the secret. */
export interface UserSecretSummary {
  provider: string
  keyHint: string
  baseUrl: string
  model: string
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface UserSecretStoreOptions {
  port: UserSecretPort
  cipher: SecretCipher
  /** Injected clock for deterministic tests. Defaults to `() => new Date()`. */
  now?: () => Date
  /** How many trailing characters the hint keeps. Defaults to 4. */
  maskVisible?: number
}

export interface UserSecretStore {
  save(userId: string, input: SaveUserSecretInput): Promise<UserSecretSummary>
  list(userId: string): Promise<UserSecretSummary[]>
  /** The decrypted secret for an outbound provider call. Never logged, never returned in a summary. */
  openSecret(userId: string, provider: string): Promise<string>
  remove(userId: string, provider: string): Promise<void>
}

// ── Constant messages ────────────────────────────────────────────────────────────────────────
// Literals, not templates: a message is the one string that reaches a user, a log line and a
// stack trace, so nothing derived from a caller value may be interpolated into one.

const INVALID_USER_ID_MESSAGE = "userId is required"
const INVALID_PROVIDER_MESSAGE = "provider is invalid"
const INVALID_API_KEY_MESSAGE = "apiKey is invalid"
const INVALID_BASE_URL_MESSAGE = "baseUrl is invalid"
const NOT_FOUND_MESSAGE = "no active secret is stored for that provider"
const DECRYPTION_FAILED_MESSAGE = "the stored secret could not be decrypted"
const PORT_FAILURE_MESSAGE = "the user secret port failed"

// ── Shape and rule checks ────────────────────────────────────────────────────────────────────

const saveInputShape = type({
  provider: "string",
  apiKey: "string",
  "baseUrl?": "string",
  "model?": "string",
})

/**
 * True when the value carries a C0 control character (code point ≤ 31) or DEL (127).
 *
 * Scanned by code point rather than with a control-character regex: `deno lint`'s
 * `no-control-regex` rejects the pattern form outright (`deno lint` is part of CI), and the loop
 * states the rule the port fix (row 4) is about. NUL and friends survive JSON encoding, end up in
 * a DB text column, and are how a secret escapes a one-line log record.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

/**
 * Maps an arktype shape failure to a typed error **by field path only**.
 *
 * Reason this exists instead of rethrowing the arktype error: arktype messages echo the offending
 * value (`must be at least length 8 (was "abc")`), and for `apiKey` that value is the secret
 * itself. A path is metadata; a message is not. The field order of `problems` is arktype's, so
 * the first problem decides; a problem with no field (a payload that is not an object at all) is
 * reported as `InvalidProvider`, since a payload that cannot be read as an object cannot name a
 * provider. `model` has no code of its own and is reported as `InvalidBaseUrl`: both are endpoint
 * configuration read at call time, and inventing a code is worse than one documented mapping.
 */
function shapeFailure(errors: type.errors): UserSecretError {
  for (const problem of errors) {
    switch (problem.path[0]) {
      case "provider":
        return new UserSecretError(UserSecretErrorCode.InvalidProvider, INVALID_PROVIDER_MESSAGE)
      case "apiKey":
        return new UserSecretError(UserSecretErrorCode.InvalidApiKey, INVALID_API_KEY_MESSAGE)
      case "baseUrl":
      case "model":
        return new UserSecretError(UserSecretErrorCode.InvalidBaseUrl, INVALID_BASE_URL_MESSAGE)
      default:
        break
    }
  }
  return new UserSecretError(UserSecretErrorCode.InvalidProvider, INVALID_PROVIDER_MESSAGE)
}

/**
 * A user id is opaque here (the auth package owns its shape) but it must be a non-blank string:
 * a blank id would key every row to one bucket and turn a per-user lookup into a shared one.
 */
function assertUserId(userId: string): void {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new UserSecretError(UserSecretErrorCode.InvalidUserId, INVALID_USER_ID_MESSAGE)
  }
}

/** Provider must be an adapter-matchable slug, so a stored row can always be opened again. */
function assertProvider(provider: string): void {
  if (
    typeof provider !== "string" ||
    provider.length > MAX_PROVIDER_LENGTH ||
    !PROVIDER_PATTERN.test(provider)
  ) {
    throw new UserSecretError(UserSecretErrorCode.InvalidProvider, INVALID_PROVIDER_MESSAGE)
  }
}

/**
 * Length and character rules for the secret itself. The length band is the source's `keys.ts:25`
 * rule plus a ceiling; the control-character rule is new — a key carrying `\u0000` or a raw
 * newline breaks the outbound `Authorization` header, and in a log or an error it is how a
 * secret escapes a one-line record.
 */
function assertApiKey(apiKey: string): void {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < MIN_API_KEY_LENGTH ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    hasControlCharacter(apiKey)
  ) {
    throw new UserSecretError(UserSecretErrorCode.InvalidApiKey, INVALID_API_KEY_MESSAGE)
  }
}

/** Parses `baseUrl` and rejects anything that is not an absolute http(s) URL. `null` = unusable. */
function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * An empty or omitted `baseUrl` is valid (the adapter falls back to its own default, as `keys.ts:98`
 * does). A non-empty one must be an absolute http(s) URL: this value is concatenated into an
 * outbound endpoint, so `ftp:`, `file:` or a relative path is a request the caller did not mean.
 */
function assertBaseUrl(baseUrl: string): void {
  if (baseUrl === "") return
  const parsed = tryParseUrl(baseUrl)
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new UserSecretError(UserSecretErrorCode.InvalidBaseUrl, INVALID_BASE_URL_MESSAGE)
  }
}

/**
 * Runs one port (or cipher) call and translates any rejection into `PortFailure`.
 *
 * The rejection itself is dropped: only the identity of a known error type is kept (see
 * `rejectionNameOf`). A `cause` would hand the caller a live object whose `message` may quote the
 * row, the ciphertext or the plaintext the injected implementation was working on. Used narrowly —
 * wrapping a whole operation would swallow the codes of this module's own typed errors.
 */
async function callPort<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new UserSecretError(
      UserSecretErrorCode.PortFailure,
      PORT_FAILURE_MESSAGE,
      rejectionNameOf(error),
    )
  }
}

/**
 * The one thing that may cross from a rejection to a `UserSecretError`: the **identity** of a known
 * error type, resolved by `instanceof` against a closed whitelist.
 *
 * Never a string the injected implementation supplies. `error.name` is attacker-controlled text —
 * a driver can set it to the api key it failed on, and an earlier revision of this helper filtered
 * `name` to `[A-Za-z0-9_]`, which stopped punctuation but let an alphanumeric-only secret straight
 * through. Identity cannot carry a payload: the result is always one of `"CryptoError"`,
 * `"DOMException"`, `"TypeError"`, `"RangeError"`, `"SyntaxError"`, `"Error"`, or a primitive
 * `typeof` such as `"string"`.
 *
 * `server/http/redact.ts:50-57` is the house precedent — identify a failure by type, never by
 * `message`, `stack`, `cause` or any field of the error. Nothing else from the rejection is copied.
 */
function rejectionNameOf(error: unknown): string {
  if (error instanceof CryptoError) return "CryptoError"
  if (error instanceof DOMException) return "DOMException"
  if (error instanceof TypeError) return "TypeError"
  if (error instanceof RangeError) return "RangeError"
  if (error instanceof SyntaxError) return "SyntaxError"
  if (error instanceof Error) return "Error"
  return typeof error
}

/**
 * Projects a stored row onto what a list or a UI may see.
 *
 * Written as an explicit literal, never a spread with `secretEncrypted` deleted: a spread copies
 * whatever the port adds tomorrow, and `db/mod.ts:273-277` already proves the row type grows.
 * The summary is the boundary that keeps ciphertext out of a response — the source kept that
 * property by hand (`keys.ts:56-64`), this keeps it structurally.
 */
function toSummary(row: StoredUserSecret): UserSecretSummary {
  return {
    provider: row.provider,
    keyHint: row.keyHint,
    baseUrl: row.baseUrl,
    model: row.model,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/**
 * Builds a store over an injected port and cipher.
 *
 * Behaviour ported, with its source:
 *
 * - `save` — `keys.ts:29-46` + `db/mod.ts:240-261`: encrypt the key, store `keyHint =
 *   maskKey(key, 4)`, then upsert on `(user, provider)`. The conflict branch refreshes the secret,
 *   the hint, `baseUrl`, `model`, forces `isActive = true` and bumps `updatedAt`; `createdAt` is
 *   deliberately left alone. `save` re-reads the pair through `findActive` so the returned summary
 *   reports the **stored** `createdAt` after an update rather than the one it just minted —
 *   tradeoff: one extra port round trip per save (and a write-then-read assumption), bought in
 *   exchange for a summary that never lies about when the secret was first stored. A port that
 *   returns nothing on the re-read falls back to the record just written, so a lagging read cannot
 *   fail a save that succeeded.
 * - every provider that reaches the port is normalised with `providerKey`, in `save`, `openSecret`
 *   and `remove` alike, so the row key is one provider and not one per casing.
 * - `list` — `keys.ts:49-67` + `db/mod.ts:262-280`: metadata and the hint only, never the
 *   ciphertext, and the port's order is preserved (the source's `ORDER BY created_at DESC` is the
 *   port's job).
 * - `remove` — `keys.ts:69-82` + `db/mod.ts:296-304`: idempotent, so no row count is checked and
 *   deleting what was never stored is not an error.
 * - `openSecret` — `keys.ts:88-98` + `db/mod.ts:281-295`: opens the active row for an outbound
 *   call, reports a missing or unknown provider as `NotFound` (never a hint in its place), and
 *   reports any cipher rejection as `DecryptionFailed` — classified by type, never by message, and
 *   described by the identity of a known rejection type rather than the rejection.
 */
export function createUserSecretStore(options: UserSecretStoreOptions): UserSecretStore {
  const { port, cipher } = options
  const now = options.now ?? (() => new Date())
  const maskVisible = options.maskVisible ?? 4

  return {
    async save(userId, input) {
      assertUserId(userId)
      const shape = saveInputShape(input)
      if (shape instanceof type.errors) throw shapeFailure(shape)
      assertProvider(shape.provider)
      assertApiKey(shape.apiKey)
      const baseUrl = shape.baseUrl ?? ""
      assertBaseUrl(baseUrl)

      const secretEncrypted = await callPort(() => cipher.encrypt(shape.apiKey))
      const timestamp = now().toISOString()
      const record: StoredUserSecret = {
        userId,
        provider: providerKey(shape.provider),
        secretEncrypted,
        keyHint: maskKey(shape.apiKey, maskVisible),
        baseUrl,
        model: shape.model ?? "",
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      await callPort(() => port.upsert(record))
      const stored = await callPort(() => port.findActive(userId, record.provider))
      return toSummary(stored ?? record)
    },

    async list(userId) {
      assertUserId(userId)
      const rows = await callPort(() => port.listByUser(userId))
      return rows.map(toSummary)
    },

    async openSecret(userId, provider) {
      assertUserId(userId)
      assertProvider(provider)
      const key = providerKey(provider)
      const row = await callPort(() => port.findActive(userId, key))
      if (row === null || !row.isActive) {
        throw new UserSecretError(UserSecretErrorCode.NotFound, NOT_FOUND_MESSAGE)
      }
      try {
        return await cipher.decrypt(row.secretEncrypted)
      } catch (error) {
        // Type-only classification: the cipher is the only thing in this block, so its rejection
        // is a decryption failure no matter what its message claims. Only the identity of a known
        // error type travels — the rejection object itself, and every string it carries, stay here.
        throw new UserSecretError(
          UserSecretErrorCode.DecryptionFailed,
          DECRYPTION_FAILED_MESSAGE,
          rejectionNameOf(error),
        )
      }
    },

    async remove(userId, provider) {
      assertUserId(userId)
      assertProvider(provider)
      await callPort(() => port.remove(userId, providerKey(provider)))
    },
  }
}
