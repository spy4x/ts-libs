/**
 * Web Push message encryption (RFC 8291) and VAPID header (RFC 8292), without any network.
 *
 * Not an entry point: `push.ts` uses it and the known-answer test imports it. The key
 * agreement, key info and VAPID signing come from `@negrel/webpush`; the aes128gcm coding
 * (RFC 8188) from `@negrel/http-ece`; HKDF from WebCrypto. The library's own `pushMessage` is not
 * used because it calls the global `fetch` with redirects followed and no signal.
 * @module
 */

import { type ApplicationServer } from "@negrel/webpush"
import { encodeBase64Url } from "@std/encoding"
import * as ece from "@negrel/http-ece"
import type { PushSubscriptionKeys } from "@spy4x/platform/model"

/** The default `TTL` header, four weeks, as in the library. */
export const DEFAULT_TTL_SECONDS = 2_419_200

const RECORD_SIZE = 4096

/**
 * Encrypts `plaintext` for one subscription, returning the request body.
 * `salt` is random unless a test pins it.
 *
 * @throws when the subscription's keys are not valid base64url or not a P-256 point.
 */
export const encryptPayload = async (
  server: ApplicationServer,
  keys: PushSubscriptionKeys,
  plaintext: Uint8Array,
  salt?: Uint8Array,
): Promise<ArrayBuffer> => {
  const subscriber = server.subscribe({ endpoint: "https://invalid.example", keys })
  const secret = await crypto.subtle.importKey(
    "raw",
    await subscriber.getEcdhSecret(),
    "HKDF",
    false,
    ["deriveBits"],
  )
  // HKDF-Extract(auth, ecdh) then Expand(key_info || 0x01, 32): RFC 8291 section 3.4.
  const ikm = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: subscriber.authSecret(),
      info: (await subscriber.getKeyInfo()).slice(),
    },
    secret,
    256,
  )
  // Record size 4096: the maximum RFC 8291 section 4 allows. The coding's default is 65536,
  // which a push service is entitled to refuse.
  return ece.encrypt(plaintext.slice().buffer, ikm, {
    header: { keyid: await server.getPublicKeyRaw(), rs: RECORD_SIZE, ...(salt ? { salt } : {}) },
  })
}

/** The `Authorization` header value for a request to `endpoint`. */
export const vapidAuthorization = async (
  server: ApplicationServer,
  endpoint: string,
): Promise<string> => {
  const subscriber = server.subscribe({ endpoint, keys: { auth: "", p256dh: "" } })
  const token = await subscriber.forgeVapidToken()
  return `vapid t=${token}, k=${encodeBase64Url(await server.getVapidPublicKeyRaw())}`
}
