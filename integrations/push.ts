/**
 * Web Push sender: one notification to every stored subscription of one user.
 *
 * Ported from `template/apps/api/services/web-push-service.ts` and `webPush.ts`. The
 * template's Postgres store, its `UserPushTokenPublic` shape and its welcome push stay in the
 * app; the store is a two-method port ({@link PushSubscriptionStore}) and the subscription is
 * `platform/model`'s `PushSubscriptionJson`, not a second shape.
 *
 * Keys, encryption (RFC 8291) and VAPID signing come from `@negrel/webpush` and
 * `@negrel/http-ece` (see `push-crypto.ts`). The library's own `pushMessage` is not used: it
 * calls the global `fetch`, follows redirects and takes no signal. The request is sent here.
 *
 * Behaviour:
 *
 *  - {@link WebPushSender.sendTo} pushes to one given subscription through the same delivery
 *    path, never touches the store, and leaves deleting a `gone` subscription to the caller.
 *  - {@link WebPushSender.send} never throws. It returns one {@link PushDelivery} per
 *    subscription; one bad subscription does not stop the others.
 *  - A push service answering 404 or 410 says the subscription is gone: it is deleted from
 *    the store. Every other failure keeps it, because a 5xx or a timeout says nothing about
 *    the subscription. So does a subscription whose keys are malformed: that is reported.
 *  - The payload is checked against `pushNotificationMessageSchema` before anything is sent.
 *  - An endpoint must be a public HTTPS address (`@spy4x/net/url-policy`), because the
 *    browser, not the app, chose it. Redirects are never followed (`redirect: "manual"`): a
 *    3xx answer is a failure, so a push service cannot send the request to a private address.
 *    `safeFetch` was not used because it cannot carry a request body.
 *  - One deadline covers the DNS check and the request, and it aborts the request.
 *  - `error` and `output` never contain an endpoint (its path is a capability), a key, or
 *    a response body: statuses and error class names only.
 * @module
 */

import {
  ApplicationServer,
  exportApplicationServerKey,
  exportVapidKeys,
  generateVapidKeys,
  importVapidKeys,
} from "@negrel/webpush"
import { type } from "arktype"
import { pushNotificationMessageSchema } from "@spy4x/platform/model"
import type { PushNotificationMessage, PushSubscriptionJson } from "@spy4x/platform/model"
import { type DnsResolver, validatePublicUrl } from "@spy4x/net/url-policy"
import { DEFAULT_TTL_SECONDS, encryptPayload, vapidAuthorization } from "./push-crypto.ts"
import { DEFAULT_REQUEST_TIMEOUT_MS, describeTransportError, releaseResponseBody } from "./retry.ts"

/** How urgently the push service should deliver (RFC 8030). */
export type PushUrgency = "very-low" | "low" | "normal" | "high"

/** Delivery options of one send. */
export interface PushOptions {
  urgency?: PushUrgency
  /** Seconds the push service keeps the message while the device is offline. */
  ttl?: number
  /** Replaces a pending message with the same topic. */
  topic?: string
}

/** What the app implements over its own database. */
export interface PushSubscriptionStore {
  /** Every subscription of `userId`, one per device. */
  listByUser(userId: string | number): Promise<readonly PushSubscriptionJson[]>
  /** Removes the subscription of `userId` with this endpoint. Called for a 404 or 410 only. */
  deleteByEndpoint(userId: string | number, endpoint: string): Promise<void>
}

/** A VAPID key pair as two JWKs (ECDSA P-256). The private half is a secret. */
export interface VapidKeys {
  publicKey: JsonWebKey
  privateKey: JsonWebKey
}

/** Options for {@link createWebPushSender}. */
export interface WebPushSenderOptions {
  /** VAPID keys as produced by {@link generateVapidKeyPair}. */
  vapidKeys: VapidKeys
  /** Contact for the push service, a `mailto:` or `https:` URL (RFC 8292). */
  subject: string
  store: PushSubscriptionStore
  /** Defaults to `globalThis.fetch`. Called with `redirect: "manual"` and an abort signal. */
  fetch?: typeof fetch
  /** DNS resolver for the endpoint check. Defaults to the system resolver. */
  resolver?: DnsResolver
  /** Limit for DNS and request together, per subscription. 10 s by default. */
  requestTimeoutMs?: number
}

/** Outcome for one subscription. */
export interface PushDelivery {
  endpoint: string
  /** `sent`; `gone` (404 or 410, deleted by `send`, left to the caller by `sendTo`); `failed`. */
  status: "sent" | "gone" | "failed"
  /** The push service's HTTP status, when it answered. */
  httpStatus?: number
  /** Why it failed, without secrets. Empty for `sent` and `gone`. */
  error: string
  /** True when the subscription was removed from the store; false for `sendTo`. */
  deleted: boolean
}

/** Outcome of {@link WebPushSender.send}; `success` is false when any delivery `failed`. */
export interface PushSendResult {
  success: boolean
  output: string
  error: string
  deliveries: readonly PushDelivery[]
}

/** A VAPID key pair ready to store and to hand to a browser. */
export interface VapidKeyPair {
  /** The `applicationServerKey` a browser passes to `pushManager.subscribe`, base64url. */
  publicKey: string
  /** Both halves as JWK; store this and pass it as `vapidKeys`. Contains the private key. */
  keys: VapidKeys
}

/** Generates a VAPID key pair with WebCrypto (ECDSA P-256). */
export const generateVapidKeyPair = async (): Promise<VapidKeyPair> => {
  const pair = await generateVapidKeys({ extractable: true })
  return { publicKey: await exportApplicationServerKey(pair), keys: await exportVapidKeys(pair) }
}

/** The public key of stored VAPID keys, base64url, for the endpoint that serves it to browsers. */
export const vapidPublicKey = async (keys: VapidKeys): Promise<string> =>
  exportApplicationServerKey(await importVapidKeys(keys))

const GONE_STATUSES = new Set([404, 410])
const MAX_PAYLOAD_ERROR_CHARS = 200
/** 4096-byte push body minus the 86-byte header, 16-byte tag and 1-byte padding delimiter. */
const MAX_PAYLOAD_BYTES = 3993
const encoder = new TextEncoder()

/** Sends to every stored subscription of a user, or to one given subscription. Build one with {@link createWebPushSender}. */
export interface WebPushSender {
  /**
   * Pushes `message` to each subscription of `userId` and reports each outcome. Never throws.
   *
   * @example
   * ```ts
   * const result = await sender.send(user.id, { title: "Backup done" })
   * if (!result.success) console.warn(result.error)
   * ```
   */
  send(
    userId: string | number,
    message: PushNotificationMessage,
    options?: PushOptions,
  ): Promise<PushSendResult>

  /**
   * Pushes `message` to this one subscription and reports the outcome in the same shape as
   * {@link WebPushSender.send}, with one delivery. Never throws and never touches the store.
   * A 404 or 410 gives status `gone` with `deleted: false`: the sender has no user to delete
   * it for, so the caller removes the subscription.
   *
   * @example
   * ```ts
   * const result = await sender.sendTo(subscription, { title: "Welcome", body: null, url: null })
   * if (result.deliveries[0]?.status === "gone") await myStore.delete(subscription.endpoint)
   * ```
   */
  sendTo(
    subscription: PushSubscriptionJson,
    message: PushNotificationMessage,
    options?: PushOptions,
  ): Promise<PushSendResult>
}

/**
 * Builds a sender. Throws on unusable VAPID keys or an empty subject: those are configuration
 * errors, found at start-up rather than at the first push.
 */
export const createWebPushSender = async (
  options: WebPushSenderOptions,
): Promise<WebPushSender> => {
  const { store, subject } = options
  const fetcher = options.fetch ?? globalThis.fetch
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (typeof subject !== "string" || subject.trim() === "") {
    throw new Error("createWebPushSender: subject is required")
  }
  const server = await ApplicationServer.new({
    contactInformation: subject,
    vapidKeys: await importVapidKeys(options.vapidKeys),
  })

  const deliver = async (
    subscription: PushSubscriptionJson,
    message: Uint8Array,
    pushOptions: PushOptions,
    /** Removes a gone subscription; absent when the caller deletes it. */
    onGone?: () => Promise<void>,
  ): Promise<PushDelivery> => {
    const { endpoint } = subscription
    const fail = (error: string, httpStatus?: number): PushDelivery => ({
      endpoint,
      status: "failed",
      httpStatus,
      error,
      deleted: false,
    })

    let body: ArrayBuffer
    let authorization: string
    try {
      body = await encryptPayload(server, subscription.keys, message)
      authorization = await vapidAuthorization(server, endpoint)
    } catch {
      return fail("malformed subscription keys or endpoint")
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // Rejects when the deadline passes, so a DNS lookup that ignores it cannot outlast it.
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(new DOMException("timed out", "TimeoutError")),
        { once: true },
      )
    })
    deadline.catch(() => undefined)
    try {
      try {
        await Promise.race([
          validatePublicUrl(endpoint, { allowHttp: false, resolver: options.resolver }),
          deadline,
        ])
      } catch (cause) {
        if (controller.signal.aborted) throw cause
        return fail("endpoint is not a public HTTPS address")
      }
      const headers: Record<string, string> = {
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "Urgency": pushOptions.urgency ?? "normal",
        "TTL": String(Math.max(0, Math.floor(pushOptions.ttl ?? DEFAULT_TTL_SECONDS))),
        "Authorization": authorization,
      }
      if (pushOptions.topic !== undefined) headers["Topic"] = pushOptions.topic
      const response = await fetcher(endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      })
      await releaseResponseBody(response).catch(() => undefined)
      if (response.ok) return { endpoint, status: "sent", error: "", deleted: false }
      if (GONE_STATUSES.has(response.status)) {
        try {
          await onGone?.()
          return {
            endpoint,
            status: "gone",
            httpStatus: response.status,
            error: "",
            deleted: onGone !== undefined,
          }
        } catch (storeCause) {
          return fail(
            `HTTP ${response.status}, subscription not deleted: ${
              describeTransportError(storeCause)
            }`,
            response.status,
          )
        }
      }
      const redirected = response.status >= 300 && response.status < 400
      return fail(
        `HTTP ${response.status}${redirected ? " (redirect not followed)" : ""}`,
        response.status,
      )
    } catch (cause) {
      return fail(
        controller.signal.aborted
          ? `request timed out after ${timeoutMs} ms`
          : describeTransportError(cause),
      )
    } finally {
      clearTimeout(timer)
    }
  }

  const failure = (error: string): PushSendResult => ({
    success: false,
    output: "",
    error,
    deliveries: [],
  })

  /** Validates and encodes the payload: the bytes to encrypt, or the failure to return. */
  const encode = (message: PushNotificationMessage): Uint8Array | PushSendResult => {
    const parsed = pushNotificationMessageSchema(message)
    if (parsed instanceof type.errors) {
      return failure(`invalid push payload: ${parsed.summary.slice(0, MAX_PAYLOAD_ERROR_CHARS)}`)
    }
    const bytes = encoder.encode(JSON.stringify(parsed))
    if (bytes.length > MAX_PAYLOAD_BYTES) {
      return failure(`push payload is ${bytes.length} bytes; the limit is ${MAX_PAYLOAD_BYTES}`)
    }
    return bytes
  }

  const summarize = (deliveries: readonly PushDelivery[]): PushSendResult => {
    const count = (status: PushDelivery["status"]) =>
      deliveries.filter((delivery) => delivery.status === status).length
    const failed = deliveries.filter((delivery) => delivery.status === "failed")
    return {
      success: failed.length === 0,
      output: `${count("sent")} sent, ${
        count("gone")
      } removed, ${failed.length} failed of ${deliveries.length}`,
      error: [...new Set(failed.map((delivery) => delivery.error))].join("; "),
      deliveries,
    }
  }

  return {
    async send(userId, message, pushOptions = {}) {
      try {
        const bytes = encode(message)
        if (!(bytes instanceof Uint8Array)) return bytes
        const subscriptions = await store.listByUser(userId)
        const deliveries = await Promise.all(
          subscriptions.map((subscription) =>
            deliver(
              subscription,
              bytes,
              pushOptions,
              () => store.deleteByEndpoint(userId, subscription.endpoint),
            )
          ),
        )
        return summarize(deliveries)
      } catch (cause) {
        return failure(describeTransportError(cause))
      }
    },
    async sendTo(subscription, message, pushOptions = {}) {
      try {
        const bytes = encode(message)
        if (!(bytes instanceof Uint8Array)) return bytes
        return summarize([await deliver(subscription, bytes, pushOptions)])
      } catch (cause) {
        return failure(describeTransportError(cause))
      }
    },
  }
}
