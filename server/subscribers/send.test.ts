import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { renderLetter, UNSUBSCRIBE_PLACEHOLDER } from "@spy4x/email/letter"
import type { EmailMessage } from "@spy4x/email/message"
import type { EmailSender, SendResult } from "@spy4x/email/sender"
import { createSubscriptionCrypto } from "./crypto.ts"
import { createMemorySendLog } from "./memory-send-log.ts"
import { createMemorySubscriberStore } from "./memory.ts"
import { sendIssue, type SendIssueInput } from "./send.ts"
import type { SendLog } from "./send-log.ts"
import type { Subscriber } from "./store.ts"

const SECRET = "fixture-secret-not-a-real-one-0123456789"
const NEW_SECRET = "rotated-fixture-secret-not-real-9876543210"
const NOW = Date.UTC(2001, 0, 1)
const letter = renderLetter({
  blocks: [{ html: "<p>Hello</p>", text: "Hello" }],
  footer: { reason: "You subscribed.", unsubscribeLink: UNSUBSCRIBE_PLACEHOLDER },
})

const accepted = (to: string): SendResult => ({
  ok: true,
  accepted: [to],
  duplicates: [],
})
const refused = (error: string): SendResult => ({
  ok: false,
  error,
  accepted: [],
  rejected: [],
  duplicates: [],
})

/** A sender that records every message and answers by `behave(to)`. */
function fakeSender(behave: (to: string) => SendResult = accepted) {
  const messages: EmailMessage[] = []
  const sender: EmailSender = {
    send(message) {
      messages.push(message)
      return Promise.resolve(behave(message.to as string))
    },
  }
  return { sender, messages, recipients: () => messages.map((m) => m.to) }
}

async function row(email: string, secret = SECRET): Promise<Subscriber> {
  const key = await createSubscriptionCrypto({ secret }).subscriberKey(email)
  return { email, key, subscribedAt: new Date(NOW) }
}

const ONE = "one@example.com"
const TWO = "two@example.com"
const THREE = "three@example.com"

/** Everything the log and the console would show of one test. */
function setup(overrides: Partial<SendIssueInput> = {}) {
  const lines: unknown[][] = []
  const sink = {
    info: (...a: unknown[]) => lines.push(a),
    error: (...a: unknown[]) => lines.push(a),
  }
  const log = createMemorySendLog()
  const input = async (
    subscribers: readonly Subscriber[],
    extra: Partial<SendIssueInput> = {},
  ): Promise<SendIssueInput> => ({
    issue: "a-post",
    subject: "A post",
    letter,
    subscribers,
    crypto: createSubscriptionCrypto({ secret: SECRET }),
    unsubscribeLink: (token) => `https://example.com/u?t=${token}`,
    sender: fakeSender().sender,
    log: sink,
    now: () => NOW,
    ...overrides,
    ...extra,
  })
  return { log, lines, input }
}

describe("sendIssue", () => {
  it("mails every subscriber their own unsubscribe link, in the body and the one-click header", async () => {
    const { log, input } = setup()
    const relay = fakeSender()
    const subscribers = [await row(ONE), await row(TWO)]
    const result = await sendIssue(await input(subscribers, { sender: relay.sender }), log)
    expect(result).toEqual({ status: "sent", sent: 2, failed: 0, skipped: 0 })
    const crypto = createSubscriptionCrypto({ secret: SECRET })
    for (const [i, sub] of subscribers.entries()) {
      const link = `https://example.com/u?t=${await crypto.unsubscribeToken(sub.email, sub.key)}`
      const message = relay.messages[i]
      expect(message.to).toBe(sub.email)
      expect(message.subject).toBe("A post")
      expect(message.html).toContain(link)
      expect(message.text).toContain(link)
      expect(message.listUnsubscribe).toEqual({ url: link, oneClick: true })
      expect(message.html).not.toContain(UNSUBSCRIBE_PLACEHOLDER)
    }
    expect(relay.messages[0].html).not.toBe(relay.messages[1].html)
  })

  it("mails only the missed recipients on a rerun after a partial failure, then closes the issue", async () => {
    const { log, input } = setup()
    const subscribers = [await row(ONE), await row(TWO), await row(THREE)]
    const failing = fakeSender((to) => to === TWO ? refused("550 mailbox full") : accepted(to))
    expect(await sendIssue(await input(subscribers, { sender: failing.sender }), log)).toEqual({
      status: "sent",
      sent: 2,
      failed: 1,
      skipped: 0,
    })
    expect((await log.find("a-post"))?.completedAt).toBeUndefined()

    const rerun = fakeSender()
    expect(await sendIssue(await input(subscribers, { sender: rerun.sender }), log)).toEqual({
      status: "sent",
      sent: 1,
      failed: 0,
      skipped: 2,
    })
    expect(rerun.recipients()).toEqual([TWO])
    expect((await log.find("a-post"))?.completedAt).toEqual(new Date(NOW))
  })

  it("mails nobody on a repeated run after a clean one", async () => {
    const { log, input } = setup()
    const subscribers = [await row(ONE), await row(TWO)]
    await sendIssue(await input(subscribers), log)
    const again = fakeSender()
    const result = await sendIssue(await input(subscribers, { sender: again.sender }), log)
    expect(result.status).toBe("already-sent")
    expect(again.messages).toEqual([])
  })

  it("never mails a subscriber who joined after the first run started", async () => {
    const { log, input } = setup()
    const first = [await row(ONE), await row(TWO)]
    const failing = fakeSender((to) => to === TWO ? refused("550 mailbox full") : accepted(to))
    await sendIssue(await input(first, { sender: failing.sender }), log)
    const rerun = fakeSender()
    const result = await sendIssue(
      await input([...first, await row(THREE)], { sender: rerun.sender }),
      log,
    )
    expect(result).toEqual({ status: "sent", sent: 1, failed: 0, skipped: 2 })
    expect(rerun.recipients()).toEqual([TWO])
  })

  it("does not record a recipient whose mail the relay refused or whose send threw", async () => {
    const { log, input } = setup()
    const flaky = fakeSender((to) => {
      if (to === TWO) throw new Error("socket closed")
      return to === ONE ? refused("451 try later") : accepted(to)
    })
    const result = await sendIssue(
      await input([await row(ONE), await row(TWO), await row(THREE)], { sender: flaky.sender }),
      log,
    )
    expect(result).toEqual({ status: "sent", sent: 1, failed: 2, skipped: 0 })
    const entry = await log.find("a-post")
    const marks = await createSubscriptionCrypto({ secret: SECRET }).sentMarks(THREE, "a-post")
    expect(entry?.recipients).toEqual(marks)
    expect(entry?.failed).toBe(2)
  })

  it("answers in-progress and mails nobody while another run holds the send lock", async () => {
    const { log, input } = setup()
    const held = await log.lock("a-post")
    const relay = fakeSender()
    const result = await sendIssue(await input([await row(ONE)], { sender: relay.sender }), log)
    expect(result).toEqual({ status: "in-progress" })
    expect(relay.messages).toEqual([])
    expect(await log.find("a-post")).toBeUndefined()
    await held?.release()
    expect((await sendIssue(await input([await row(ONE)]), log)).status).toBe("sent")
  })

  it("holds the lock for the whole run, so two overlapping runs mail each person once", async () => {
    const { log, input } = setup()
    const subscribers = [await row(ONE), await row(TWO)]
    const relay = fakeSender()
    const slow: EmailSender = {
      async send(message) {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return relay.sender.send(message)
      },
    }
    const results = await Promise.all([
      sendIssue(await input(subscribers, { sender: slow }), log),
      sendIssue(await input(subscribers, { sender: slow }), log),
    ])
    expect(results.map((r) => r.status).toSorted()).toEqual(["in-progress", "sent"])
    expect(relay.recipients()).toEqual([ONE, TWO])
  })

  it("frees the send lock when the run throws", async () => {
    const { log, input } = setup()
    const broken: SendLog = {
      ...log,
      record: () => Promise.reject(new Error("disk full")),
    }
    await expect(sendIssue(await input([await row(ONE)]), broken)).rejects.toThrow("disk full")
    const lock = await log.lock("a-post")
    expect(lock).toBeDefined()
  })

  it("stops the run when a mark cannot be recorded, instead of counting a failed mail", async () => {
    const { log, input } = setup()
    const relay = fakeSender()
    const broken: SendLog = { ...log, record: () => Promise.reject(new Error("disk full")) }
    await expect(
      sendIssue(await input([await row(ONE), await row(TWO)], { sender: relay.sender }), broken),
    ).rejects.toThrow("disk full")
    expect(relay.recipients()).toEqual([ONE])
  })

  it("does not mail again someone reached before a secret rotation, and mails the one missed", async () => {
    const { log, input } = setup()
    const subscribers = [await row(ONE), await row(TWO)]
    const failing = fakeSender((to) => to === TWO ? refused("550 mailbox full") : accepted(to))
    await sendIssue(await input(subscribers, { sender: failing.sender }), log)

    const rotated = createSubscriptionCrypto({ secret: NEW_SECRET, previousSecrets: [SECRET] })
    const rerun = fakeSender()
    const result = await sendIssue(
      await input(subscribers, { sender: rerun.sender, crypto: rotated }),
      log,
    )
    expect(result).toEqual({ status: "sent", sent: 1, failed: 0, skipped: 1 })
    expect(rerun.recipients()).toEqual([TWO])
    // The new recipient is recorded under the new secret, the earlier one stays as it was.
    const entry = await log.find("a-post")
    const [current] = await rotated.sentMarks(TWO, "a-post")
    expect(entry?.recipients).toContain(current)
    expect(entry?.recipients).toHaveLength(2)
  })

  it("mails nobody on a repeat after a rotation when the issue was already closed", async () => {
    const { log, input } = setup()
    const subscribers = [await row(ONE)]
    await sendIssue(await input(subscribers), log)
    const rotated = createSubscriptionCrypto({ secret: NEW_SECRET, previousSecrets: [SECRET] })
    const again = fakeSender()
    const result = await sendIssue(
      await input(subscribers, { sender: again.sender, crypto: rotated }),
      log,
    )
    expect(result.status).toBe("already-sent")
    expect(again.messages).toEqual([])
  })

  it("keeps the audience across a rotation, so a subscriber who joined meanwhile is still left out", async () => {
    const { log, input } = setup()
    const failing = fakeSender((to) => to === TWO ? refused("550") : accepted(to))
    await sendIssue(await input([await row(ONE), await row(TWO)], { sender: failing.sender }), log)
    const rotated = createSubscriptionCrypto({ secret: NEW_SECRET, previousSecrets: [SECRET] })
    const rerun = fakeSender()
    await sendIssue(
      await input([await row(ONE), await row(TWO), await row(THREE, NEW_SECRET)], {
        sender: rerun.sender,
        crypto: rotated,
      }),
      log,
    )
    expect(rerun.recipients()).toEqual([TWO])
  })

  it("mints a link that still finds a row added before a rotation", async () => {
    const { log, input } = setup()
    const old = await row(ONE)
    const rotated = createSubscriptionCrypto({ secret: NEW_SECRET, previousSecrets: [SECRET] })
    const relay = fakeSender()
    await sendIssue(
      await input([old], {
        sender: relay.sender,
        crypto: rotated,
      }),
      log,
    )
    const store = createMemorySubscriberStore()
    await store.add({
      email: ONE,
      key: old.key!,
      mark: "m",
      issuedAt: NOW,
      at: new Date(NOW),
    })
    const token = new URL(relay.messages[0].listUnsubscribe!.url).searchParams.get("t")!
    expect((await rotated.verifyUnsubscribeToken(token, store))?.email).toBe(ONE)
  })

  it("writes no address to the log lines, the relay error in any letter case, or the send log", async () => {
    const { log, lines, input } = setup()
    const subscribers: Subscriber[] = [
      await row(ONE),
      await row(TWO),
      await row(THREE),
      { email: "Jane Doe <jane@example.com>", subscribedAt: new Date(NOW) },
    ]
    const relay = fakeSender((to) => {
      if (to === TWO) return refused(`550 5.1.1 <${TWO.toUpperCase()}> unknown user`)
      if (to === THREE) throw new Error(`connection reset while sending to ${THREE}`)
      return accepted(to)
    })
    const result = await sendIssue(await input(subscribers, { sender: relay.sender }), log)
    expect(result).toEqual({ status: "sent", sent: 1, failed: 3, skipped: 0 })
    const everything = JSON.stringify([lines, await log.find("a-post")])
    expect(lines.length).toBeGreaterThanOrEqual(4)
    expect(everything.toLowerCase()).not.toContain("example.com")
    expect(everything).toContain("row 2")
    expect(everything).toContain("<REDACTED:EMAIL>")
  })

  it("counts a row that is not a bare address as failed and never mails it", async () => {
    const { log, input } = setup()
    const relay = fakeSender()
    const result = await sendIssue(
      await input(
        [
          await row(ONE),
          { email: "Jane Doe <jane@example.com>", subscribedAt: new Date(NOW) },
        ],
        { sender: relay.sender },
      ),
      log,
    )
    expect(result).toEqual({ status: "sent", sent: 1, failed: 1, skipped: 0 })
    expect(relay.recipients()).toEqual([ONE])
    expect((await log.find("a-post"))?.completedAt).toBeUndefined()
  })

  it("refuses an empty list and records nothing, so the real send can still happen", async () => {
    const { log, input } = setup()
    expect(await sendIssue(await input([]), log)).toEqual({ status: "no-subscribers" })
    expect(await log.find("a-post")).toBeUndefined()
  })

  it("refuses an issue that has a legacy entry with no recipient list", async () => {
    const { log, input } = setup()
    const relay = fakeSender()
    const legacy: SendLog = {
      ...log,
      find: () => Promise.resolve({ issue: "a-post", subject: "Old", startedAt: new Date(NOW) }),
    }
    const result = await sendIssue(await input([await row(ONE)], { sender: relay.sender }), legacy)
    expect(result.status).toBe("already-sent")
    expect(relay.messages).toEqual([])
  })
})
