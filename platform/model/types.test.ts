/**
 * Type-level pins for the explicit `Type<…>` annotations on the exported schemas (#141). JSR
 * requires every exported constant to declare its type, so each schema now spells out the type
 * arktype used to infer. These assertions fail to compile if an annotation changes what a consumer
 * sees: the value type a schema produces (`.infer`) and the input it accepts (`.inferIn`).
 */
import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  type BaseModel,
  BaseModelSchema,
  DateNullableSchema,
  dateSchema,
  type DateType,
  ImmutableBaseModelSchema,
  type PushNotificationMessage,
  pushNotificationMessageSchema,
  type PushSubscribeRequest,
  pushSubscribeRequestSchema,
  type PushSubscriptionData,
  type PushSubscriptionJson,
  type PushSubscriptionKeys,
  pushSubscriptionSchema,
  type PushUnsubscribeRequest,
  UndeletableBaseModelSchema,
} from "./mod.ts"

/** `true` only when `A` and `B` are the same type, not merely assignable one way. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true
  : false

/** Compiles only when its argument is `true`. */
function assertType<T extends true>(): T | undefined {
  return undefined
}

describe("platform/model exported types", () => {
  it("DateType is a Date, and dateSchema takes a Date or a string", () => {
    assertType<Equal<DateType, Date>>()
    assertType<Equal<typeof dateSchema.inferIn, Date | string>>()
    assertType<Equal<typeof DateNullableSchema[0]["infer"], Date | null>>()
    expect(DateNullableSchema[1]).toBe("=")
  })

  it("the base model tiers produce id, createdAt, updatedAt and a nullable deletedAt", () => {
    assertType<Equal<typeof ImmutableBaseModelSchema.infer, { id: number; createdAt: Date }>>()
    assertType<
      Equal<typeof UndeletableBaseModelSchema.infer, {
        id: number
        createdAt: Date
        updatedAt: Date
      }>
    >()
    assertType<
      Equal<BaseModel, { id: number; createdAt: Date; updatedAt: Date; deletedAt: Date | null }>
    >()
  })

  it("BaseModelSchema still takes deletedAt as optional input", () => {
    assertType<
      Equal<typeof BaseModelSchema.inferIn, {
        id: number
        createdAt: Date | string
        updatedAt: Date | string
        deletedAt?: Date | string | null
      }>
    >()
  })

  it("the push types keep their fields and nullable defaults", () => {
    assertType<Equal<PushSubscriptionKeys, { auth: string; p256dh: string }>>()
    assertType<
      Equal<PushSubscriptionJson, {
        endpoint: string
        expirationTime: number | null
        keys: { auth: string; p256dh: string }
      }>
    >()
    assertType<Equal<PushSubscriptionData, PushSubscriptionJson>>()
    assertType<
      Equal<PushSubscribeRequest, {
        deviceId: string
        subscription: {
          endpoint: string
          expirationTime: number | null
          keys: { auth: string; p256dh: string }
        }
      }>
    >()
    assertType<Equal<PushUnsubscribeRequest, { deviceId: string }>>()
    assertType<
      Equal<PushNotificationMessage, { title: string; body: string | null; url: string | null }>
    >()
  })

  it("the push schemas still take their defaulted fields as optional input", () => {
    assertType<
      Equal<typeof pushSubscriptionSchema.inferIn, {
        endpoint: string
        expirationTime?: number | null
        keys: { auth: string; p256dh: string }
      }>
    >()
    assertType<
      Equal<typeof pushSubscribeRequestSchema.inferIn["subscription"], {
        endpoint: string
        expirationTime?: number | null
        keys: { auth: string; p256dh: string }
      }>
    >()
    assertType<
      Equal<typeof pushNotificationMessageSchema.inferIn, {
        title: string
        body?: string | null
        url?: string | null
      }>
    >()
  })
})
