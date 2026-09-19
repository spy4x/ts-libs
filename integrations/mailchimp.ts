/**
 * Mailchimp Marketing API v3 list-member client.
 *
 * Zero dependencies, zero SDK. Every network call goes through an injectable
 * `fetcher` so the suite runs under `--allow-read --allow-env` with no
 * `--allow-net`. The subscriber hash is `crypto.subtle.digest("MD5")`, not a
 * hash library.
 *
 * Deviations from the `roley` source this was ported from, each pinned by a
 * test:
 *
 *  - The source logged `console.error` on the **success** path
 *    (`mailchimp.service.ts:74`) and returned `true` for a disabled no-op
 *    (`mailchimp.service.ts:33`), so a misconfigured deployment was
 *    indistinguishable from a working one. `putContact` now returns a
 *    discriminated result and writes nothing on success.
 *  - The disabled branch returned `dev` from `$app/environment`, reporting
 *    success in development and failure in production for the same no-op.
 *    "Disabled" is now its own result variant, reached explicitly.
 *  - The source reported a `Member Exists` 400 as success, conflating "already
 *    there" with "created". It is now reconciled into a real `PATCH`.
 *  - The source's email hash lowercased but did not trim, so `" a@b.c"` missed
 *    the member created by `"a@b.c"`. Both are trimmed.
 *  - The source logged every 4xx body, leaking member addresses into process
 *    output. Nothing is logged here; failures are returned.
 */

import {
  type BackoffFn,
  type Clock,
  createExponentialBackoff,
  isTransientStatus,
  parseRetryAfterMs,
  type RetryPolicy,
  runWithRetry,
  type Sleeper,
} from "./retry.ts"

/** Member statuses this client preserves or requests. */
export enum MailchimpStatus {
  Subscribed = "subscribed",
  Unsubscribed = "unsubscribed",
  Pending = "pending",
}

/** Which verb the upsert used: `PATCH` updates a member, `POST` creates one. */
export type MailchimpUpsertMethod = "PATCH" | "POST"

export interface MailchimpContact {
  email: string
  /** Previous address, checked first so a rename updates instead of duplicating. */
  emailBefore?: string
  firstName?: string
  lastName?: string
}

export interface MailchimpClientConfig {
  apiKey: string
  /**
   * The account name Mailchimp pairs with the key. The API ignores it, so any
   * non-empty string is accepted and `"anystring"` is the documented convention.
   */
  username: string
  listId: string
  /** Datacenter prefix of the API host, e.g. `us21`. */
  serverPrefix: string
}

/** Why the client refused to call the API at all. */
export type MailchimpDisabledReason = "missing_credentials" | "server_disabled"

export type MailchimpErrorCode =
  | "missing_email"
  | "method_not_allowed"
  | "network_error"
  | "http_error"
  | "invalid_response"

export interface MailchimpError {
  ok: false
  code: MailchimpErrorCode
  status?: number
  message: string
  attempts: number
}

export interface MailchimpUpserted {
  ok: true
  status: "upserted"
  method: MailchimpUpsertMethod
  httpStatus: number
  /** `created` for a fresh member, `updated` for an existing one. */
  change: "created" | "updated"
  attempts: number
}

export interface MailchimpSkippedDisabled {
  ok: true
  status: "skipped-disabled"
  reason: MailchimpDisabledReason
  attempts: 0
}

export type MailchimpResult = MailchimpUpserted | MailchimpSkippedDisabled | MailchimpError

/** Where a member already exists, it exists with exactly one of these statuses. */
export interface MailchimpMemberFound {
  ok: true
  exists: true
  status: MailchimpStatus
  statusIfNew?: MailchimpStatus
  attempts: number
}

export interface MailchimpMemberMissing {
  ok: true
  exists: false
  httpStatus: 404
  attempts: number
}

export type MailchimpMemberLookup = MailchimpMemberFound | MailchimpMemberMissing | MailchimpError

export interface MailchimpRetryOptions {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  totalBudgetMs?: number
  jitterRatio?: number
}

export interface MailchimpClientOptions {
  /** Optional read-only mode. Mutating calls then return `method_not_allowed`. */
  readOnly?: boolean
  fetcher?: typeof fetch
  sleep?: Sleeper
  clock?: Clock
  backoff?: BackoffFn
  retry?: MailchimpRetryOptions
  /** Receives every requested delay, in order. */
  onDelay?: (delayMs: number, attempt: number) => void
}

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  totalBudgetMs: 60_000,
  jitterRatio: 0.2,
}

const textEncoder = new TextEncoder()

/** Lowercased, trimmed address — the key Mailchimp hashes members under. */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase()

// ─── MD5 (RFC 1321) ───────────────────────────────────────────────────

/**
 * Per-round left-rotation amounts, indexed `[round][i % 4]`.
 *
 * Kept nested rather than flattened into a 64-entry table because the flattened
 * form is where two bugs hid during extraction: the per-round message-word
 * formulas were applied to the global step counter instead of a per-round one,
 * and the padding wrote the 32-bit bit length twice into the 8-byte tail.
 * Both are pinned by the RFC 1321 vectors in the colocated suite.
 */
const MD5_SHIFTS: readonly (readonly number[])[] = [
  [7, 12, 17, 22],
  [5, 9, 14, 20],
  [4, 11, 16, 23],
  [6, 10, 15, 21],
]

/** Message-word index for round `round`, position `index` within that round. */
const MD5_WORD_ORDER: readonly ((index: number) => number)[] = [
  (index) => index,
  (index) => (5 * index + 1) % 16,
  (index) => (3 * index + 5) % 16,
  (index) => (7 * index) % 16,
]

/** The four rounds' mixing functions. */
const MD5_MIX: readonly ((b: number, c: number, d: number) => number)[] = [
  (b, c, d) => (b & c) | (~b & d),
  (b, c, d) => (d & b) | (~d & c),
  (b, c, d) => b ^ c ^ d,
  (b, c, d) => c ^ (b | ~d),
]

/** Additive constants, `floor(2^32 * abs(sin(step + 1)))`, 64 entries. */
// deno-fmt-ignore
const MD5_CONSTANTS = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]

/**
 * MD5 as a lowercase hex string.
 *
 * Hand-written because Mailchimp's subscriber hash is defined as
 * `md5(lowercased email)` and Deno's WebCrypto has no MD5 —
 * `crypto.subtle.digest("MD5", ...)` throws `NotSupportedError: Algorithm 'MD5'
 * is not supported`, which the source this was ported from relied on through
 * Node's `crypto` module. The alternatives were a dependency (forbidden) or
 * `@std/crypto`'s `crypto.subtle` shim, which patches a runtime global on
 * import: too large a side effect for a library.
 *
 * MD5 being cryptographically broken does not matter here. It is not integrity
 * protection, it is a provider-mandated key derivation, and the RFC 1321
 * vectors in the colocated suite pin the implementation.
 */
export const md5Hex = (input: string): string => {
  const message = textEncoder.encode(input)
  // A multiple of 64 bytes with room for the 0x80 terminator and the 8-byte
  // little-endian bit length.
  const paddedLength = ((message.length + 8) >>> 6) * 64 + 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(message, 0)
  bytes[message.length] = 0x80
  // BigInt so a message above 512 MiB still encodes its true bit length.
  const bitLength = BigInt(message.length) * 8n
  for (let index = 0; index < 8; index++) {
    bytes[paddedLength - 8 + index] = Number((bitLength >> BigInt(8 * index)) & 0xffn)
  }

  let a = 0x67452301
  let b = 0xefcdab89
  let c = 0x98badcfe
  let d = 0x10325476
  const view = new DataView(bytes.buffer)

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true))
    let roundA = a
    let roundB = b
    let roundC = c
    let roundD = d

    for (let round = 0; round < 4; round++) {
      for (let index = 0; index < 16; index++) {
        const mix = MD5_MIX[round](roundB, roundC, roundD)
        const word = words[MD5_WORD_ORDER[round](index)]
        const sum = (mix + roundA + MD5_CONSTANTS[round * 16 + index] + word) >>> 0
        const shift = MD5_SHIFTS[round][index % 4]
        const rotated = ((sum << shift) | (sum >>> (32 - shift))) >>> 0
        const next = (roundB + rotated) >>> 0

        // Rotate: the new value lands in b, b moves to c, c to d, d to a.
        roundA = roundD
        roundD = roundC
        roundC = roundB
        roundB = next
      }
    }

    a = (a + roundA) >>> 0
    b = (b + roundB) >>> 0
    c = (c + roundC) >>> 0
    d = (d + roundD) >>> 0
  }

  let hex = ""
  for (const word of [a, b, c, d]) {
    for (let index = 0; index < 4; index++) {
      hex += ((word >>> (8 * index)) & 0xff).toString(16).padStart(2, "0")
    }
  }
  return hex
}

/** Mailchimp's subscriber hash: MD5 of the lowercased, trimmed address. */
export const emailHash = (email: string): string => md5Hex(normalizeEmail(email))

/**
 * RFC 7617 basic credentials.
 *
 * `btoa` is Latin-1-only, so the UTF-8 bytes are re-read as binary first; an
 * API key with any byte above 0x7f would otherwise throw an `InvalidCharacterError`
 * from `btoa` instead of authenticating.
 */
export const basicAuthHeader = (username: string, apiKey: string): string => {
  let binary = ""
  for (const byte of textEncoder.encode(`${username}:${apiKey}`)) {
    binary += String.fromCharCode(byte)
  }
  return `Basic ${btoa(binary)}`
}

/**
 * Reads Mailchimp credentials from an environment reader.
 *
 * Returns `null` when any part is missing, so "not configured" is the caller's
 * explicit decision. Nothing is read at module scope and nothing is logged;
 * the caller owns how secrets reach the process.
 */
export const mailchimpConfigFromEnv = (
  read: (name: string) => string | undefined = (name) => Deno.env.get(name),
): MailchimpClientConfig | null => {
  const apiKey = read("MAILCHIMP_API_KEY")?.trim()
  const username = read("MAILCHIMP_API_USERNAME")?.trim()
  const listId = read("MAILCHIMP_LIST_ID")?.trim()
  const serverPrefix = read("MAILCHIMP_SERVER_PREFIX")?.trim()
  if (!apiKey || !username || !listId || !serverPrefix) {
    return null
  }
  return { apiKey, username, listId, serverPrefix }
}

/**
 * Mailchimp v3 list-member client.
 *
 * The constructor performs no I/O, and a client built with blank credentials
 * throws rather than degrading to a disabled no-op: silently accepting an empty
 * key is exactly how the source hid a broken deployment. Use
 * `mailchimpConfigFromEnv` to make "not configured" explicit and `skipDisabled`
 * to record that outcome as a result a caller must handle.
 */
export class MailchimpClient {
  /** API root, e.g. `https://us21.api.mailchimp.com/3.0`. */
  readonly apiUrl: string
  private readonly config: MailchimpClientConfig
  private readonly fetcher: typeof fetch
  private readonly sleep: Sleeper
  private readonly clock: Clock
  private readonly policy: RetryPolicy
  private readonly backoff: BackoffFn
  private readonly readOnly: boolean

  constructor(config: MailchimpClientConfig, options: MailchimpClientOptions = {}) {
    const missing = (["apiKey", "username", "listId", "serverPrefix"] as const).filter((key) =>
      (config[key] ?? "").trim() === ""
    )
    if (missing.length > 0) {
      throw new Error(`MailchimpClient: missing ${missing.join(", ")}`)
    }
    this.config = config
    this.apiUrl = `https://${config.serverPrefix}.api.mailchimp.com/3.0`
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
    this.readOnly = options.readOnly ?? false
    this.policy = { ...DEFAULT_RETRY, ...options.retry, onDelay: options.onDelay }
    this.backoff = options.backoff ?? createExponentialBackoff(this.policy)
  }

  /**
   * Creates or updates a list member.
   *
   * Membership is resolved with `GET /lists/{list}/members/{hash}` — for
   * `emailBefore` first when given, then for the new address — and the result
   * is a `PATCH` on a known member or a `POST` for a new one. A `Member Exists`
   * 400 on that `POST` is reconciled with one `PATCH`, so two concurrent
   * signups for one address do not both fail.
   */
  async putContact(contact: MailchimpContact): Promise<MailchimpResult> {
    if (this.readOnly) {
      return { ok: false, code: "method_not_allowed", message: "client is read-only", attempts: 0 }
    }
    const email = contact.email?.trim() ?? ""
    if (email === "") {
      return { ok: false, code: "missing_email", message: "contact.email is empty", attempts: 0 }
    }

    const candidates = [contact.emailBefore?.trim(), email].filter(
      (candidate): candidate is string => Boolean(candidate),
    )
    let existingEmail: string | undefined
    let existingStatus = MailchimpStatus.Pending
    let attempts = 0
    for (const candidate of candidates) {
      const lookup = await this.lookupMember(candidate)
      if (!lookup.ok) {
        return lookup
      }
      attempts += lookup.attempts
      if (lookup.exists) {
        existingEmail = candidate
        existingStatus = lookup.status
        break
      }
    }

    const method: MailchimpUpsertMethod = existingEmail ? "PATCH" : "POST"
    const body = JSON.stringify({
      email_address: email,
      status_if_new: MailchimpStatus.Pending,
      status: existingStatus,
      merge_fields: { FNAME: contact.firstName, LNAME: contact.lastName },
    })
    const target = existingEmail ? this.memberPath(emailHash(existingEmail)) : this.listPath()
    const outcome = await this.send(target, { method, body })
    attempts += outcome.attempts
    if (outcome.ok) {
      return {
        ok: true,
        status: "upserted",
        method,
        httpStatus: outcome.httpStatus,
        change: existingEmail ? "updated" : "created",
        attempts,
      }
    }
    if (method === "POST" && outcome.status === 400 && outcome.bodyTitle === "Member Exists") {
      const patch = await this.send(this.memberPath(emailHash(email)), {
        method: "PATCH",
        body,
      })
      attempts += patch.attempts
      if (patch.ok) {
        return {
          ok: true,
          status: "upserted",
          method: "PATCH",
          httpStatus: patch.httpStatus,
          change: "updated",
          attempts,
        }
      }
      return { ...patch, attempts }
    }
    return { ...outcome, attempts }
  }

  /**
   * Looks up one member by address.
   *
   * A 404 is `{ ok: true, exists: false }` — the documented miss — not an
   * error, so callers branch on membership without reading status codes. Any
   * other non-2xx, or a 2xx body without a usable `status`, is a typed failure.
   */
  async searchContact(email: string): Promise<MailchimpMemberLookup> {
    const trimmed = email?.trim() ?? ""
    if (trimmed === "") {
      return { ok: false, code: "missing_email", message: "email is empty", attempts: 0 }
    }
    return await this.lookupMember(trimmed)
  }

  /** Records a deliberately disabled client as a result instead of a silent `true`. */
  skipDisabled(reason: MailchimpDisabledReason): MailchimpSkippedDisabled {
    return { ok: true, status: "skipped-disabled", reason, attempts: 0 }
  }

  private listPath(): string {
    return `/lists/${this.config.listId}/members`
  }

  private memberPath(hash: string): string {
    return `/lists/${this.config.listId}/members/${hash}`
  }

  private async lookupMember(email: string): Promise<MailchimpMemberLookup> {
    const outcome = await this.send(this.memberPath(emailHash(email)), { method: "GET" })
    if (outcome.ok) {
      return {
        ok: true,
        exists: true,
        status: outcome.memberStatus ?? MailchimpStatus.Pending,
        statusIfNew: outcome.statusIfNew,
        attempts: outcome.attempts,
      }
    }
    if (outcome.status === 404) {
      return { ok: true, exists: false, httpStatus: 404, attempts: outcome.attempts }
    }
    return outcome
  }

  /**
   * One request under the retry policy.
   *
   * 429 and 5xx retry, honouring `Retry-After`. Every other 4xx fails
   * immediately — a bad list id or a revoked key cannot succeed on retry. A
   * transport throw retries too: a DNS blip is the common transient case, and
   * the source swallowed it into a bare `false`.
   */
  private async send(
    path: string,
    init: { method: string; body?: string },
  ): Promise<MailchimpHttpSuccess | MailchimpHttpError> {
    let last: MailchimpHttpSuccess | MailchimpHttpError | undefined
    const run = await runWithRetry<MailchimpHttpSuccess | MailchimpHttpError>({
      policy: this.policy,
      sleep: this.sleep,
      clock: this.clock,
      backoff: this.backoff,
      attempt: async (attempt) => {
        const outcome = await this.attempt(path, init, attempt)
        last = outcome
        return {
          failed: !outcome.ok && outcome.retryable,
          retryAfterMs: outcome.ok ? undefined : outcome.retryAfterMs,
          value: outcome,
        }
      },
    })
    const settled = last ?? run.result
    return settled.ok ? settled : { ...settled, attempts: run.attempts }
  }

  private async attempt(
    path: string,
    init: { method: string; body?: string },
    attempt: number,
  ): Promise<MailchimpHttpSuccess | MailchimpHttpError> {
    try {
      const response = await this.fetcher(`${this.apiUrl}${path}`, {
        method: init.method,
        body: init.body,
        headers: {
          "Content-Type": "application/json",
          "Authorization": basicAuthHeader(this.config.username, this.config.apiKey),
        },
      })
      const payload = await readJsonObject(response)
      if (response.ok) {
        // A member payload always carries `status`; a 2xx without it is not a
        // record we can act on, so the caller is told rather than guessed at.
        if (response.status !== 204 && payload === undefined) {
          return {
            ok: false,
            code: "invalid_response",
            message: "2xx response was not a JSON object",
            status: response.status,
            attempts: attempt,
            retryable: false,
          }
        }
        return {
          ok: true,
          httpStatus: response.status,
          attempts: attempt,
          memberStatus: asMemberStatus(payload?.status),
          statusIfNew: asMemberStatus(payload?.status_if_new),
        }
      }
      return {
        ok: false,
        code: "http_error",
        message: `${response.status} ${response.statusText}`.trim(),
        status: response.status,
        attempts: attempt,
        bodyTitle: typeof payload?.title === "string" ? payload.title : undefined,
        retryable: isTransientStatus(response.status),
        retryAfterMs: parseRetryAfterMs(response.headers.get("Retry-After")),
      }
    } catch (cause) {
      return {
        ok: false,
        code: "network_error",
        message: cause instanceof Error ? cause.message : String(cause),
        attempts: attempt,
        retryable: true,
      }
    }
  }
}

interface MailchimpHttpSuccess {
  ok: true
  httpStatus: number
  attempts: number
  memberStatus?: MailchimpStatus
  statusIfNew?: MailchimpStatus
}

interface MailchimpHttpError {
  ok: false
  code: "http_error" | "network_error" | "invalid_response"
  message: string
  attempts: number
  status?: number
  bodyTitle?: string
  retryable: boolean
  retryAfterMs?: number
}

/**
 * Narrows a wire value to a `MailchimpStatus`.
 *
 * `value in MailchimpStatus` does **not** work for a TypeScript string enum:
 * the compiled object has no reverse mapping for string members, so the check
 * is always false and every member silently reads as `pending`. An explicit
 * lookup keyed by the wire values is the only correct form.
 */
const MEMBER_STATUS_BY_VALUE: Readonly<Record<string, MailchimpStatus>> = {
  [MailchimpStatus.Subscribed]: MailchimpStatus.Subscribed,
  [MailchimpStatus.Unsubscribed]: MailchimpStatus.Unsubscribed,
  [MailchimpStatus.Pending]: MailchimpStatus.Pending,
}

const asMemberStatus = (value: unknown): MailchimpStatus | undefined =>
  typeof value === "string" ? MEMBER_STATUS_BY_VALUE[value] : undefined

const readJsonObject = async (
  response: Response,
): Promise<Record<string, unknown> | undefined> => {
  try {
    const parsed: unknown = await response.json()
    return parsed !== null && typeof parsed === "object"
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}
