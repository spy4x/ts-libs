import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import { CONFIRM_TTL_MS, createSubscriptionCrypto, type UnsubscribeLookup } from "./crypto.ts"
import type { Subscriber } from "./store.ts"

// Produced by antonshubin.com's own `lib/unsubscribe.ts`, `lib/unsubscribed.ts`,
// `lib/newsletter-log.ts` and `lib/subscribe-token.ts` under this fake secret, with a throwaway
// script outside both repositories. They pin byte-for-byte compatibility with the links already in
// subscribers' inboxes and the marks already in the site's files.
const SITE = {
  secret: "fixture-secret-not-a-real-one-0123456789",
  email: "jane@example.com",
  unsubscribeToken:
    "eyJwdXJwb3NlIjoidW5zdWJzY3JpYmUiLCJ2ZXJzaW9uIjoxLCJwYXlsb2FkIjp7fX0.ykHC53_rs7XXy79oIQoSxzg9BpwrwHenQyROeLMIGJI",
  unsubscribeMark: "cad0e9c3dda5ba904ff499e982abb84618f0ce1c2c74565c1270e41ae4aaff0f",
  /** `sentMark(email, "hello-world", secret)`. */
  sentMark: "b8554b74206312a06e055d1896587581ff9745950f45c31bca21c9b41feafd72",
  /** `createConfirmToken(email, secret, () => NOW)`: version 1, expires at NOW + three days. */
  confirmToken:
    "eyJwdXJwb3NlIjoic3Vic2NyaWJlLWNvbmZpcm0iLCJ2ZXJzaW9uIjoxLCJleHBpcmVzQXQiOjk3ODU2NjQwMDAwMCwicGF5bG9hZCI6eyJlbWFpbCI6ImphbmVAZXhhbXBsZS5jb20ifX0.TY2Gim8Gv-vQyfpzgIxfaW0P4u_vgC2cAZWJtkiLCvc",
}
const OTHER_SECRET = "another-fixture-secret-not-real-98765432"
const NOW = Date.UTC(2001, 0, 1)

/** A lookup over `emails`, keyed by `crypto`, that counts every call. */
async function lookupOf(crypto: ReturnType<typeof createSubscriptionCrypto>, emails: string[]) {
  const rows: Subscriber[] = await Promise.all(emails.map(async (email) => ({
    email,
    key: await crypto.subscriberKey(email),
    subscribedAt: new Date(NOW),
  })))
  const calls = { list: 0, findByKey: 0 }
  const lookup: UnsubscribeLookup = {
    list: () => {
      calls.list += 1
      return Promise.resolve(rows)
    },
    findByKey: (key) => {
      calls.findByKey += 1
      return Promise.resolve(rows.find((row) => row.key === key))
    },
  }
  return { lookup, calls }
}

/** The envelope JSON of a token, decoded without checking it. */
function envelopeText(token: string): string {
  return new TextDecoder().decode(decodeBase64Url(token.split(".")[0]))
}

describe("createSubscriptionCrypto: antonshubin.com compatibility", () => {
  const crypto = createSubscriptionCrypto({ secret: SITE.secret, now: () => NOW })

  it("verifies an unsubscribe link the site mailed", async () => {
    const { lookup } = await lookupOf(crypto, ["ann@example.com", SITE.email, "bob@example.com"])
    expect((await crypto.verifyUnsubscribeToken(SITE.unsubscribeToken, lookup))?.email)
      .toBe(SITE.email)
  })

  it("verifies a site link against a row that has no key", async () => {
    const lookup: UnsubscribeLookup = {
      list: () => Promise.resolve([{ email: SITE.email, subscribedAt: new Date(NOW) }]),
      findByKey: () => Promise.resolve(undefined),
    }
    expect((await crypto.verifyUnsubscribeToken(SITE.unsubscribeToken, lookup))?.email)
      .toBe(SITE.email)
  })

  it("derives the site's unsubscribe mark byte for byte", async () => {
    expect(await crypto.unsubscribeMark(SITE.email)).toBe(SITE.unsubscribeMark)
  })

  it("derives the site's sent mark byte for byte", async () => {
    expect(await crypto.sentMark(SITE.email, "hello-world")).toBe(SITE.sentMark)
  })

  it("refuses a version 1 confirm link as invalid", async () => {
    expect(await crypto.verifyConfirmToken(SITE.confirmToken)).toEqual({
      ok: false,
      reason: "invalid",
    })
  })
})

describe("createSubscriptionCrypto: confirm tokens", () => {
  const clock = { at: NOW }
  const crypto = createSubscriptionCrypto({ secret: SITE.secret, now: () => clock.at })

  it("carries the normalised address and the issue time", async () => {
    clock.at = NOW
    const token = await crypto.confirmToken("  Jane@Example.com ")
    clock.at = NOW + 1000
    expect(await crypto.verifyConfirmToken(token)).toEqual({
      ok: true,
      email: SITE.email,
      issuedAt: NOW,
    })
  })

  it("works until three days have passed, then answers expired", async () => {
    clock.at = NOW
    const token = await crypto.confirmToken(SITE.email)
    clock.at = NOW + CONFIRM_TTL_MS - 1
    expect((await crypto.verifyConfirmToken(token)).ok).toBe(true)
    clock.at = NOW + CONFIRM_TTL_MS
    expect(await crypto.verifyConfirmToken(token)).toEqual({ ok: false, reason: "expired" })
  })

  it("refuses a token re-pointed at another address", async () => {
    clock.at = NOW
    const token = await crypto.confirmToken(SITE.email)
    const [envelope, signature] = token.split(".")
    const swapped = envelopeText(token).replace(SITE.email, "eve@example.com")
    const forged = `${encodeBase64Url(new TextEncoder().encode(swapped))}.${signature}`
    expect(envelope).not.toBe(forged.split(".")[0])
    expect(await crypto.verifyConfirmToken(forged)).toEqual({ ok: false, reason: "invalid" })
  })

  it("refuses a token signed with another secret", async () => {
    clock.at = NOW
    const other = createSubscriptionCrypto({ secret: OTHER_SECRET, now: () => clock.at })
    expect(await crypto.verifyConfirmToken(await other.confirmToken(SITE.email))).toEqual({
      ok: false,
      reason: "invalid",
    })
  })

  it("refuses an unsubscribe token and garbage as invalid without throwing", async () => {
    clock.at = NOW
    for (const token of [await crypto.unsubscribeToken(SITE.email), "", "a.b", "not a token"]) {
      expect(await crypto.verifyConfirmToken(token)).toEqual({ ok: false, reason: "invalid" })
    }
  })
})

describe("createSubscriptionCrypto: unsubscribe tokens", () => {
  const crypto = createSubscriptionCrypto({ secret: SITE.secret, now: () => NOW })

  it("holds no address", async () => {
    const token = await crypto.unsubscribeToken(SITE.email)
    expect(envelopeText(token)).not.toContain("jane")
    expect(token).not.toContain("jane")
  })

  it("finds the subscriber with one key lookup and never scans the list", async () => {
    const emails = Array.from({ length: 50 }, (_, index) => `user${index}@example.com`)
    const { lookup, calls } = await lookupOf(crypto, [...emails, SITE.email])
    const token = await crypto.unsubscribeToken(SITE.email)
    expect((await crypto.verifyUnsubscribeToken(token, lookup))?.email).toBe(SITE.email)
    expect(calls).toEqual({ list: 0, findByKey: 1 })
  })

  it("finds nothing once the address left the list", async () => {
    const { lookup } = await lookupOf(crypto, ["ann@example.com"])
    const token = await crypto.unsubscribeToken(SITE.email)
    expect(await crypto.verifyUnsubscribeToken(token, lookup)).toBeUndefined()
  })

  it("refuses a token re-pointed at another subscriber's key", async () => {
    const { lookup } = await lookupOf(crypto, ["ann@example.com", SITE.email])
    const token = await crypto.unsubscribeToken(SITE.email)
    const annKey = await crypto.subscriberKey("ann@example.com")
    const janeKey = await crypto.subscriberKey(SITE.email)
    const swapped = envelopeText(token).replace(janeKey, annKey)
    const forged = `${encodeBase64Url(new TextEncoder().encode(swapped))}.${token.split(".")[1]}`
    expect(await crypto.verifyUnsubscribeToken(forged, lookup)).toBeUndefined()
  })

  it("refuses a token signed with another secret", async () => {
    const { lookup } = await lookupOf(crypto, [SITE.email])
    const other = createSubscriptionCrypto({ secret: OTHER_SECRET })
    const token = await other.unsubscribeToken(SITE.email)
    expect(await crypto.verifyUnsubscribeToken(token, lookup)).toBeUndefined()
  })

  it("refuses a confirm token and garbage without throwing", async () => {
    const { lookup } = await lookupOf(crypto, [SITE.email])
    for (const token of [await crypto.confirmToken(SITE.email), "", "x.y", "%%%"]) {
      expect(await crypto.verifyUnsubscribeToken(token, lookup)).toBeUndefined()
    }
  })
})

describe("createSubscriptionCrypto: secret rotation", () => {
  const old = createSubscriptionCrypto({ secret: OTHER_SECRET, now: () => NOW })
  const rotated = createSubscriptionCrypto({
    secret: SITE.secret,
    previousSecrets: [OTHER_SECRET],
    now: () => NOW,
  })

  it("verifies unsubscribe links signed with a previous secret", async () => {
    const { lookup } = await lookupOf(old, [SITE.email])
    const unsubscribe = await old.unsubscribeToken(SITE.email)
    expect((await rotated.verifyUnsubscribeToken(unsubscribe, lookup))?.email).toBe(SITE.email)
  })

  it("verifies a site link signed with a previous secret", async () => {
    const legacy = createSubscriptionCrypto({
      secret: OTHER_SECRET,
      previousSecrets: [SITE.secret],
    })
    const { lookup } = await lookupOf(legacy, [SITE.email])
    expect((await legacy.verifyUnsubscribeToken(SITE.unsubscribeToken, lookup))?.email)
      .toBe(SITE.email)
  })

  it("refuses a confirm link signed with a previous secret", async () => {
    expect(await rotated.verifyConfirmToken(await old.confirmToken(SITE.email))).toEqual({
      ok: false,
      reason: "invalid",
    })
  })

  it("signs and keys only with the current secret", async () => {
    const current = createSubscriptionCrypto({ secret: SITE.secret, now: () => NOW })
    expect(await rotated.confirmToken(SITE.email)).toBe(await current.confirmToken(SITE.email))
    expect(await rotated.unsubscribeToken(SITE.email)).toBe(
      await current.unsubscribeToken(SITE.email),
    )
    expect(await rotated.subscriberKey(SITE.email)).toBe(await current.subscriberKey(SITE.email))
    expect(await rotated.unsubscribeMark(SITE.email)).toBe(SITE.unsubscribeMark)
  })

  it("throws on an unusable previous secret", () => {
    expect(() => createSubscriptionCrypto({ secret: SITE.secret, previousSecrets: ["short"] }))
      .toThrow()
  })
})

describe("createSubscriptionCrypto: keyed hashes", () => {
  const crypto = createSubscriptionCrypto({ secret: SITE.secret })

  it("throws on a secret shorter than 32 characters", () => {
    expect(() => createSubscriptionCrypto({ secret: "too-short" })).toThrow()
  })

  it("gives a 16-byte hex subscriber key that ignores case and padding", async () => {
    const key = await crypto.subscriberKey(SITE.email)
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(await crypto.subscriberKey(" JANE@example.COM ")).toBe(key)
    expect(await crypto.subscriberKey("ann@example.com")).not.toBe(key)
  })

  it("keeps every purpose apart", async () => {
    const values = [
      await crypto.subscriberKey(SITE.email),
      (await crypto.unsubscribeMark(SITE.email)).slice(0, 32),
      (await crypto.sentMark(SITE.email, "a")).slice(0, 32),
      (await crypto.sentMark(SITE.email, "b")).slice(0, 32),
    ]
    expect(new Set(values).size).toBe(values.length)
  })
})
