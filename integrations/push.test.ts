import { expect } from "@std/expect"
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding"
import type { DnsResolver } from "@spy4x/net/url-policy"
import type { PushSubscriptionJson } from "@spy4x/platform/model"
import {
  createWebPushSender,
  generateVapidKeyPair,
  type PushSubscriptionStore,
  type PushTransport,
  vapidPublicKey,
} from "./push.ts"

const resolver: DnsResolver = { resolve: () => Promise.resolve(["93.184.216.34"]) }
const subscription = (name: string): PushSubscriptionJson => ({
  endpoint: `https://push.example.com/send/${name}`,
  expirationTime: null,
  keys: { auth: "auth", p256dh: "p256dh" },
})

const fakeStore = (subscriptions: PushSubscriptionJson[], failDelete = false) => {
  const deleted: string[] = []
  const store: PushSubscriptionStore = {
    listByUser: () => Promise.resolve(subscriptions),
    deleteByEndpoint: (_userId, endpoint) => {
      if (failDelete) return Promise.reject(new Error("db down"))
      deleted.push(endpoint)
      return Promise.resolve()
    },
  }
  return { store, deleted }
}

/** An error shaped like `@negrel/webpush`'s `PushMessageError`. */
const refused = (status: number) =>
  Object.assign(new Error(), { response: new Response("", { status }) })

const build = async (
  subscriptions: PushSubscriptionJson[],
  transport: PushTransport,
  extra: { failDelete?: boolean; requestTimeoutMs?: number } = {},
) => {
  const { store, deleted } = fakeStore(subscriptions, extra.failDelete)
  const sender = await createWebPushSender({
    vapidKeys: (await generateVapidKeyPair()).keys,
    subject: `mailto:ops@example.com`,
    store,
    transport,
    resolver,
    requestTimeoutMs: extra.requestTimeoutMs,
  })
  return { sender, deleted }
}

describe("web push sender", () => {
  it("sends the serialised message to every subscription of the user", async () => {
    const sent: string[] = []
    const { sender, deleted } = await build([subscription("a"), subscription("b")], (s, m) => {
      sent.push(`${s.endpoint} ${m}`)
      return Promise.resolve()
    })
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.success).toBe(true)
    expect(result.deliveries.map((d) => d.status)).toEqual([`sent`, `sent`])
    expect(sent).toEqual([
      `https://push.example.com/send/a {"title":"Hi","body":null,"url":null}`,
      `https://push.example.com/send/b {"title":"Hi","body":null,"url":null}`,
    ])
    expect(deleted).toEqual([])
  })

  for (const status of [404, 410]) {
    it(`deletes the subscription when the push service answers ${status}`, async () => {
      const { sender, deleted } = await build(
        [subscription("a")],
        () => Promise.reject(refused(status)),
      )
      const result = await sender.send(1, { title: `Hi`, body: null, url: null })
      expect(deleted).toEqual([`https://push.example.com/send/a`])
      expect(result.deliveries[0]).toMatchObject({
        status: `gone`,
        httpStatus: status,
        deleted: true,
      })
      expect(result.success).toBe(true)
    })
  }

  for (const status of [400, 401, 413, 429, 500, 503]) {
    it(`keeps the subscription when the push service answers ${status}`, async () => {
      const { sender, deleted } = await build(
        [subscription("a")],
        () => Promise.reject(refused(status)),
      )
      const result = await sender.send(1, { title: `Hi`, body: null, url: null })
      expect(deleted).toEqual([])
      expect(result.success).toBe(false)
      expect(result.error).toBe(`HTTP ${status}`)
    })
  }

  it("keeps sending to the other subscriptions when one fails", async () => {
    const { sender, deleted } = await build(
      [subscription("a"), subscription("gone"), subscription("c")],
      (s) =>
        s.endpoint.endsWith(`/a`)
          ? Promise.reject(new Error(`boom`))
          : s.endpoint.endsWith(`/gone`)
          ? Promise.reject(refused(410))
          : Promise.resolve(),
    )
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.deliveries.map((d) => d.status)).toEqual([`failed`, `gone`, `sent`])
    expect(deleted).toEqual([`https://push.example.com/send/gone`])
  })

  it("reports a subscription it could not delete instead of throwing", async () => {
    const { sender } = await build([subscription("a")], () => Promise.reject(refused(410)), {
      failDelete: true,
    })
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.success).toBe(false)
    expect(result.deliveries[0].deleted).toBe(false)
  })

  it("gives up on a stalled push service after the timeout and keeps the subscription", async () => {
    const { sender, deleted } = await build([subscription("a")], () => new Promise(() => {}), {
      requestTimeoutMs: 20,
    })
    // Its own deadline, so a missing timeout fails this test instead of hanging the runner.
    let deadline: number | undefined
    const result = await Promise.race([
      sender.send(1, { title: `Hi`, body: null, url: null }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`send did not return within 2 s`)), 2_000)
      }),
    ]).finally(() => clearTimeout(deadline))
    expect(result.error).toBe(`request timed out after 20 ms`)
    expect(deleted).toEqual([])
  })

  it("rejects an invalid payload without sending", async () => {
    let calls = 0
    const { sender } = await build([subscription("a")], () => {
      calls++
      return Promise.resolve()
    })
    const result = await sender.send(1, { title: ``, body: null, url: null })
    expect(result.success).toBe(false)
    expect(result.error).toContain(`invalid push payload`)
    expect(calls).toBe(0)
  })

  it("refuses an endpoint that is not public HTTPS and never contacts it", async () => {
    let calls = 0
    const bad: PushSubscriptionJson = { ...subscription("a"), endpoint: `http://169.254.169.254/x` }
    const { sender, deleted } = await build([bad], () => {
      calls++
      return Promise.resolve()
    })
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.deliveries[0].status).toBe(`failed`)
    expect(calls).toBe(0)
    expect(deleted).toEqual([])
  })

  it("never puts an endpoint in the error text", async () => {
    const { sender } = await build(
      [subscription("secret-token")],
      () => Promise.reject(new Error(`failed https://push.example.com/send/secret-token`)),
    )
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.error).not.toContain(`secret-token`)
    expect(result.output).not.toContain(`secret-token`)
  })

  it("returns a failure instead of throwing when the store fails", async () => {
    const sender = await createWebPushSender({
      vapidKeys: (await generateVapidKeyPair()).keys,
      subject: `mailto:ops@example.com`,
      store: {
        listByUser: () => Promise.reject(new Error(`db down`)),
        deleteByEndpoint: () => Promise.resolve(),
      },
      transport: () => Promise.resolve(),
    })
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.success).toBe(false)
  })

  it("throws at construction on an empty subject", async () => {
    await expect(createWebPushSender({
      vapidKeys: (await generateVapidKeyPair()).keys,
      subject: ` `,
      store: fakeStore([]).store,
      transport: () => Promise.resolve(),
    })).rejects.toThrow(`subject`)
  })
})

describe("VAPID keys", () => {
  it("round-trips: the public key equals the one derived from the stored keys", async () => {
    const pair = await generateVapidKeyPair()
    expect(await vapidPublicKey(pair.keys)).toBe(pair.publicKey)
    const raw = new Uint8Array(65)
    raw[0] = 4
    raw.set(decodeBase64Url(pair.keys.publicKey.x!), 1)
    raw.set(decodeBase64Url(pair.keys.publicKey.y!), 33)
    expect(pair.publicKey).toBe(encodeBase64Url(raw))
    expect(pair.publicKey).toHaveLength(87)
  })

  it("generates a different pair each time", async () => {
    expect((await generateVapidKeyPair()).publicKey).not.toBe(
      (await generateVapidKeyPair()).publicKey,
    )
  })
})

describe("default transport (real encryption, faked network)", () => {
  const realFetch = globalThis.fetch
  let requests: { url: string; headers: Headers; bytes: number }[] = []
  let status = 201
  beforeEach(() => {
    requests = []
    status = 201
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        bytes: (init?.body as Uint8Array).byteLength,
      })
      return Promise.resolve(new Response("", { status }))
    }) as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const browserSubscription = async (): Promise<PushSubscriptionJson> => {
    const pair = await crypto.subtle.generateKey({ name: `ECDH`, namedCurve: `P-256` }, true, [
      `deriveKey`,
    ])
    const raw = await crypto.subtle.exportKey(`raw`, pair.publicKey)
    return {
      endpoint: `https://push.example.com/send/real`,
      expirationTime: null,
      keys: {
        p256dh: encodeBase64Url(raw),
        auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
      },
    }
  }

  const realSender = async (subscriptions: PushSubscriptionJson[]) => {
    const { store, deleted } = fakeStore(subscriptions)
    const pair = await generateVapidKeyPair()
    const sender = await createWebPushSender({
      vapidKeys: pair.keys,
      subject: `mailto:ops@example.com`,
      store,
      resolver,
    })
    return { sender, deleted, pair }
  }

  it("posts an encrypted, VAPID-signed message to the subscription endpoint", async () => {
    const { sender, pair } = await realSender([await browserSubscription()])
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.success).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`https://push.example.com/send/real`)
    expect(requests[0].headers.get(`Content-Encoding`)).toBe(`aes128gcm`)
    expect(requests[0].headers.get(`Authorization`)).toContain(`k=${pair.publicKey}`)
    expect(requests[0].bytes).toBeGreaterThan(86)
  })

  it("deletes the subscription when the real library sees a 410", async () => {
    status = 410
    const { sender, deleted } = await realSender([await browserSubscription()])
    const result = await sender.send(1, { title: `Hi`, body: null, url: null })
    expect(result.deliveries[0].status).toBe(`gone`)
    expect(deleted).toEqual([`https://push.example.com/send/real`])
  })
})
