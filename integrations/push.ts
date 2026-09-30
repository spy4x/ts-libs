/**
 * Web Push sender: one notification to every stored subscription of one user.
 *
 * Ported from `template/apps/api/services/web-push-service.ts` and `webPush.ts`. The
 * template's Postgres store, its `UserPushTokenPublic` shape and its welcome push stay in the
 * app; the store is a two-method port ({@link PushSubscriptionStore}) and the subscription is
 * `platform/model`'s `PushSubscriptionJson`, not a second shape.
 *
 * Encryption (RFC 8291) and VAPID signing (RFC 8292) are done by `@negrel/webpush`, kept
 * rather than reimplemented.
 *
 * Behaviour:
 *
 *  - {@link WebPushSender.send} never throws. It returns one {@link PushDelivery} per
 *    subscription; one bad subscription does not stop the others.
 *  - A push service answering 404 or 410 says the subscription is gone: it is deleted from
 *    the store. Every other failure keeps it, because a 5xx or a timeout says nothing about
 *    the subscription.
 *  - The payload is checked against `pushNotificationMessageSchema` before anything is sent.
 *  - An endpoint must be a public HTTPS address (`@spy4x/net/url-policy`), because the
 *    browser, not the app, chose it. The check resolves DNS once and the library then resolves
 *    it again to connect, so it narrows the SSRF surface without closing a DNS-rebinding race.
 *  - Each send is bounded by a timeout. The library owns its `fetch` call and offers no
 *    signal, so a timed-out request is abandoned, not aborted; it ends on its own.
 *  - `error` and `output` never contain an endpoint (its path is a capability), a key, or
 *    a response body: statuses and error class names only.
 * @module
 */

import {
  ApplicationServer,
  exportApplicationServerKey,
  type ExportedVapidKeys,
  exportVapidKeys,
  generateVapidKeys,
  importVapidKeys,
  type PushMessageOptions,
} from "@negrel/webpush"
import { type } from "arktype"
import { pushNotificationMessageSchema } from "@spy4x/platform/model"
import type { PushNotificationMessage, PushSubscriptionJson } from "@spy4x/platform/model"
import { type DnsResolver, validatePublicUrl } from "@spy4x/net/url-policy"
import { DEFAULT_REQUEST_TIMEOUT_MS, describeTransportError, releaseResponseBody } from "./retry.ts"

export type { ExportedVapidKeys }

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
  /** Removes the subscription with this endpoint. Called for a 404 or 410 answer only. */
  deleteByEndpoint(userId: string | number, endpoint: string): Promise<void>
}

/**
 * Sends one already-serialised message to one subscription. It throws when the push service
 * refuses; an error carrying `response` (as `@negrel/webpush`'s `PushMessageError` does) has
 * its status read. Tests replace it; the default uses the library.
 */
export type PushTransport = (
  subscription: PushSubscriptionJson,
  message: string,
  options: PushOptions,
) => Promise<void>

/** Options for {@link createWebPushSender}. */
export interface WebPushSenderOptions {
  /** VAPID keys as produced by {@link generateVapidKeyPair}. The private half is a secret. */
  vapidKeys: ExportedVapidKeys
  /** Contact for the push service, a `mailto:` or `https:` URL (RFC 8292). */
  subject: string
  store: PushSubscriptionStore
  /** Replaces the library, for tests. */
  transport?: PushTransport
  /** DNS resolver for the endpoint check. Defaults to the system resolver. */
  resolver?: DnsResolver
  /** Limit for each subscription, `DEFAULT_REQUEST_TIMEOUT_MS` (10 s) by default. */
  requestTimeoutMs?: number
}

/** Outcome for one subscription. */
export interface PushDelivery {
  endpoint: string
  /** `sent`; `gone` (404 or 410, deleted); `failed` (kept). */
  status: "sent" | "gone" | "failed"
  /** The push service's HTTP status, when it answered. */
  httpStatus?: number
  /** Why it failed, without secrets. Empty for `sent` and `gone`. */
  error: string
  /** True when the subscription was removed from the store. */
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
  keys: ExportedVapidKeys
}

/** Generates a VAPID key pair with WebCrypto (ECDSA P-256). */
export const generateVapidKeyPair = async (): Promise<VapidKeyPair> => {
  const pair = await generateVapidKeys({ extractable: true })
  return { publicKey: await exportApplicationServerKey(pair), keys: await exportVapidKeys(pair) }
}

/** The public key of stored VAPID keys, base64url, for the endpoint that serves it to browsers. */
export const vapidPublicKey = async (keys: ExportedVapidKeys): Promise<string> =>
  exportApplicationServerKey(await importVapidKeys(keys))

const GONE_STATUSES = new Set([404, 410])
const MAX_PAYLOAD_ERROR_CHARS = 200

/** Sends to every stored subscription of a user. Build one with {@link createWebPushSender}. */
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
}

const statusOf = (cause: unknown): number | undefined => {
  const response = (cause as { response?: unknown } | null)?.response
  return response instanceof Response ? response.status : undefined
}

const describeFailure = (cause: unknown, httpStatus: number | undefined): string =>
  httpStatus !== undefined ? `HTTP ${httpStatus}` : describeTransportError(cause)

const settleResponse = async (cause: unknown): Promise<void> => {
  const response = (cause as { response?: unknown } | null)?.response
  if (response instanceof Response) await releaseResponseBody(response).catch(() => undefined)
}

/**
 * Builds a sender. Throws on unusable VAPID keys or an empty subject: those are configuration
 * errors, found at start-up rather than at the first push.
 */
export const createWebPushSender = async (
  options: WebPushSenderOptions,
): Promise<WebPushSender> => {
  const { store, resolver, subject } = options
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  if (typeof subject !== "string" || subject.trim() === "") {
    throw new Error("createWebPushSender: subject is required")
  }
  const transport: PushTransport = options.transport ?? await (async () => {
    const server = await ApplicationServer.new({
      contactInformation: subject,
      vapidKeys: await importVapidKeys(options.vapidKeys),
    })
    return (subscription, message, pushOptions) =>
      server.subscribe(subscription).pushTextMessage(message, pushOptions as PushMessageOptions)
  })()

  const deliver = async (
    userId: string | number,
    subscription: PushSubscriptionJson,
    message: string,
    pushOptions: PushOptions,
  ): Promise<PushDelivery> => {
    const { endpoint } = subscription
    const fail = (error: string, httpStatus?: number): PushDelivery => ({
      endpoint,
      status: "failed",
      httpStatus,
      error,
      deleted: false,
    })
    try {
      await validatePublicUrl(endpoint, { allowHttp: false, resolver })
    } catch {
      return fail("endpoint is not a public HTTPS address")
    }
    let timer: number | undefined
    try {
      await Promise.race([
        transport(subscription, message, pushOptions),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DOMException("timed out", "TimeoutError")), timeoutMs)
        }),
      ])
      return { endpoint, status: "sent", error: "", deleted: false }
    } catch (cause) {
      await settleResponse(cause)
      const httpStatus = statusOf(cause)
      if (httpStatus !== undefined && GONE_STATUSES.has(httpStatus)) {
        try {
          await store.deleteByEndpoint(userId, endpoint)
          return { endpoint, status: "gone", httpStatus, error: "", deleted: true }
        } catch (storeCause) {
          return fail(
            `HTTP ${httpStatus}, subscription not deleted: ${describeTransportError(storeCause)}`,
            httpStatus,
          )
        }
      }
      if (cause instanceof DOMException && cause.name === "TimeoutError") {
        return fail(`request timed out after ${timeoutMs} ms`)
      }
      return fail(describeFailure(cause, httpStatus), httpStatus)
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async send(userId, message, pushOptions = {}) {
      const failure = (error: string): PushSendResult => ({
        success: false,
        output: "",
        error,
        deliveries: [],
      })
      try {
        const parsed = pushNotificationMessageSchema(message)
        if (parsed instanceof type.errors) {
          return failure(
            `invalid push payload: ${String(parsed.summary).slice(0, MAX_PAYLOAD_ERROR_CHARS)}`,
          )
        }
        const text = JSON.stringify(parsed)
        const subscriptions = await store.listByUser(userId)
        const deliveries = await Promise.all(
          subscriptions.map((subscription) => deliver(userId, subscription, text, pushOptions)),
        )
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
      } catch (cause) {
        return failure(describeTransportError(cause))
      }
    },
  }
}
