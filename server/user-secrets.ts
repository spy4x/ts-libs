/**
 * BYOK (bring-your-own-key) secret store: validate → encrypt at rest → keep a masked hint →
 * upsert per `(user, provider)` → delete.
 *
 * Persistence is an injected {@link UserSecretPort}, so this module holds no driver, no connection
 * and no query text. What it guarantees:
 *
 * - Every failure is a {@link UserSecretError} with a **constant** message and a code. No caller
 *   value is echoed, and a rejection from the port or the cipher crosses only as the identity of a
 *   known error type — never its `message`, `stack`, `cause` or `name` — so a port or a cipher that
 *   quotes its input cannot leak a plaintext or a ciphertext through this module's error object.
 * - Failures are classified by **type and position, never by message text**: a cipher rejection
 *   while encrypting is {@link UserSecretErrorCode.EncryptionFailed}, while decrypting
 *   {@link UserSecretErrorCode.DecryptionFailed}, and a port rejection
 *   {@link UserSecretErrorCode.PortFailure}.
 * - Provider names are slugs ({@link PROVIDER_PATTERN}) normalised to lower case, so `OpenAI` and
 *   `openai` are one row.
 * - A non-empty base URL goes through `validatePublicUrl` from `@spy4x/net/url-policy`, so a user
 *   cannot point the outbound call at the cloud metadata service or anything else inside the
 *   network, unless the installation opts in
 *   ({@link UserSecretStoreOptions.allowInternalBaseUrl}).
 * - Every row the port returns is checked against the user and provider that were asked for, and a
 *   row that does not match is refused as {@link UserSecretErrorCode.RowMismatch} rather than
 *   decrypted.
 * - Each secret is sealed against {@link secretContext} — this module's name, a version, and the
 *   row's user and provider — which the cipher authenticates as additional data, so a value copied
 *   to another row does not open. A ciphertext written without that context does not open either;
 *   re-encrypt it from the plaintext.
 *
 * The mask and the cipher have exactly one implementation in this package (`./crypto.ts`); this
 * module never re-implements AES or masking.
 *
 * @module
 */

import { type } from "arktype"
import { defaultResolver, validatePublicUrl } from "@spy4x/net/url-policy"
import type { DnsResolver } from "@spy4x/net/url-policy"
import { hasHeaderControlCharacters } from "@spy4x/platform/validation/predicates"

import { CryptoError, DEFAULT_MASK_VISIBLE, maskKey } from "./crypto.ts"
import type { SecretCipher } from "./crypto.ts"

/**
 * Failure codes, stable integers so a caller can switch without string matching.
 *
 * `1`-`4` and `9` are input rejections, `5` a missing (or inactive) row, `6` a stored secret the
 * cipher could not open, `7` a rejection from the injected port, `8` a row that belongs to somebody
 * else, `10` a cipher rejection while encrypting. `6`, `7` and `10` report the identity of a known
 * rejection type and nothing else the rejection carried — no message, no stack, no cause, no
 * implementation-supplied name.
 */
export enum UserSecretErrorCode {
  InvalidUserId = 1,
  InvalidProvider = 2,
  InvalidApiKey = 3,
  InvalidBaseUrl = 4,
  NotFound = 5,
  DecryptionFailed = 6,
  PortFailure = 7,
  /**
   * A row came back for a different user or a different provider than the one
   * asked for. The port broke its contract, and the row is dropped rather than
   * decrypted — one user's key must never be opened on another user's request.
   */
  RowMismatch = 8,
  /** `model` is not a string of at most {@link MAX_MODEL_LENGTH} characters without control characters. */
  InvalidModel = 9,
  /** The cipher rejected the api key while encrypting it; nothing was stored. */
  EncryptionFailed = 10,
}

/**
 * The only error this module throws — a code, a constant message and a rejection type identity.
 *
 * The message is deliberately not parameterised: a caller value in a message is how a provider
 * name or a raw driver message ends up rendered to a user next to secret material. The error therefore carries **no `cause`** either: `cause` is a live handle on
 * a rejection that a driver or cipher may have populated with the value it failed on, and the
 * reviewer recovered a plaintext api key from exactly that handle. The house rule is that only the
 * error's *type* crosses a boundary, never `message`, `stack`, `cause` or any field of the error.
 * (It used to be stated by `server/http/redact.ts`, which was deleted with `server/jwt.ts` in
 * #60/PR #79; the rule outlived the file.)
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

/** Shortest accepted api key. */
export const MIN_API_KEY_LENGTH = 8

/**
 * Longest accepted api key: an unbounded string is an unbounded cipher row and an unbounded request
 * body.
 */
export const MAX_API_KEY_LENGTH = 4096

/** Longest accepted provider name — long enough for `azure-openai-eu-west`, short enough to key on. */
export const MAX_PROVIDER_LENGTH = 64

/** Longest accepted model name. Real names are short (`gpt-4o-mini`); the cap bounds the row. */
export const MAX_MODEL_LENGTH = 256

/**
 * Shape of a provider name an adapter can actually match.
 *
 * A provider is a slug —
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
 * The injected persistence port. `upsert` MUST behave like an SQL
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
  /**
   * How many trailing characters the hint may keep. Defaults to 4, and `maskKey` caps it again —
   * both by an absolute maximum and by a share of the key's length — so a caller cannot widen a
   * hint into a usable key.
   */
  maskVisible?: number
  /**
   * Resolves host names while a `baseUrl` is validated. Defaults to the system resolver, which
   * needs `--allow-net`; a unit test (and anything else without network permission) injects its
   * own. Unused when {@link UserSecretStoreOptions.allowInternalBaseUrl} is true, because nothing
   * is resolved then.
   */
  resolver?: DnsResolver
  /**
   * Allow a `baseUrl` that points inside the network — `localhost`, a private address, a `.local`
   * name. Defaults to refusing them, and only the literal `true` turns it on, so a config value
   * that arrives as `undefined` cannot flip it.
   *
   * It exists because a self-hosted model server on `http://localhost:11434/v1` is a real thing a
   * user configures. Turning it on gives up the SSRF guard for this field: the store's own rules
   * still apply (absolute `http:`/`https:`, no user name or password, no control characters), but a
   * caller can then reach anything the server itself can reach, including a cloud metadata service.
   * Turn it on only where the user who saves the URL is already trusted with that reach.
   */
  allowInternalBaseUrl?: boolean
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
const INVALID_MODEL_MESSAGE = "model is invalid"
const ENCRYPTION_FAILED_MESSAGE = "the secret could not be encrypted"
const ROW_MISMATCH_MESSAGE = "the port returned a row for a different user or provider"

// ── Shape and rule checks ────────────────────────────────────────────────────────────────────

const saveInputShape = type({
  provider: "string",
  apiKey: "string",
  "baseUrl?": "string",
  "model?": "string",
})

/**
 * Maps an arktype shape failure to a typed error **by field path only**.
 *
 * Reason this exists instead of rethrowing the arktype error: arktype messages echo the offending
 * value (`must be at least length 8 (was "abc")`), and for `apiKey` that value is the secret
 * itself. A path is metadata; a message is not. The field order of `problems` is arktype's, so
 * the first problem decides; a problem with no field (a payload that is not an object at all) is
 * reported as `InvalidProvider`, since a payload that cannot be read as an object cannot name a
 * provider.
 */
function shapeFailure(errors: type.errors): UserSecretError {
  for (const problem of errors) {
    switch (problem.path[0]) {
      case "provider":
        return new UserSecretError(UserSecretErrorCode.InvalidProvider, INVALID_PROVIDER_MESSAGE)
      case "apiKey":
        return new UserSecretError(UserSecretErrorCode.InvalidApiKey, INVALID_API_KEY_MESSAGE)
      case "baseUrl":
        return new UserSecretError(UserSecretErrorCode.InvalidBaseUrl, INVALID_BASE_URL_MESSAGE)
      case "model":
        return new UserSecretError(UserSecretErrorCode.InvalidModel, INVALID_MODEL_MESSAGE)
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
 * Length and character rules for the secret itself. A key carrying `\u0000` or a raw newline
 * breaks the outbound `Authorization` header, and in a log or an error it is how a secret escapes
 * a one-line record.
 */
function assertApiKey(apiKey: string): void {
  if (
    typeof apiKey !== "string" ||
    apiKey.length < MIN_API_KEY_LENGTH ||
    apiKey.length > MAX_API_KEY_LENGTH ||
    hasHeaderControlCharacters(apiKey)
  ) {
    throw new UserSecretError(UserSecretErrorCode.InvalidApiKey, INVALID_API_KEY_MESSAGE)
  }
}

/**
 * An empty or omitted model is valid (the adapter uses its own default). A model name ends up in
 * an outbound request — a JSON body, and for some providers a URL path — so it gets a length cap
 * and the same control-character rule as the key.
 */
function assertModel(model: string): void {
  if (model.length > MAX_MODEL_LENGTH || hasHeaderControlCharacters(model)) {
    throw new UserSecretError(UserSecretErrorCode.InvalidModel, INVALID_MODEL_MESSAGE)
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
 * An empty or omitted `baseUrl` is valid (the adapter falls back to its own default). A non-empty one has to survive three checks, in this order:
 *
 * 1. **This module's own shape rules.** An absolute `http:`/`https:` URL, with no user name or
 *    password in it and no control characters. These run first and always, including when internal
 *    addresses are allowed. Absoluteness is checked here rather than left to the guard, because
 *    `validatePublicUrl` completes a missing scheme with `https://` and would quietly accept
 *    `api.example.com/v1`, which is not what a caller who typed a bare host meant to store.
 * 2. **The SSRF guard**, `validatePublicUrl` from `@spy4x/net/url-policy`, unless internal
 *    addresses were explicitly allowed. It resolves the host name and refuses loopback, link-local
 *    (including the cloud metadata address `169.254.169.254`), private and other special-use
 *    destinations.
 * 3. Nothing else: the value is stored exactly as the caller wrote it. The guard's canonical form
 *    is deliberately not stored, because a stored value that differs from the one that was sent is
 *    a surprise a caller cannot see in its own request.
 *
 * The guard's own message never travels: it names the resolver's failure and the address family it
 * disliked, which is information about this installation's network. Every rejection here is the one
 * constant {@link INVALID_BASE_URL_MESSAGE}, whichever check refused.
 *
 * Validating at save time does **not** make the outbound call safe. A host name that resolves to a
 * public address today can resolve to `127.0.0.1` tomorrow, and the guard cannot see that. The
 * request that uses this base URL has to go through `safeFetch` from `@spy4x/net/safe-fetch`,
 * which re-checks at connect time and follows redirects under the same policy.
 */
async function assertBaseUrl(
  baseUrl: string,
  options: { allowInternal: boolean; resolver: DnsResolver },
): Promise<void> {
  if (baseUrl === "") return

  const parsed = tryParseUrl(baseUrl)
  if (
    parsed === null ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" || parsed.password !== "" ||
    hasHeaderControlCharacters(baseUrl)
  ) {
    throw new UserSecretError(UserSecretErrorCode.InvalidBaseUrl, INVALID_BASE_URL_MESSAGE)
  }

  if (options.allowInternal) return

  try {
    await validatePublicUrl(baseUrl, { resolver: options.resolver })
  } catch {
    // Type-blind on purpose: every reason the guard refuses is the same answer here, and its
    // message and code stay inside this block.
    throw new UserSecretError(UserSecretErrorCode.InvalidBaseUrl, INVALID_BASE_URL_MESSAGE)
  }
}

/**
 * The context a stored secret is bound to: this module's name, a version, and the row's identity.
 *
 * Unambiguous by construction — each part is preceded by its length in code units, so no user id
 * and provider pair can encode to the same string as another (`("a:b", "c")` and `("a", "b:c")`
 * differ here, and would not if the parts were simply joined). The cipher authenticates this string
 * without storing it, so a ciphertext lifted into another user's row no longer opens.
 *
 * The version prefix is what makes a later change to this encoding a readable migration rather than
 * a silent failure to decrypt.
 */
function secretContext(userId: string, provider: string): string {
  return `user-secret:v1:${userId.length}:${userId}:${provider.length}:${provider}`
}

/**
 * Refuse a row that is not the one that was asked for.
 *
 * The port is injected, so this module cannot assume its `WHERE` clause is right: a driver with a
 * mis-written query, a cache keyed on the provider alone, or a test double that ignores its
 * arguments all hand back somebody else's row, and the next line would decrypt it and return the
 * plaintext to the caller who asked. The store checks the identity of every row it receives instead
 * of trusting that check to happen elsewhere.
 */
function assertRowMatches(row: StoredUserSecret, userId: string, provider: string): void {
  if (row.userId !== userId || row.provider !== provider) {
    throw new UserSecretError(UserSecretErrorCode.RowMismatch, ROW_MISMATCH_MESSAGE)
  }
}

/**
 * Runs one port call and translates any rejection into `code` (`PortFailure` unless the caller
 * names another).
 *
 * The rejection itself is dropped: only the identity of a known error type is kept (see
 * `rejectionNameOf`). A `cause` would hand the caller a live object whose `message` may quote the
 * row, the ciphertext or the plaintext the injected implementation was working on. Used narrowly —
 * wrapping a whole operation would swallow the codes of this module's own typed errors.
 */
async function callPort<T>(
  operation: () => Promise<T>,
  code = UserSecretErrorCode.PortFailure,
  message = PORT_FAILURE_MESSAGE,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new UserSecretError(code, message, rejectionNameOf(error))
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
 * The house rule, once written down in the since-deleted `server/http/redact.ts`: identify a
 * failure by type, never by `message`, `stack`, `cause` or any field of the error. Nothing else
 * from the rejection is copied.
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
 * whatever the port adds tomorrow. The summary is the boundary that keeps ciphertext out of a
 * response, structurally.
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
 * Behaviour:
 *
 * - `save`: encrypt the key, store `keyHint =
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
 * - `list`: metadata and the hint only, never the ciphertext, in the port's order (sorting is the
 *   port's job).
 * - `remove`: idempotent, so no row count is checked and
 *   deleting what was never stored is not an error.
 * - every row the port hands back is checked against the user and provider that were asked for
 *   (`save`'s re-read, `list`, `openSecret`), and every secret is sealed against
 *   {@link secretContext}, so neither a wrong row nor a copied ciphertext can become a plaintext.
 * - `openSecret`: opens the active row for an outbound
 *   call, reports a missing or unknown provider as `NotFound` (never a hint in its place), and
 *   reports any cipher rejection as `DecryptionFailed` — classified by type, never by message, and
 *   described by the identity of a known rejection type rather than the rejection.
 */
export function createUserSecretStore(options: UserSecretStoreOptions): UserSecretStore {
  const { port, cipher } = options
  const now = options.now ?? (() => new Date())
  const maskVisible = options.maskVisible ?? DEFAULT_MASK_VISIBLE
  const resolver = options.resolver ?? defaultResolver
  // `=== true`, never truthiness: a config value that arrives as `undefined`, `""` or `0` means
  // "not configured", and the safe reading of "not configured" is the refusing default.
  const allowInternal = options.allowInternalBaseUrl === true

  return {
    async save(userId, input) {
      assertUserId(userId)
      const shape = saveInputShape(input)
      if (shape instanceof type.errors) throw shapeFailure(shape)
      assertProvider(shape.provider)
      assertApiKey(shape.apiKey)
      const baseUrl = shape.baseUrl ?? ""
      await assertBaseUrl(baseUrl, { allowInternal, resolver })
      const model = shape.model ?? ""
      assertModel(model)

      const provider = providerKey(shape.provider)
      const secretEncrypted = await callPort(
        () => cipher.encrypt(shape.apiKey, secretContext(userId, provider)),
        UserSecretErrorCode.EncryptionFailed,
        ENCRYPTION_FAILED_MESSAGE,
      )
      const timestamp = now().toISOString()
      const record: StoredUserSecret = {
        userId,
        provider,
        secretEncrypted,
        keyHint: maskKey(shape.apiKey, maskVisible),
        baseUrl,
        model,
        isActive: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      await callPort(() => port.upsert(record))
      const stored = await callPort(() => port.findActive(userId, record.provider))
      if (stored !== null) assertRowMatches(stored, userId, record.provider)
      return toSummary(stored ?? record)
    },

    async list(userId) {
      assertUserId(userId)
      const rows = await callPort(() => port.listByUser(userId))
      // One foreign row makes the whole answer untrustworthy, so the call fails rather than
      // quietly returning the rows that did match.
      for (const row of rows) {
        if (row.userId !== userId) {
          throw new UserSecretError(UserSecretErrorCode.RowMismatch, ROW_MISMATCH_MESSAGE)
        }
      }
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
      assertRowMatches(row, userId, key)
      try {
        return await cipher.decrypt(row.secretEncrypted, secretContext(userId, key))
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
