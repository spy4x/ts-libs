import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createMemoryRateLimiter } from "@spy4x/platform/rate-limit/memory"
import { CONFIRM_TTL_MS, createSubscriptionCrypto } from "./crypto.ts"
import {
  confirmSubscription,
  type FlowDeps,
  type MailOutcome,
  previewConfirmation,
  previewUnsubscribe,
  requestSubscription,
  type SubscriberMail,
  unsubscribe,
} from "./flows.ts"
import { createMemorySubscriberStore } from "./memory.ts"
import type { SubscriberStore } from "./store.ts"

const SECRET = "fixture-secret-not-a-real-one-0123456789"
/** antonshubin.com's version 1 unsubscribe link for jane@example.com under SECRET (see
 * `crypto.test.ts`). */
const SITE_UNSUBSCRIBE_TOKEN =
  "eyJwdXJwb3NlIjoidW5zdWJzY3JpYmUiLCJ2ZXJzaW9uIjoxLCJwYXlsb2FkIjp7fX0.ykHC53_rs7XXy79oIQoSxzg9BpwrwHenQyROeLMIGJI"
const NOW = Date.UTC(2001, 0, 1)
const JANE = "jane@example.com"

/** Flow deps over a memory store and a clock the test moves, recording every mail and log call. */
function harness(options: {
  sendMail?: (mail: SubscriberMail) => Promise<MailOutcome>
  store?: SubscriberStore
  limits?: FlowDeps["limits"]
} = {}) {
  const clock = { at: NOW }
  const mails: SubscriberMail[] = []
  const logs: unknown[][] = []
  const store = options.store ?? createMemorySubscriberStore()
  const deps: FlowDeps = {
    crypto: createSubscriptionCrypto({ secret: SECRET, now: () => clock.at }),
    store,
    links: {
      confirm: (token) => `https://example.com/confirm?token=${encodeURIComponent(token)}`,
      unsubscribe: (token) => `https://example.com/unsubscribe?token=${encodeURIComponent(token)}`,
    },
    sendMail: (mail) => {
      mails.push(mail)
      return options.sendMail ? options.sendMail(mail) : Promise.resolve()
    },
    log: {
      error: (...args) => logs.push(["error", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
    },
    limits: options.limits,
    now: () => clock.at,
  }
  return { deps, clock, mails, logs, store }
}

/** The token inside a link the flows built. */
function tokenOf(link: string): string {
  return new URL(link).searchParams.get("token") ?? ""
}

/** Requests a subscription for `email` and returns the confirm token mailed for it. */
async function confirmTokenFor(deps: FlowDeps, mails: SubscriberMail[], email = JANE) {
  const outcome = await requestSubscription(email, deps)
  await outcome.mails
  const mail = mails.at(-1)
  if (mail?.kind !== "confirm") throw new Error("expected a confirm mail")
  return tokenOf(mail.confirmLink)
}

/** Subscribes `email` all the way and returns its welcome mail's unsubscribe token. */
async function subscribe(deps: FlowDeps, mails: SubscriberMail[], email = JANE) {
  const outcome = await confirmSubscription(await confirmTokenFor(deps, mails, email), deps)
  if (outcome.state !== "confirmed") throw new Error(`expected confirmed, got ${outcome.state}`)
  await outcome.mails
  const mail = mails.at(-1)
  if (mail?.kind !== "welcome") throw new Error("expected a welcome mail")
  return tokenOf(mail.unsubscribeLink)
}

/** A store whose every call is counted. */
function countingStore() {
  const inner = createMemorySubscriberStore()
  const calls: string[] = []
  const store: SubscriberStore = {
    list: () => (calls.push("list"), inner.list()),
    findByKey: (key) => (calls.push("findByKey"), inner.findByKey(key)),
    add: (input) => (calls.push("add"), inner.add(input)),
    remove: (input) => (calls.push("remove"), inner.remove(input)),
    count: () => (calls.push("count"), inner.count()),
  }
  return { store, calls }
}

describe("requestSubscription", () => {
  it("mails a confirm link for a bare address, lowercased", async () => {
    const { deps, mails } = harness()
    const outcome = await requestSubscription("  Jane@Example.com ", deps)
    expect(outcome.status).toBe(200)
    await outcome.mails
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ kind: "confirm", email: JANE })
    const token = tokenOf((mails[0] as { confirmLink: string }).confirmLink)
    expect(await previewConfirmation(token, deps)).toEqual({ state: "confirm", email: JANE })
  })

  it("answers 400 for anything but a bare address and mails nothing", async () => {
    const { deps, mails } = harness()
    for (const field of [undefined, 42, "", "not an address", `"Eve" <${JANE}>`]) {
      const outcome = await requestSubscription(field, deps)
      expect(outcome.status).toBe(400)
      await outcome.mails
    }
    expect(mails).toEqual([])
  })

  it("answers a listed address exactly like a new one, without touching the store", async () => {
    const listed = harness()
    await subscribe(listed.deps, listed.mails)
    const counting = countingStore()
    const fresh = harness({ store: counting.store })

    const forListed = await requestSubscription(JANE, listed.deps)
    const forNew = await requestSubscription(JANE, fresh.deps)
    await Promise.all([forListed.mails, forNew.mails])

    expect(forListed).toEqual(forNew)
    expect(listed.mails.at(-1)?.kind).toBe("confirm")
    expect(fresh.mails.map((mail) => mail.kind)).toEqual(["confirm"])
    expect(counting.calls).toEqual([])
  })

  it("answers 500 and mails nothing when the link cannot be built", async () => {
    const { deps, mails, logs } = harness()
    deps.links.confirm = () => {
      throw new Error("no base URL")
    }
    const outcome = await requestSubscription(JANE, deps)
    expect(outcome.status).toBe(500)
    expect(mails).toEqual([])
    expect(logs).toHaveLength(1)
  })

  it("answers 429 with a wait once a client is over its limit", async () => {
    const client = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, clock: () => NOW })
    const { deps, mails } = harness({ limits: { client } })
    const statuses = []
    for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
      statuses.push((await requestSubscription(email, deps, { clientKey: "192.0.2.1" })).status)
    }
    expect(statuses).toEqual([200, 200, 429])
    const limited = await requestSubscription("d@example.com", deps, { clientKey: "192.0.2.1" })
    expect(limited.retryAfterMs).toBeGreaterThan(0)
    expect((await requestSubscription("d@example.com", deps, { clientKey: "192.0.2.2" })).status)
      .toBe(200)
    expect(mails).toHaveLength(3)
  })

  it("stops many clients from flooding one inbox, without telling them", async () => {
    const recipient = createMemoryRateLimiter({ limit: 2, windowMs: 60_000, clock: () => NOW })
    const { deps, mails, logs } = harness({ limits: { recipient } })
    for (let index = 0; index < 5; index += 1) {
      const outcome = await requestSubscription(JANE, deps, { clientKey: `192.0.2.${index}` })
      expect(outcome.status).toBe(200)
      await outcome.mails
    }
    expect(await requestSubscription("ann@example.com", deps)).toMatchObject({ status: 200 })
    expect(mails.map((mail) => mail.email)).toEqual([JANE, JANE, "ann@example.com"])
    expect(logs.filter((line) => line[0] === "warn")).toHaveLength(3)
  })
})

describe("confirmSubscription", () => {
  it("adds the address and mails a welcome with a working unsubscribe link", async () => {
    const { deps, mails, store } = harness()
    const unsubscribeToken = await subscribe(deps, mails)
    expect(mails.at(-1)).toMatchObject({ kind: "welcome", email: JANE, total: 1 })
    expect((await store.list()).map((row) => row.email)).toEqual([JANE])
    expect(await previewUnsubscribe(unsubscribeToken, deps)).toEqual({
      state: "confirm",
      email: JANE,
    })
  })

  it("changes nothing and mails nothing when confirmed again", async () => {
    const { deps, mails, store } = harness()
    const token = await confirmTokenFor(deps, mails)
    await confirmSubscription(token, deps)
    const sent = mails.length
    const again = await confirmSubscription(token, deps)
    expect(again.state).toBe("confirmed")
    expect(mails).toHaveLength(sent)
    expect(await store.count()).toBe(1)
  })

  it("refuses a confirm link issued before the address unsubscribed", async () => {
    const { deps, mails, clock, store } = harness()
    const token = await confirmTokenFor(deps, mails)
    await confirmSubscription(token, deps)
    clock.at += 1000
    const unsubscribeToken = mails.at(-1)?.kind === "welcome"
      ? tokenOf((mails.at(-1) as { unsubscribeLink: string }).unsubscribeLink)
      : ""
    expect(await unsubscribe(unsubscribeToken, deps)).toEqual({ state: "done" })
    clock.at += 1000
    expect(await confirmSubscription(token, deps)).toEqual({ state: "invalid" })
    expect(await store.count()).toBe(0)
  })

  it("accepts a link requested after the unsubscribe", async () => {
    const { deps, mails, clock } = harness()
    const unsubscribeToken = await subscribe(deps, mails)
    clock.at += 1000
    await unsubscribe(unsubscribeToken, deps)
    clock.at += 1000
    expect((await confirmSubscription(await confirmTokenFor(deps, mails), deps)).state)
      .toBe("confirmed")
  })

  it("answers expired after three days and stores nothing", async () => {
    const { deps, mails, clock, store } = harness()
    const token = await confirmTokenFor(deps, mails)
    clock.at += CONFIRM_TTL_MS
    expect(await previewConfirmation(token, deps)).toEqual({ state: "expired" })
    expect(await confirmSubscription(token, deps)).toEqual({ state: "expired" })
    expect(await store.count()).toBe(0)
  })

  it("stores nothing when the unsubscribe link cannot be built", async () => {
    const { deps, mails, store } = harness()
    const token = await confirmTokenFor(deps, mails)
    deps.links.unsubscribe = () => {
      throw new Error("no base URL")
    }
    expect(await confirmSubscription(token, deps)).toEqual({ state: "error" })
    expect(await store.count()).toBe(0)
  })

  it("previews without storing", async () => {
    const counting = countingStore()
    const { deps, mails } = harness({ store: counting.store })
    const token = await confirmTokenFor(deps, mails)
    expect(await previewConfirmation(token, deps)).toEqual({ state: "confirm", email: JANE })
    expect(counting.calls).toEqual([])
  })
})

describe("unsubscribe", () => {
  it("removes the address once, then no longer recognises the link", async () => {
    const { deps, mails, store } = harness()
    const token = await subscribe(deps, mails)
    expect(await unsubscribe(token, deps)).toEqual({ state: "done" })
    expect(await store.count()).toBe(0)
    expect(await unsubscribe(token, deps)).toEqual({ state: "not-recognised" })
    expect(await previewUnsubscribe(token, deps)).toEqual({ state: "not-recognised" })
  })

  it("previews without removing", async () => {
    const { deps, mails, store } = harness()
    const token = await subscribe(deps, mails)
    expect(await previewUnsubscribe(token, deps)).toEqual({ state: "confirm", email: JANE })
    expect(await store.count()).toBe(1)
  })

  it("does not recognise a forged token", async () => {
    const { deps, mails } = harness()
    await subscribe(deps, mails)
    expect(await unsubscribe("forged.token", deps)).toEqual({ state: "not-recognised" })
  })

  it("honours an unsubscribe link antonshubin.com mailed", async () => {
    const { deps, store } = harness()
    await store.add({ email: JANE, key: "legacy", mark: "m", issuedAt: NOW, at: new Date(NOW) })
    expect(await unsubscribe(SITE_UNSUBSCRIBE_TOKEN, deps)).toEqual({ state: "done" })
    expect(await store.count()).toBe(0)
  })

  it("rate-limits the version 1 scan per client and leaves version 2 links alone", async () => {
    const client = createMemoryRateLimiter({ limit: 1, windowMs: 60_000, clock: () => NOW })
    const { deps, mails } = harness({ limits: { client } })
    const token = await subscribe(deps, mails)
    const request = { clientKey: "192.0.2.1" }
    expect(await previewUnsubscribe(SITE_UNSUBSCRIBE_TOKEN, deps, request)).toEqual({
      state: "confirm",
      email: JANE,
    })
    expect(await previewUnsubscribe(SITE_UNSUBSCRIBE_TOKEN, deps, request)).toMatchObject({
      state: "limited",
    })
    expect(await unsubscribe(SITE_UNSUBSCRIBE_TOKEN, deps, request)).toMatchObject({
      state: "limited",
    })
    expect(await previewUnsubscribe(token, deps, request)).toEqual({
      state: "confirm",
      email: JANE,
    })
    expect(await unsubscribe(token, deps, request)).toEqual({ state: "done" })
  })
})

describe("logging", () => {
  it("never logs an address, even when a relay or the store echoes it in another case", async () => {
    const echo = (text: string) => text.replace(JANE, JANE.toUpperCase())
    let failStore = false
    const inner = createMemorySubscriberStore()
    const store: SubscriberStore = {
      ...inner,
      add: (input) =>
        failStore
          ? Promise.reject(new Error(echo(`duplicate key ${input.email}`)))
          : inner.add(input),
      remove: (input) =>
        failStore
          ? Promise.reject(new Error(echo(`cannot remove ${input.email}`)))
          : inner.remove(input),
      count: () => failStore ? Promise.reject(new Error("count failed")) : inner.count(),
    }
    const { deps, mails, logs } = harness({
      store,
      sendMail: (mail) =>
        mail.kind === "confirm"
          ? Promise.reject(new Error(echo(`550 <${mail.email}> mailbox unavailable`)))
          : Promise.resolve({ ok: false, error: echo(`550 5.1.1 ${mail.email}: rejected`) }),
    })

    const request = await requestSubscription(JANE, deps)
    await request.mails
    const confirmLink = (mails.at(-1) as { confirmLink: string }).confirmLink
    const confirmed = await confirmSubscription(tokenOf(confirmLink), deps)
    if (confirmed.state !== "confirmed") throw new Error("expected confirmed")
    await confirmed.mails
    const unsubscribeLink = (mails.at(-1) as { unsubscribeLink: string }).unsubscribeLink
    await previewUnsubscribe(tokenOf(unsubscribeLink), deps)

    failStore = true
    expect(await unsubscribe(tokenOf(unsubscribeLink), deps)).toEqual({ state: "error" })
    expect(await confirmSubscription(tokenOf(confirmLink), deps)).toEqual({ state: "error" })
    failStore = false
    deps.links.confirm = () => {
      throw new Error(echo(`cannot build a link for ${JANE}`))
    }
    expect((await requestSubscription(JANE, deps)).status).toBe(500)

    const text = JSON.stringify(logs)
    expect(logs).toHaveLength(5)
    expect(text.toLowerCase()).not.toContain("jane")
    expect(text.match(/<REDACTED:EMAIL>/g)).toHaveLength(5)
  })
})
