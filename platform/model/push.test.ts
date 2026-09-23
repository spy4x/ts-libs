import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { validate } from "@spy4x/validation"

import {
  pushNotificationMessageSchema,
  pushSubscribeRequestSchema,
  pushSubscriptionKeysSchema,
  pushSubscriptionSchema,
  pushUnsubscribeRequestSchema,
} from "./push.ts"

// Ported from `template/libs/platform/types/push-schema.test.ts`. `validate` comes from
// `@spy4x/validation` instead of the template's own copy (out of scope for this move, see the
// PR body), and every input keeps its original shape.

describe("push schema: subscribe", () => {
  it("accepts subscribe", () => {
    const result = validate(pushSubscribeRequestSchema, {
      deviceId: "device-1",
      subscription: {
        endpoint: "https://push.test/endpoint",
        expirationTime: null,
        keys: { auth: "auth", p256dh: "p256dh" },
      },
    })
    expect(result.error).toBeNull()
  })

  it("rejects subscribe without keys", () => {
    const result = validate(pushSubscribeRequestSchema, {
      deviceId: "device-2",
      subscription: {
        endpoint: "https://push.test/endpoint",
        expirationTime: null,
        keys: { auth: "" },
      },
    })
    expect(result.error).not.toBeNull()
  })

  it("accepts unsubscribe", () => {
    const result = validate(pushUnsubscribeRequestSchema, { deviceId: "device-3" })
    expect(result.error).toBeNull()
  })
})

/**
 * Pins the `"+": "reject"` decision recorded in `push.ts`: every wire schema in this file rejects
 * an unrecognised key, at every object level including the nested `keys`, because none of them is
 * ever composed with `.and()` the way the base model schemas are.
 */
describe('push schema: "+": "reject" pins an unrecognised key at every level', () => {
  it("rejects an extra top-level field on the subscribe request", () => {
    const result = validate(pushSubscribeRequestSchema, {
      deviceId: "device-1",
      subscription: {
        endpoint: "https://push.test/endpoint",
        expirationTime: null,
        keys: { auth: "auth", p256dh: "p256dh" },
      },
      extra: "unexpected",
    })
    expect(result.error).not.toBeNull()
  })

  it("rejects an extra field on the subscription object", () => {
    const result = validate(pushSubscriptionSchema, {
      endpoint: "https://push.test/endpoint",
      expirationTime: null,
      keys: { auth: "auth", p256dh: "p256dh" },
      extra: "unexpected",
    })
    expect(result.error).not.toBeNull()
  })

  it("rejects an extra field on the nested keys object", () => {
    const result = validate(pushSubscriptionKeysSchema, {
      auth: "auth",
      p256dh: "p256dh",
      extra: "unexpected",
    })
    expect(result.error).not.toBeNull()
  })

  it("rejects an extra field on the unsubscribe request", () => {
    const result = validate(pushUnsubscribeRequestSchema, {
      deviceId: "device-3",
      extra: "unexpected",
    })
    expect(result.error).not.toBeNull()
  })

  it("rejects an extra field on the notification message", () => {
    const result = validate(pushNotificationMessageSchema, {
      title: "Hello",
      extra: "unexpected",
    })
    expect(result.error).not.toBeNull()
  })
})

describe("push schema: length limits", () => {
  it("accepts a deviceId of exactly 256 characters and rejects 257", () => {
    const ok = validate(pushUnsubscribeRequestSchema, { deviceId: "a".repeat(256) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushUnsubscribeRequestSchema, { deviceId: "a".repeat(257) })
    expect(tooLong.error).not.toBeNull()
  })

  it("accepts an endpoint of exactly 256 characters and rejects 257", () => {
    const base = { expirationTime: null, keys: { auth: "auth", p256dh: "p256dh" } }
    const ok = validate(pushSubscriptionSchema, { ...base, endpoint: "a".repeat(256) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushSubscriptionSchema, { ...base, endpoint: "a".repeat(257) })
    expect(tooLong.error).not.toBeNull()
  })

  it("accepts auth/p256dh of exactly 256 characters and rejects 257", () => {
    const ok = validate(pushSubscriptionKeysSchema, {
      auth: "a".repeat(256),
      p256dh: "a".repeat(256),
    })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushSubscriptionKeysSchema, {
      auth: "a".repeat(257),
      p256dh: "a".repeat(256),
    })
    expect(tooLong.error).not.toBeNull()
  })

  it("rejects a notification title that is empty or over 120 characters, accepts 120", () => {
    const empty = validate(pushNotificationMessageSchema, { title: "" })
    expect(empty.error).not.toBeNull()

    const ok = validate(pushNotificationMessageSchema, { title: "a".repeat(120) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushNotificationMessageSchema, { title: "a".repeat(121) })
    expect(tooLong.error).not.toBeNull()
  })

  it("accepts a notification body of exactly 500 characters and rejects 501, and accepts null", () => {
    const withNull = validate(pushNotificationMessageSchema, { title: "t", body: null })
    expect(withNull.error).toBeNull()

    const ok = validate(pushNotificationMessageSchema, { title: "t", body: "a".repeat(500) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushNotificationMessageSchema, { title: "t", body: "a".repeat(501) })
    expect(tooLong.error).not.toBeNull()
  })

  it("accepts a notification url of exactly 2048 characters and rejects 2049, and accepts null", () => {
    const withNull = validate(pushNotificationMessageSchema, { title: "t", url: null })
    expect(withNull.error).toBeNull()

    const ok = validate(pushNotificationMessageSchema, { title: "t", url: "a".repeat(2048) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushNotificationMessageSchema, { title: "t", url: "a".repeat(2049) })
    expect(tooLong.error).not.toBeNull()
  })
})
