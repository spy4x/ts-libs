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
 * **Every exported schema declares its type.** JSR refuses an exported constant whose type is only
 * inferred, so each schema in `model/` carries an explicit arktype `Type<…>` annotation. The
 * annotation spells out what arktype infers: `dateSchema` is `Type<Date | ((In: string) => Out<Date>)>`,
 * a pipe from a string to a `Date`, and a field with a default is `Default<T, V>`, imported from
 * `arktype/internal/attributes.ts` because arktype's main entry point does not export it.
 * `model/types.test.ts` fails to compile if `DateType`, `BaseModel`, a push type, or the input a
 * schema accepts changes.
 *
 * **The `"+": "reject"` decision splits by whether a schema is composed.** `model/base-model.ts`'s
 * three schemas declare it on none of them: an app is meant to `.and()` its own fields onto
 * `BaseModelSchema`, and arktype resolves `"+": "reject"` at intersection time by making every key
 * the left side does not already declare resolve to `never` on that side — declaring it there breaks
 * composition immediately, even inside `base-model.ts` itself (confirmed by constructing that
 * composition directly: `ParseError: Intersection at updatedAt of never and Date results in an
 * unsatisfiable type`). `model/push.ts`'s five wire schemas all declare it, at every object level
 * including the nested `keys`: none of them is ever composed further, they are the whole shape a
 * server receives from a browser it does not control, and nesting a `"+": "reject"` schema as another
 * object's _property_ (as `keys` sits inside `pushSubscriptionSchema`) does not carry the same hazard
 * as intersecting one in with `.and()` — confirmed the same way, by constructing it and reading the
 * result.
 *
 * The push subscription schemas refuse a field a database cannot store or a push service cannot use:
 * an empty device id, endpoint or key, a NUL or a lone surrogate in any of them, and an endpoint that
 * is not an absolute `https:` URL. Their length limits are exported as `PUSH_SUBSCRIPTION_LIMITS`
 * (`deviceId` 256, `endpoint` 2048, `auth` 256, `p256dh` 256 characters), so an app sizes its columns
 * from it instead of keeping its own copy.
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
  PUSH_SUBSCRIPTION_LIMITS,
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
