import { type } from "arktype"
import { decodeBase64Url } from "@std/encoding/base64url"
import { encodeHex } from "@std/encoding/hex"
import {
  createSignedPayloadCodec,
  MAX_SIGNED_PAYLOAD_LENGTH,
  SignedPayloadErrorCode,
} from "@spy4x/platform/signed-payload"
import type { Subscriber, SubscriberStore } from "./store.ts"

/** How long a confirm link works: three days. */
export const CONFIRM_TTL_MS = 3 * 24 * 60 * 60 * 1000

/** Purpose labels of the signed-payload codec. Version 1 is antonshubin.com's format. */
const CONFIRM_PURPOSE = "subscribe-confirm"
const UNSUBSCRIBE_PURPOSE = "unsubscribe"
/** Message prefixes of the raw HMACs. antonshubin.com's marks use the first two, byte for byte. */
const UNSUBSCRIBE_MARK_PREFIX = "unsubscribed:"
const SENT_MARK_PREFIX = "newsletter-sent:"
const SUBSCRIBER_KEY_PREFIX = "subscriber-key:"
const SUBSCRIBER_KEY_BYTES = 16

const confirmPayload = type({ "+": "reject", email: "string", iat: "number.integer" })
const unsubscribePayload = type({ "+": "reject", k: /^[0-9a-f]{32}$/ })
const legacyUnsubscribePayload = type({ "+": "reject" })

/** Options of {@link createSubscriptionCrypto}. */
export interface SubscriptionCryptoOptions {
  /** Signs every new token and keys every mark, at least 32 printable characters. */
  secret: string
  /**
   * Earlier secrets, tried after `secret` when an unsubscribe token is verified, so links mailed
   * before a rotation keep working. Never used to sign, to key a mark or to verify a confirm token:
   * unsubscribe marks are keyed by `secret` alone, so a confirm link signed before the rotation
   * could not be matched against an unsubscribe recorded before it. A pending confirm link stops
   * working at a rotation; the visitor asks again.
   */
  previousSecrets?: readonly string[]
  /** Clock in Unix milliseconds. Defaults to `Date.now`. */
  now?: () => number
}

/** What {@link SubscriptionCrypto.verifyConfirmToken} found. `issuedAt` is in Unix milliseconds. */
export type ConfirmTokenResult =
  | { ok: true; email: string; issuedAt: number }
  | { ok: false; reason: "expired" | "invalid" }

/** The lookups {@link SubscriptionCrypto.verifyUnsubscribeToken} needs. */
export type UnsubscribeLookup = Pick<SubscriberStore, "findByKey" | "list">

/** Tokens and keyed hashes for one mailing list. Made by {@link createSubscriptionCrypto}. */
export interface SubscriptionCrypto {
  /** A version 2 confirm token for `email`: it carries the address and its issue time, binds the
   * address as context, and expires after {@link CONFIRM_TTL_MS}. */
  confirmToken(email: string): Promise<string>
  /** The address and issue time a confirm token carries, or why it is refused. Only `secret`
   * verifies it, never `previousSecrets`. A version 1 token (antonshubin.com's) is `"invalid"`.
   * Never throws. */
  verifyConfirmToken(token: string): Promise<ConfirmTokenResult>
  /** A version 2 unsubscribe token for `email`: it carries the address's {@link subscriberKey},
   * binds the address as context and never expires. The token holds no address. */
  unsubscribeToken(email: string): Promise<string>
  /**
   * The subscriber an unsubscribe token was issued for, or `undefined` for a forged token and for
   * an address no longer on the list alike. A version 2 token costs one `findByKey` and one HMAC
   * per secret. A version 1 token carries nothing to look up, so it is checked against every
   * listed address: rate-limit the callers that can reach it (the flows in this module do). Never
   * throws for a malformed token; a failing store rejects.
   */
  verifyUnsubscribeToken(token: string, lookup: UnsubscribeLookup): Promise<Subscriber | undefined>
  /** The 16-byte keyed hash of `email`, in hex: the store's lookup key. */
  subscriberKey(email: string): Promise<string>
  /** The keyed hash that records an unsubscribe of `email` without naming it, in hex. */
  unsubscribeMark(email: string): Promise<string>
  /** The keyed hash that records "`email` got `issue`" without naming the address, in hex. */
  sentMark(email: string, issue: string): Promise<string>
}

/** The token's unverified envelope: version and payload, read only to pick a lookup. */
interface Peeked {
  version: unknown
  payload: Record<string, unknown>
}

/**
 * Creates the tokens and keyed hashes of one mailing list over one secret. Every purpose is kept
 * apart by a signed-payload purpose or an HMAC message prefix, so a token for one purpose never
 * verifies for another and no mark equals another. Addresses are trimmed and lowercased first.
 *
 * Compatible with antonshubin.com: its unsubscribe links (version 1), unsubscribe marks and sent
 * marks verify and match byte for byte under the same secret.
 *
 * @throws {TokenError} `InvalidSecret` when `secret` or any of `previousSecrets` is unusable.
 */
export function createSubscriptionCrypto(options: SubscriptionCryptoOptions): SubscriptionCrypto {
  const secrets = [options.secret, ...(options.previousSecrets ?? [])]
  const now = options.now ?? Date.now
  const confirm = createSignedPayloadCodec({
    secret: options.secret,
    purpose: CONFIRM_PURPOSE,
    version: 2,
    schema: confirmPayload,
    now,
  })
  const codecs = secrets.map((secret) => ({
    unsubscribe: createSignedPayloadCodec({
      secret,
      purpose: UNSUBSCRIBE_PURPOSE,
      version: 2,
      schema: unsubscribePayload,
    }),
    legacyUnsubscribe: createSignedPayloadCodec({
      secret,
      purpose: UNSUBSCRIBE_PURPOSE,
      version: 1,
      schema: legacyUnsubscribePayload,
    }),
  }))
  const current = codecs[0]
  const hmacKey = crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  async function mac(message: string): Promise<Uint8Array> {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await hmacKey,
      new TextEncoder().encode(message),
    )
    return new Uint8Array(signature)
  }

  async function subscriberKey(email: string): Promise<string> {
    const digest = await mac(`${SUBSCRIBER_KEY_PREFIX}${normalize(email)}`)
    return encodeHex(digest.subarray(0, SUBSCRIBER_KEY_BYTES))
  }

  return {
    async confirmToken(email) {
      const address = normalize(email)
      return await confirm.sign({ email: address, iat: now() }, {
        context: address,
        ttlMs: CONFIRM_TTL_MS,
      })
    },

    async verifyConfirmToken(token) {
      const email = peek(token)?.payload.email
      if (typeof email !== "string") return { ok: false, reason: "invalid" }
      const result = await confirm.verify(token, { context: email })
      if (result.ok) return { ok: true, email: result.value.email, issuedAt: result.value.iat }
      return {
        ok: false,
        reason: result.error === SignedPayloadErrorCode.Expired ? "expired" : "invalid",
      }
    },

    async unsubscribeToken(email) {
      const address = normalize(email)
      return await current.unsubscribe.sign({ k: await subscriberKey(address) }, {
        context: address,
      })
    },

    async verifyUnsubscribeToken(token, lookup) {
      const peeked = peek(token)
      if (peeked?.version === 2) {
        const key = peeked.payload.k
        if (typeof key !== "string") return undefined
        const subscriber = await lookup.findByKey(key)
        if (subscriber === undefined) return undefined
        for (const codec of codecs) {
          const result = await codec.unsubscribe.verify(token, {
            context: normalize(subscriber.email),
          })
          if (result.ok) return subscriber
        }
        return undefined
      }
      if (peeked?.version !== 1) return undefined
      for (const subscriber of await lookup.list()) {
        for (const codec of codecs) {
          const result = await codec.legacyUnsubscribe.verify(token, {
            context: normalize(subscriber.email),
          })
          if (result.ok) return subscriber
        }
      }
      return undefined
    },

    subscriberKey,

    async unsubscribeMark(email) {
      return encodeHex(await mac(`${UNSUBSCRIBE_MARK_PREFIX}${normalize(email)}`))
    },

    async sentMark(email, issue) {
      return encodeHex(await mac(`${SENT_MARK_PREFIX}${issue}:${normalize(email)}`))
    },
  }
}

/** The unsubscribe-token version, read without verifying: 1, 2, or `undefined` when the token is
 * not a signed payload at all. The flows use it to rate-limit only the version 1 scan. */
export function unsubscribeTokenVersion(token: string): number | undefined {
  const version = peek(token)?.version
  return typeof version === "number" ? version : undefined
}

/** Trim, then lowercase: one inbox, one form. */
function normalize(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Reads the envelope of a signed payload without checking it. Only the lookup is chosen from what
 * it returns; the codec verifies the token afterwards, so a forged envelope gains nothing.
 */
function peek(token: string): Peeked | undefined {
  if (typeof token !== "string" || token.length > MAX_SIGNED_PAYLOAD_LENGTH) return undefined
  try {
    const envelope = JSON.parse(new TextDecoder().decode(decodeBase64Url(token.split(".")[0])))
    const payload = envelope?.payload
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return undefined
    }
    return { version: envelope.version, payload }
  } catch {
    return undefined
  }
}
