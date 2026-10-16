import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { validate } from "@spy4x/validation"

import {
  PUSH_SUBSCRIPTION_LIMITS,
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

  it("accepts an endpoint of exactly 2048 characters and rejects 2049", () => {
    const base = { expirationTime: null, keys: { auth: "auth", p256dh: "p256dh" } }
    const prefix = "https://push.test/"
    const endpoint = (length: number) => prefix + "a".repeat(length - prefix.length)
    const ok = validate(pushSubscriptionSchema, { ...base, endpoint: endpoint(2048) })
    expect(ok.error).toBeNull()

    const tooLong = validate(pushSubscriptionSchema, { ...base, endpoint: endpoint(2049) })
    expect(tooLong.error).not.toBeNull()
  })

  it("accepts an endpoint as long as Edge on Windows issues, in a subscribe request too", () => {
    const endpoint = `https://wns2-par02p.notify.windows.com/w/?token=${"A".repeat(374)}`
    expect(endpoint).toHaveLength(422)
    const subscription = {
      endpoint,
      expirationTime: null,
      keys: { auth: "auth", p256dh: "p256dh" },
    }
    expect(validate(pushSubscriptionSchema, subscription).error).toBeNull()
    expect(validate(pushSubscribeRequestSchema, { deviceId: "d", subscription }).error).toBeNull()
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

  it("accepts a notification tag of 1 to 256 characters and leaves it out when none is given", () => {
    const ok = validate(pushNotificationMessageSchema, { title: "t", tag: "a".repeat(256) })
    expect(ok.error).toBeNull()
    expect(ok.data).toEqual({ title: "t", body: null, url: null, tag: "a".repeat(256) })

    const none = validate(pushNotificationMessageSchema, { title: "t" })
    expect(none.data).toEqual({ title: "t", body: null, url: null })

    for (const tag of ["", "a".repeat(257), null, 7]) {
      expect(validate(pushNotificationMessageSchema, { title: "t", tag }).error).not.toBeNull()
    }
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

describe("push schema: exported limits", () => {
  it("exports the limits the schemas enforce, so an app sizes its columns from them", () => {
    expect(PUSH_SUBSCRIPTION_LIMITS).toEqual({
      deviceId: 256,
      endpoint: 2048,
      auth: 256,
      p256dh: 256,
    })
    expect(Object.isFrozen(PUSH_SUBSCRIPTION_LIMITS)).toBe(true)
  })
})

/**
 * Every text field of a subscribe request ends up in a database row and is used to reach a push
 * service. A value Postgres cannot store must be a validation error, not a server error, and an
 * empty or non-https value must not be stored as a device that never receives anything.
 */
describe("push schema: refuses a field a database cannot store or a push service cannot use", () => {
  const valid = {
    deviceId: "device-1",
    subscription: {
      endpoint: "https://push.test/endpoint",
      expirationTime: null,
      keys: { auth: "auth", p256dh: "p256dh" },
    },
  }

  /** `valid` with one field replaced; `field` names it as `deviceId`, `endpoint`, `auth` or `p256dh`. */
  function withField(field: "deviceId" | "endpoint" | "auth" | "p256dh", value: string) {
    if (field === "deviceId") return { ...valid, deviceId: value }
    if (field === "endpoint") {
      return { ...valid, subscription: { ...valid.subscription, endpoint: value } }
    }
    return {
      ...valid,
      subscription: { ...valid.subscription, keys: { ...valid.subscription.keys, [field]: value } },
    }
  }

  const fields = ["deviceId", "endpoint", "auth", "p256dh"] as const

  it("still accepts a well-formed subscribe request", () => {
    expect(validate(pushSubscribeRequestSchema, valid).error).toBeNull()
  })

  it("refuses a NUL in any field", () => {
    for (const field of fields) {
      const value = field === "endpoint" ? "https://push.test/a\u0000b" : "a\u0000b"
      const result = validate(pushSubscribeRequestSchema, withField(field, value))
      expect(result.error, field).not.toBeNull()
    }
  })

  it("refuses a lone surrogate in any field", () => {
    for (const field of fields) {
      const value = field === "endpoint" ? "https://push.test/a\ud800" : "a\ud800"
      const result = validate(pushSubscribeRequestSchema, withField(field, value))
      expect(result.error, field).not.toBeNull()
    }
  })

  it("refuses an empty value in any field", () => {
    for (const field of fields) {
      const result = validate(pushSubscribeRequestSchema, withField(field, ""))
      expect(result.error, field).not.toBeNull()
    }
  })

  it("refuses an endpoint that is not a URL or not https", () => {
    for (
      const endpoint of [
        "not a url",
        "/relative/path",
        "http://push.test/endpoint",
        "ftp://push.test/x",
      ]
    ) {
      const result = validate(pushSubscribeRequestSchema, withField("endpoint", endpoint))
      expect(result.error, endpoint).not.toBeNull()
    }
  })

  it("refuses an empty or NUL device id on unsubscribe too", () => {
    for (const deviceId of ["", "a\u0000b"]) {
      expect(validate(pushUnsubscribeRequestSchema, { deviceId }).error).not.toBeNull()
    }
  })

  it("accepts an emoji, which is a whole surrogate pair, in a device id", () => {
    expect(validate(pushSubscribeRequestSchema, withField("deviceId", "phone \u{1F4F1}")).error)
      .toBeNull()
  })
})
