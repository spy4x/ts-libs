import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import { type } from "arktype"
import type { Sql } from "./ports.ts"
import {
  announceJson,
  listenJson,
  MAX_NOTIFY_CHANNEL_BYTES,
  MAX_NOTIFY_PAYLOAD_BYTES,
  NotifyPayloadTooLargeError,
} from "./notify.ts"

/** A client that records each query's values and lets the test play the server's side of `listen`. */
function fakeSql() {
  const sent: unknown[][] = []
  const listened: string[] = []
  let unlistened = 0
  let handler: (payload: string) => void = () => {}
  let relisten: () => void = () => {}
  const tag = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    sent.push(values)
    return Promise.resolve([])
  }
  const listen = (channel: string, fn: (payload: string) => void, onlisten?: () => void) => {
    listened.push(channel)
    handler = fn
    relisten = () => onlisten?.()
    onlisten?.()
    return Promise.resolve({ unlisten: () => Promise.resolve(void unlistened++) })
  }
  return {
    sql: Object.assign(tag, { listen }) as unknown as Sql,
    sent,
    listened,
    unlistened: () => unlistened,
    notify: (payload: string) => handler(payload),
    reconnect: () => relisten(),
  }
}

const inboxChange = type({ userId: "number.integer > 0", "+": "reject" })

Deno.test("announces the payload as JSON text on the channel", async () => {
  const db = fakeSql()

  await announceJson(db.sql, "inbox_changed", { userId: 7, tags: ["a"] })

  assertEquals(db.sent, [["inbox_changed", `{"userId":7,"tags":["a"]}`]])
})

Deno.test("sends a payload of exactly the limit and refuses one byte more without sending", async () => {
  const db = fakeSql()
  // Two bytes for the quotes of the JSON string.
  const atLimit = "a".repeat(MAX_NOTIFY_PAYLOAD_BYTES - 2)

  await announceJson(db.sql, "c", atLimit)
  const error = await assertRejects(
    () => announceJson(db.sql, "c", `${atLimit}a`),
    NotifyPayloadTooLargeError,
  )

  assertEquals(db.sent.length, 1)
  assertEquals(error.bytes, MAX_NOTIFY_PAYLOAD_BYTES + 1)
  assertEquals(error.channel, "c")
  assertStrictEquals(error instanceof RangeError, true)
})

Deno.test("measures the payload in bytes, not characters", async () => {
  const db = fakeSql()
  // 4000 characters of two bytes each: under the limit in characters, over it in bytes.
  const error = await assertRejects(
    () => announceJson(db.sql, "c", "é".repeat(4000)),
    NotifyPayloadTooLargeError,
  )

  assertEquals(error.bytes, 8002)
  assertEquals(db.sent, [])
})

Deno.test("refuses a payload with no JSON form without sending", async () => {
  const db = fakeSql()

  await assertRejects(() => announceJson(db.sql, "c", undefined), TypeError, "no JSON form")
  await assertRejects(() => announceJson(db.sql, "c", () => 1), TypeError, "no JSON form")
  await assertRejects(() => announceJson(db.sql, "c", 1n), TypeError)

  assertEquals(db.sent, [])
})

Deno.test("refuses a channel name Postgres would cut short or reject, to announce and to listen", async () => {
  const db = fakeSql()
  const longest = "c".repeat(MAX_NOTIFY_CHANNEL_BYTES)
  const options = { schema: inboxChange, onMessage: () => {} }

  await announceJson(db.sql, longest, 1)
  await listenJson(db.sql, longest, options)
  for (const channel of ["", `${longest}c`, "é".repeat(32), "a\0b"]) {
    await assertRejects(() => announceJson(db.sql, channel, 1), RangeError, "channel name")
    await assertRejects(() => listenJson(db.sql, channel, options), RangeError, "channel name")
  }

  assertEquals(db.sent.length, 1)
  assertEquals(db.listened, [longest])
})

Deno.test("hands the handler the schema's output for each payload it accepts", async () => {
  const db = fakeSql()
  const heard: unknown[] = []

  await listenJson(db.sql, "inbox_changed", {
    // The schema turns the text into a `Date`, so its output differs from the parsed JSON.
    schema: type({ userId: "number.integer > 0", at: "string.date.iso.parse" }),
    onMessage: (message) => void heard.push(message),
  })
  db.notify(`{"userId":7,"at":"2026-01-02T03:04:05.000Z"}`)
  db.notify(`{"userId":8,"at":"2026-01-02T03:04:06.000Z"}`)

  assertEquals(db.listened, ["inbox_changed"])
  assertEquals(heard, [
    { userId: 7, at: new Date("2026-01-02T03:04:05.000Z") },
    { userId: 8, at: new Date("2026-01-02T03:04:06.000Z") },
  ])
})

Deno.test("drops a payload that is not JSON or that the schema refuses", async () => {
  const db = fakeSql()
  const heard: unknown[] = []
  const errors: unknown[] = []

  await listenJson(db.sql, "inbox_changed", {
    schema: inboxChange,
    onMessage: (message) => void heard.push(message),
    onError: (error) => void errors.push(error),
  })
  for (
    const payload of [
      "",
      "{userId:7}",
      "null",
      `{"userId":"7"}`,
      `{"userId":0}`,
      `{"userId":7,"admin":true}`,
    ]
  ) {
    db.notify(payload)
  }

  assertEquals(heard, [])
  assertEquals(errors, [])
})

Deno.test("reports a handler that throws or rejects and keeps listening", async () => {
  const db = fakeSql()
  const errors: unknown[] = []
  const heard: number[] = []
  const thrown = new Error("sync")
  const rejected = new Error("async")

  await listenJson(db.sql, "inbox_changed", {
    schema: inboxChange,
    onMessage: ({ userId }) => {
      if (userId === 1) throw thrown
      if (userId === 2) return Promise.reject(rejected)
      heard.push(userId)
    },
    onError: (error) => void errors.push(error),
  })
  db.notify(`{"userId":1}`)
  db.notify(`{"userId":2}`)
  db.notify(`{"userId":3}`)
  await Promise.resolve()

  assertEquals(errors, [thrown, rejected])
  assertEquals(heard, [3])
})

Deno.test("tells onListen at the first subscription and after each reconnect", async () => {
  const db = fakeSql()
  let subscribed = 0

  await listenJson(db.sql, "inbox_changed", {
    schema: inboxChange,
    onMessage: () => {},
    onListen: () => void subscribed++,
  })
  assertEquals(subscribed, 1)
  db.reconnect()

  assertEquals(subscribed, 2)
})

Deno.test("after stop it unsubscribes and calls nothing, even if the client still delivers", async () => {
  const db = fakeSql()
  const heard: unknown[] = []
  let subscribed = 0

  const stop = await listenJson(db.sql, "inbox_changed", {
    schema: inboxChange,
    onMessage: (message) => void heard.push(message),
    onListen: () => void subscribed++,
  })
  await stop()
  db.notify(`{"userId":7}`)
  db.reconnect()

  assertEquals(db.unlistened(), 1)
  assertEquals(heard, [])
  assertEquals(subscribed, 1)
})

Deno.test("reports a schema that throws and keeps listening", async () => {
  const db = fakeSql()
  const heard: unknown[] = []
  const errors: unknown[] = []
  const failure = new Error("morph failed")
  await listenJson(db.sql, "inbox_changed", {
    schema: type({ userId: "number" }).pipe((value) => {
      if (value.userId === 13) throw failure
      return value
    }),
    onMessage: (message) => void heard.push(message),
    onError: (error) => void errors.push(error),
  })
  db.notify(`{"userId":13}`)
  db.notify(`{"userId":1}`)

  assertEquals(errors, [failure])
  assertEquals(heard, [{ userId: 1 }])
})
