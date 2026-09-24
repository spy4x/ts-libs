/**
 * `@spy4x/platform/model` — arktype schemas for the shapes shared across products: dates, the
 * base persisted-record schema, and the Web Push wire format.
 *
 * - {@link dateSchema} / {@link DateNullableSchema} — a field that accepts a `Date` or an ISO 8601
 *   string.
 * - {@link ImmutableBaseModelSchema} / {@link UndeletableBaseModelSchema} / {@link BaseModelSchema}
 *   — the `id`/`createdAt`/`updatedAt`/`deletedAt` tiers an app's own model schemas `.and()` onto.
 * - {@link pushSubscriptionSchema} and friends — what a browser's `PushSubscription` serialises to,
 *   and the subscribe/unsubscribe requests a server accepts for it.
 *
 * See `base-model.ts` and `push.ts` for which of these declare `"+": "reject"` and why.
 *
 * @module
 */

export { DateNullableSchema, dateSchema, type DateType } from "./date.ts"

export {
  type BaseModel,
  BaseModelSchema,
  ImmutableBaseModelSchema,
  UndeletableBaseModelSchema,
} from "./base-model.ts"

export {
  type PushNotificationMessage,
  pushNotificationMessageSchema,
  type PushSubscribeRequest,
  pushSubscribeRequestSchema,
  type PushSubscriptionData,
  type PushSubscriptionJson,
  type PushSubscriptionKeys,
  pushSubscriptionKeysSchema,
  pushSubscriptionSchema,
  type PushUnsubscribeRequest,
  pushUnsubscribeRequestSchema,
} from "./push.ts"
