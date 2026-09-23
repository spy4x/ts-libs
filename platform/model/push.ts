/**
 * Web Push wire schemas: what a browser's `PushSubscription` serialises to, and the two requests a
 * server accepts to subscribe or unsubscribe a device.
 *
 * Moved from `template/libs/platform/types/+index.ts`, unchanged apart from the `"+": "reject"`
 * decision below. The Web Push service that sends the notification these schemas describe is not
 * part of this wave.
 *
 * **`"+": "reject"` decision: every schema in this file declares it, on its own top level.**
 * Unlike the base model schemas in `base-model.ts`, nothing here is composed with `.and()` — a
 * subscription, an (un)subscribe request and a notification message are the whole wire shape the
 * server receives from a browser it does not control, not a base another schema extends. Rejecting
 * an unrecognised key at each level (including the nested `keys` object) turns a malformed or
 * probing payload into a validation error instead of silently dropping the extra field, and none of
 * these five schemas is ever composed further, so the intersection hazard documented in
 * `base-model.ts` does not apply here — confirmed for the nested case: composing a `"+": "reject"`
 * schema as another object's *property* (as `keys` sits inside `pushSubscriptionSchema`) rejects an
 * extra key inside `keys` without affecting the parent, unlike intersecting one in with `.and()`.
 */
import { type Type, type } from "arktype"
import type { Default } from "arktype/internal/attributes.ts"

/** The two keys a `PushSubscription`'s `getKey` calls produce, base64url-encoded. */
export const pushSubscriptionKeysSchema: Type<{ auth: string; p256dh: string }> = type({
  "+": "reject",
  auth: "string <= 256",
  p256dh: "string <= 256",
})
/** Value {@link pushSubscriptionKeysSchema} produces. */
export type PushSubscriptionKeys = typeof pushSubscriptionKeysSchema.infer

/** A browser's `PushSubscription`, as `JSON.stringify`d by `PushSubscription.toJSON()`. */
export const pushSubscriptionSchema: Type<{
  endpoint: string
  expirationTime: Default<number | null, null>
  keys: { auth: string; p256dh: string }
}> = type({
  "+": "reject",
  endpoint: "string <= 256",
  expirationTime: "number | null = null",
  keys: pushSubscriptionKeysSchema,
})
/** Value {@link pushSubscriptionSchema} produces. */
export type PushSubscriptionJson = typeof pushSubscriptionSchema.infer

/** Request body to register a device's push subscription. */
export const pushSubscribeRequestSchema: Type<{
  deviceId: string
  subscription: {
    endpoint: string
    expirationTime: Default<number | null, null>
    keys: { auth: string; p256dh: string }
  }
}> = type({
  "+": "reject",
  deviceId: "string <= 256",
  subscription: pushSubscriptionSchema,
})
/** Value {@link pushSubscribeRequestSchema} produces. */
export type PushSubscribeRequest = typeof pushSubscribeRequestSchema.infer

/** Request body to drop a device's push subscription. */
export const pushUnsubscribeRequestSchema: Type<{ deviceId: string }> = type({
  "+": "reject",
  deviceId: "string <= 256",
})
/** Value {@link pushUnsubscribeRequestSchema} produces. */
export type PushUnsubscribeRequest = typeof pushUnsubscribeRequestSchema.infer

/** A notification the server sends through a push subscription. */
export const pushNotificationMessageSchema: Type<{
  title: string
  body: Default<string | null, null>
  url: Default<string | null, null>
}> = type({
  "+": "reject",
  title: "1 <= string <= 120",
  body: "string <= 500 | null = null",
  url: "string <= 2048 | null = null",
})
/** Value {@link pushNotificationMessageSchema} produces. */
export type PushNotificationMessage = typeof pushNotificationMessageSchema.infer

/** Alias for {@link PushSubscriptionJson} used where the wire origin is not the point. */
export type PushSubscriptionData = PushSubscriptionJson
