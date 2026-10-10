import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type PushNotificationMessage, pushNotificationMessageSchema } from "@spy4x/platform/model"
import { createReminderRunner } from "@spy4x/platform/server/reminder-runner"
import { type } from "arktype"
import { fakeClock, fakeTimers } from "../platform/server/_fake-fs.ts"
import type { PushDelivery, PushSendResult } from "./push.ts"
import {
  createReminderNotify,
  reminderDeliveryOutcome,
  reminderPushMessage,
} from "./push-reminders.ts"

const reminder = (summary: string, key = "task-1|2026-10-12T10:00:00.000Z") => ({ summary, key })

const delivery = (status: PushDelivery["status"], httpStatus?: number): PushDelivery => ({
  endpoint: "https://push.example.com/send/x",
  status,
  httpStatus,
  error: status === "failed" ? `HTTP ${httpStatus ?? "none"}` : "",
  deleted: status === "gone",
})

const result = (deliveries: PushDelivery[], success?: boolean): PushSendResult => ({
  success: success ?? deliveries.every((entry) => entry.status !== "failed"),
  output: "",
  error: deliveries.filter((entry) => entry.status === "failed").map((entry) => entry.error)
    .join("; "),
  deliveries,
})

/** A sender that records what it was asked to send and answers with `answer`. */
function fakeSender(answer: () => PushSendResult) {
  const sent: { userId: string | number; message: PushNotificationMessage; options: unknown }[] = []
  return {
    sent,
    send: (userId: string | number, message: PushNotificationMessage, options?: unknown) => {
      sent.push({ userId, message, options })
      return Promise.resolve(answer())
    },
  }
}

describe("reminder push message", () => {
  it("carries the task's title, the URL it was given and a tag", async () => {
    const message = await reminderPushMessage(reminder("Water the plants"), { url: "/tasks" })
    expect(message).toEqual({
      title: "Water the plants",
      body: null,
      url: "/tasks",
      tag: message.tag,
    })
    expect(message.tag).toMatch(/^[0-9a-f]{64}$/)
  })

  it("leaves the URL to the worker when none is given", async () => {
    expect((await reminderPushMessage(reminder("a"))).url).toBeNull()
  })

  it("gives the same reminder the same tag and another reminder another one", async () => {
    const first = await reminderPushMessage(reminder("a", "task-1|2026-10-12T10:00:00.000Z"))
    const again = await reminderPushMessage(reminder("renamed", "task-1|2026-10-12T10:00:00.000Z"))
    const other = await reminderPushMessage(reminder("a", "task-1|2026-10-12T10:05:00.000Z"))
    expect(again.tag).toBe(first.tag)
    expect(other.tag).not.toBe(first.tag)
  })

  it("keeps the tag at 64 characters for a key far longer than a tag may be", async () => {
    const message = await reminderPushMessage(reminder("a", `${"u".repeat(5000)}|2026`))
    expect(message.tag).toHaveLength(64)
    expect(pushNotificationMessageSchema(message) instanceof type.errors).toBe(false)
  })

  it("keeps a title of exactly 120 characters whole", async () => {
    const title = "a".repeat(120)
    expect((await reminderPushMessage(reminder(title))).title).toBe(title)
  })

  it("cuts a longer title to 120 characters ending in an ellipsis", async () => {
    const { title } = await reminderPushMessage(reminder("a".repeat(121)))
    expect(title).toBe(`${"a".repeat(119)}…`)
  })

  it("never cuts inside an emoji or between a letter and its accent", async () => {
    const family = "👨‍👩‍👧‍👦" // one character on screen, 11 code units
    const emoji = await reminderPushMessage(reminder(`${"a".repeat(115)}${family}${family}`))
    expect(emoji.title).toBe(`${"a".repeat(115)}…`)
    const accent = await reminderPushMessage(reminder(`${"a".repeat(118)}é${"b".repeat(9)}`))
    expect(accent.title).toBe(`${"a".repeat(118)}…`)
    expect(emoji.title.length).toBeLessThanOrEqual(120)
  })

  it("drops the space before the ellipsis", async () => {
    const { title } = await reminderPushMessage(reminder(`${"a".repeat(118)} ${"b".repeat(9)}`))
    expect(title).toBe(`${"a".repeat(118)}…`)
  })

  it("titles a task with no summary, or only spaces, Reminder or the text it was given", async () => {
    expect((await reminderPushMessage(reminder(""))).title).toBe("Reminder")
    expect((await reminderPushMessage(reminder("   "))).title).toBe("Reminder")
    expect((await reminderPushMessage(reminder(""), { untitled: "Erinnerung" })).title)
      .toBe("Erinnerung")
  })

  it("refuses a URL too long for a message", async () => {
    let thrown: unknown
    try {
      await reminderPushMessage(reminder("a"), { url: `/${"x".repeat(2048)}` })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
  })
})

describe("reminder delivery outcome", () => {
  const outcomes: [string, PushSendResult, "delivered" | "retry"][] = [
    ["every device got it", result([delivery("sent"), delivery("sent")]), "delivered"],
    [
      "one device got it and one failed with 503",
      result([delivery("sent"), delivery("failed", 503)]),
      "delivered",
    ],
    [
      "one device got it and one gave no answer",
      result([delivery("failed"), delivery("sent")]),
      "delivered",
    ],
    ["no device is subscribed", result([]), "delivered"],
    ["the only device was gone and removed", result([delivery("gone", 410)]), "delivered"],
    [
      "every device was refused for good (403, 400)",
      result([delivery("failed", 403), delivery("failed", 400)]),
      "delivered",
    ],
    ["the only device failed with 503", result([delivery("failed", 503)]), "retry"],
    ["the only device failed with 500", result([delivery("failed", 500)]), "retry"],
    ["the only device failed with 429", result([delivery("failed", 429)]), "retry"],
    ["the only device failed with 408", result([delivery("failed", 408)]), "retry"],
    ["the only device gave no answer", result([delivery("failed")]), "retry"],
    [
      "one was refused for good and one failed with 502",
      result([delivery("failed", 403), delivery("failed", 502)]),
      "retry",
    ],
    [
      "one was gone and one gave no answer",
      result([delivery("gone", 404), delivery("failed")]),
      "retry",
    ],
    ["the store could not be read", result([], false), "retry"],
  ]
  for (const [label, sendResult, expected] of outcomes) {
    it(`is ${expected} when ${label}`, () => {
      expect(reminderDeliveryOutcome(sendResult)).toBe(expected)
    })
  }
})

describe("reminder notify", () => {
  it("pushes the reminder's message to the user's devices with the push options", async () => {
    const sender = fakeSender(() => result([delivery("sent")]))
    const notify = createReminderNotify({ sender, userId: "owner", url: "/", push: { ttl: 600 } })
    expect(await notify(reminder("Water the plants"))).toBe("delivered")
    expect(sender.sent).toEqual([{
      userId: "owner",
      message: await reminderPushMessage(reminder("Water the plants"), { url: "/" }),
      options: { ttl: 600 },
    }])
  })

  it("answers delivered when one of two devices failed", async () => {
    const sender = fakeSender(() => result([delivery("sent"), delivery("failed", 503)]))
    const notify = createReminderNotify({ sender, userId: "owner" })
    expect(await notify(reminder("a"))).toBe("delivered")
  })

  it("rejects with the sender's error text when no device got it and one may get it later", async () => {
    const sender = fakeSender(() => result([delivery("failed", 503)]))
    const notify = createReminderNotify({ sender, userId: "owner" })
    let thrown: unknown
    try {
      await notify(reminder("a"))
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toBe("no device got the reminder: HTTP 503")
  })

  it("sends a task title of 300 characters instead of failing on it", async () => {
    const sender = fakeSender(() => result([delivery("sent")]))
    const notify = createReminderNotify({ sender, userId: "owner" })
    await notify(reminder("a".repeat(300), `${"u".repeat(300)}|2026`))
    expect(pushNotificationMessageSchema(sender.sent[0].message) instanceof type.errors).toBe(false)
  })

  it("refuses a URL too long for a message when it is built, before any reminder", () => {
    const sender = fakeSender(() => result([]))
    expect(() => createReminderNotify({ sender, userId: "owner", url: `/${"x".repeat(2048)}` }))
      .toThrow(RangeError)
    expect(sender.sent).toEqual([])
  })

  it("pushes a reminder once through a runner while one of two devices keeps failing", async () => {
    const sender = fakeSender(() => result([delivery("sent"), delivery("failed", 503)]))
    const clock = fakeClock(Date.parse("2026-10-12T09:59:30Z"))
    const errors: string[] = []
    let stored: unknown = null
    const runner = createReminderRunner({
      listTasks: () => [
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTODO\r\nUID:task-1\r\nSUMMARY:Water the plants\r\n" +
        "DUE:20261012T100000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER;RELATED=END:PT0S\r\n" +
        "END:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n",
      ],
      notify: createReminderNotify({ sender, userId: "owner", url: "/" }),
      state: {
        load: () => Promise.resolve(stored),
        save: (state) => {
          stored = state
          return Promise.resolve()
        },
      },
      zone: "UTC",
      onError: (error, step) => errors.push(`${step}: ${String(error)}`),
      clock,
      timers: fakeTimers(),
    })
    for (let tick = 0; tick < 70; tick++) {
      await runner.tick()
      clock.advance(60_000)
    }
    expect(sender.sent.map((entry) => entry.message.title)).toEqual(["Water the plants"])
    expect(errors).toEqual([])
  })
})
