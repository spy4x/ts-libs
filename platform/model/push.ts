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
import type { Default } from "./default.ts"

import { hasUnstorableTextCharacters } from "../universal/text.ts"

/**
 * The longest value, in characters, of each text field of a push subscription request. The
 * schemas below refuse anything longer, so a table that stores these fields sizes its columns from
 * these numbers instead of keeping its own copy.
 *
 * Edge on Windows issues endpoints of about 400 characters; 2048 is the bound of a notification's
 * `url` as well.
 */
export const PUSH_SUBSCRIPTION_LIMITS: {
  readonly deviceId: 256
  readonly endpoint: 2048
  readonly auth: 256
  readonly p256dh: 256
} = Object.freeze({ deviceId: 256, endpoint: 2048, auth: 256, p256dh: 256 })

/**
 * A non-empty text field of at most `max` characters that a database can store: no NUL and no lone
 * surrogate (see {@link hasUnstorableTextCharacters}). Postgres refuses a NUL with an error, so
 * letting one through turns a bad request into a server error.
 */
function storableText(max: number): Type<string> {
  return type("string").narrow((value, ctx) => {
    if (value.length === 0) return ctx.mustBe("non-empty")
    if (value.length > max) return ctx.mustBe(`at most ${max} characters`)
    if (hasUnstorableTextCharacters(value)) return ctx.mustBe("free of NUL and lone surrogates")
    return true
  })
}

/**
 * Whether `value` parses as an absolute `https:` URL. A push service is always reached over https,
 * and anything else stored as an endpoint fails at every send.
 */
function isHttpsUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  return new URL(value).protocol === "https:"
}

/** The push endpoint: storable text, at most {@link PUSH_SUBSCRIPTION_LIMITS}`.endpoint`, https. */
const endpointSchema: Type<string> = storableText(PUSH_SUBSCRIPTION_LIMITS.endpoint).narrow(
  (value, ctx) => isHttpsUrl(value) || ctx.mustBe("an https: URL"),
)

/** The device id a request names: storable text, at most {@link PUSH_SUBSCRIPTION_LIMITS}`.deviceId`. */
const deviceIdSchema: Type<string> = storableText(PUSH_SUBSCRIPTION_LIMITS.deviceId)

/**
 * The two keys a `PushSubscription`'s `getKey` calls produce, base64url-encoded. Each is non-empty,
 * at most {@link PUSH_SUBSCRIPTION_LIMITS} long and free of NUL and lone surrogates.
 */
export const pushSubscriptionKeysSchema: Type<{ auth: string; p256dh: string }> = type({
  "+": "reject",
  auth: storableText(PUSH_SUBSCRIPTION_LIMITS.auth),
  p256dh: storableText(PUSH_SUBSCRIPTION_LIMITS.p256dh),
})
/** Value {@link pushSubscriptionKeysSchema} produces. */
export type PushSubscriptionKeys = typeof pushSubscriptionKeysSchema.infer

/**
 * A browser's `PushSubscription`, as `JSON.stringify`d by `PushSubscription.toJSON()`. The
 * endpoint must be an absolute `https:` URL.
 */
export const pushSubscriptionSchema: Type<{
  endpoint: string
  expirationTime: Default<number | null, null>
  keys: { auth: string; p256dh: string }
}> = type({
  "+": "reject",
  endpoint: endpointSchema,
  expirationTime: "number | null = null",
  keys: pushSubscriptionKeysSchema,
})
/** Value {@link pushSubscriptionSchema} produces. */
export type PushSubscriptionJson = typeof pushSubscriptionSchema.infer

/** Request body to register a device's push subscription. The device id must not be empty. */
export const pushSubscribeRequestSchema: Type<{
  deviceId: string
  subscription: {
    endpoint: string
    expirationTime: Default<number | null, null>
    keys: { auth: string; p256dh: string }
  }
}> = type({
  "+": "reject",
  deviceId: deviceIdSchema,
  subscription: pushSubscriptionSchema,
})
/** Value {@link pushSubscribeRequestSchema} produces. */
export type PushSubscribeRequest = typeof pushSubscribeRequestSchema.infer

/** Request body to drop a device's push subscription. */
export const pushUnsubscribeRequestSchema: Type<{ deviceId: string }> = type({
  "+": "reject",
  deviceId: deviceIdSchema,
})
/** Value {@link pushUnsubscribeRequestSchema} produces. */
export type PushUnsubscribeRequest = typeof pushUnsubscribeRequestSchema.infer

/**
 * A notification the server sends through a push subscription.
 *
 * `url` is where a click on the notification leads. `tag` names the notification: a later one with
 * the same tag replaces it instead of stacking, so the same reminder sent twice shows once. It is
 * an optional key rather than a nullable one with a default, so a message written before the field
 * existed still has this type.
 */
export const pushNotificationMessageSchema: Type<{
  title: string
  body: Default<string | null, null>
  url: Default<string | null, null>
  tag?: string
}> = type({
  "+": "reject",
  title: "1 <= string <= 120",
  body: "string <= 500 | null = null",
  url: "string <= 2048 | null = null",
  "tag?": "1 <= string <= 256",
})
/** Value {@link pushNotificationMessageSchema} produces. */
export type PushNotificationMessage = typeof pushNotificationMessageSchema.infer

/** Alias for {@link PushSubscriptionJson} used where the wire origin is not the point. */
export type PushSubscriptionData = PushSubscriptionJson
