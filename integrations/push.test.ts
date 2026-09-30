import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding"
import type { DnsResolver } from "@spy4x/net/url-policy"
import type { PushSubscriptionJson } from "@spy4x/platform/model"
import {
  createWebPushSender,
  generateVapidKeyPair,
  type PushSubscriptionStore,
  vapidPublicKey,
} from "./push.ts"

const USER = 42
const MESSAGE = { title: "Hi", body: null, url: null }
const publicResolver: DnsResolver = { resolve: () => Promise.resolve(["93.184.216.34"]) }

/** A browser subscription with real keys, so the real encryption runs. */
const subscription = async (name: string): Promise<PushSubscriptionJson> => {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
  ])
  return {
    endpoint: `https://push.example.com/send/${name}`,
    expirationTime: null,
    keys: {
      p256dh: encodeBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      auth: encodeBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    },
  }
}

interface StoreCall {
  op: "list" | "delete"
  userId: string | number
  endpoint?: string
}

const fakeStore = (subscriptions: PushSubscriptionJson[], failDelete = false) => {
  const calls: StoreCall[] = []
  const store: PushSubscriptionStore = {
    listByUser: (userId) => {
      calls.push({ op: "list", userId })
      // Only this user's subscriptions come back; any other id sees none.
      return Promise.resolve(userId === USER ? subscriptions : [])
    },
    deleteByEndpoint: (userId, endpoint) => {
      calls.push({ op: "delete", userId, endpoint })
      return failDelete ? Promise.reject(new Error("db down")) : Promise.resolve()
    },
  }
  return { store, calls }
}

interface Request {
  url: string
  init: RequestInit
}

type Answer = (request: Request) => Response | Promise<Response>

const fakeFetch = (answer: Answer) => {
  const requests: Request[] = []
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const request = { url: String(input), init: init ?? {} }
    requests.push(request)
    return Promise.resolve(answer(request))
  }) as typeof fetch
  return { fetcher, requests }
}

const answering = (status: number): Answer => () => new Response("", { status })

const build = async (
  subscriptions: PushSubscriptionJson[],
  answer: Answer,
  extra: { failDelete?: boolean; requestTimeoutMs?: number; resolver?: DnsResolver } = {},
) => {
  const { store, calls } = fakeStore(subscriptions, extra.failDelete)
  const { fetcher, requests } = fakeFetch(answer)
  const pair = await generateVapidKeyPair()
  const sender = await createWebPushSender({
    vapidKeys: pair.keys,
    subject: "mailto:ops@example.com",
    store,
    fetch: fetcher,
    resolver: extra.resolver ?? publicResolver,
    requestTimeoutMs: extra.requestTimeoutMs,
  })
  return { sender, calls, requests, pair, fetcher }
}

/** Fails the test instead of hanging the runner when `promise` does not settle in time. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: number | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("web push sender", () => {
  it("posts an encrypted, VAPID-signed message to every subscription of the user", async () => {
    const { sender, requests, calls, pair } = await build(
      [await subscription("a"), await subscription("b")],
      answering(201),
    )
    const result = await sender.send(USER, MESSAGE, { urgency: "high", ttl: 60, topic: "t" })
    expect(result.success).toBe(true)
    expect(result.deliveries.map((d) => d.status)).toEqual(["sent", "sent"])
    expect(requests.map((r) => r.url).sort()).toEqual([
      "https://push.example.com/send/a",
      "https://push.example.com/send/b",
    ])
    const { init } = requests.find((r) => r.url.endsWith("/a"))!
    const headers = init.headers as Record<string, string>
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("manual")
    expect(headers["Content-Encoding"]).toBe("aes128gcm")
    expect([headers["Urgency"], headers["TTL"], headers["Topic"]]).toEqual(["high", "60", "t"])
    expect(headers["Authorization"]).toContain(`k=${pair.publicKey}`)
    expect((init.body as ArrayBuffer).byteLength).toBeGreaterThan(86)
    expect(calls).toEqual([{ op: "list", userId: USER }])
  })

  it("signs the VAPID token for the push service origin with the stored private key", async () => {
    const { sender, requests, pair } = await build([await subscription("a")], answering(201))
    await sender.send(USER, MESSAGE)
    const authorization = (requests[0].init.headers as Record<string, string>)["Authorization"]
    const token = authorization.match(/^vapid t=([^,]+), k=/)![1]
    const [header, claims, signature] = token.split(".")
    const key = await crypto.subtle.importKey(
      "jwk",
      pair.keys.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(`${header}.${claims}`),
    )
    expect(valid).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(decodeBase64Url(claims)))).toMatchObject({
      aud: "https://push.example.com",
      sub: "mailto:ops@example.com",
    })
  })

  for (const status of [404, 410]) {
    it(`deletes the subscription of that user when the push service answers ${status}`, async () => {
      const { sender, calls } = await build([await subscription("a")], answering(status))
      const result = await sender.send(USER, MESSAGE)
      expect(calls).toEqual([
        { op: "list", userId: USER },
        { op: "delete", userId: USER, endpoint: "https://push.example.com/send/a" },
      ])
      expect(result.deliveries[0]).toMatchObject({ status: "gone", httpStatus: status })
      expect(result.deliveries[0].deleted).toBe(true)
      expect(result.success).toBe(true)
    })
  }

  it("reads only the subscriptions of the user it is given", async () => {
    const { sender, requests, calls } = await build([await subscription("a")], answering(201))
    const result = await sender.send(7, MESSAGE)
    expect(calls).toEqual([{ op: "list", userId: 7 }])
    expect(requests).toEqual([])
    expect(result.output).toBe("0 sent, 0 removed, 0 failed of 0")
  })

  for (const status of [400, 401, 413, 429, 500, 503]) {
    it(`keeps the subscription when the push service answers ${status}`, async () => {
      const { sender, calls } = await build([await subscription("a")], answering(status))
      const result = await sender.send(USER, MESSAGE)
      expect(calls.filter((c) => c.op === "delete")).toEqual([])
      expect(result.success).toBe(false)
      expect(result.error).toBe(`HTTP ${status}`)
    })
  }

  it("keeps sending to the other subscriptions when one fails", async () => {
    const { sender, calls } = await build(
      [await subscription("a"), await subscription("gone"), await subscription("c")],
      ({ url }) => {
        if (url.endsWith("/a")) throw new TypeError("connection reset")
        return new Response("", { status: url.endsWith("/gone") ? 410 : 201 })
      },
    )
    const result = await sender.send(USER, MESSAGE)
    expect(result.deliveries.map((d) => d.status)).toEqual(["failed", "gone", "sent"])
    expect(calls.filter((c) => c.op === "delete").map((c) => c.endpoint)).toEqual([
      "https://push.example.com/send/gone",
    ])
  })

  it("reports a subscription it could not delete instead of throwing", async () => {
    const { sender } = await build([await subscription("a")], answering(410), {
      failDelete: true,
    })
    const result = await sender.send(USER, MESSAGE)
    expect(result.success).toBe(false)
    expect(result.deliveries[0].deleted).toBe(false)
  })

  it("does not follow a redirect to a private address and keeps the subscription", async () => {
    const { sender, requests, calls } = await build(
      [await subscription("a")],
      () => new Response("", { status: 307, headers: { Location: "http://127.0.0.1:8080/x" } }),
    )
    const result = await sender.send(USER, MESSAGE)
    expect(requests).toHaveLength(1)
    expect(result.deliveries[0]).toMatchObject({ status: "failed", httpStatus: 307 })
    expect(result.error).toBe("HTTP 307 (redirect not followed)")
    expect(calls.filter((c) => c.op === "delete")).toEqual([])
  })

  it("aborts the request when the timeout passes and keeps the subscription", async () => {
    let signal: AbortSignal | null | undefined
    const { sender, calls } = await build(
      [await subscription("a")],
      (request) => {
        signal = request.init.signal
        return new Promise<Response>((_, reject) =>
          signal?.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))
        ) as unknown as Response
      },
      { requestTimeoutMs: 20 },
    )
    const result = await within(sender.send(USER, MESSAGE), 2_000)
    expect(signal?.aborted).toBe(true)
    expect(result.error).toBe("request timed out after 20 ms")
    expect(calls.filter((c) => c.op === "delete")).toEqual([])
  })

  it("gives up on a stalled DNS lookup within the timeout without sending", async () => {
    const stalled: DnsResolver = { resolve: () => new Promise(() => {}) }
    const { sender, requests } = await build([await subscription("a")], answering(201), {
      requestTimeoutMs: 20,
      resolver: stalled,
    })
    const result = await within(sender.send(USER, MESSAGE), 2_000)
    expect(result.error).toBe("request timed out after 20 ms")
    expect(requests).toEqual([])
  })

  it("closes the response body so the connection is released", async () => {
    let cancelled = false
    const body = new ReadableStream({
      start: (controller) => controller.enqueue(new Uint8Array(4)),
      cancel: () => {
        cancelled = true
      },
    })
    const { sender } = await build(
      [await subscription("a")],
      () => new Response(body, { status: 503 }),
    )
    await sender.send(USER, MESSAGE)
    expect(cancelled).toBe(true)
  })

  it("rejects an invalid payload without sending", async () => {
    const { sender, requests } = await build([await subscription("a")], answering(201))
    const result = await sender.send(USER, { title: "", body: null, url: null })
    expect(result.success).toBe(false)
    expect(result.error).toContain("invalid push payload")
    expect(requests).toEqual([])
  })

  it("refuses an endpoint that is not public HTTPS and never contacts it", async () => {
    const bad = { ...(await subscription("a")), endpoint: "http://169.254.169.254/x" }
    const { sender, requests, calls } = await build([bad], answering(201))
    const result = await sender.send(USER, MESSAGE)
    expect(result.deliveries[0].status).toBe("failed")
    expect(requests).toEqual([])
    expect(calls.filter((c) => c.op === "delete")).toEqual([])
  })

  it("reports malformed subscription keys as such, keeps the subscription and sends nothing", async () => {
    const bad = { ...(await subscription("a")), keys: { auth: "!", p256dh: "AAAA" } }
    const { sender, requests, calls } = await build([bad], answering(201))
    const result = await sender.send(USER, MESSAGE)
    expect(result.error).toBe("malformed subscription keys or endpoint")
    expect(requests).toEqual([])
    expect(calls.filter((c) => c.op === "delete")).toEqual([])
  })

  it("never puts an endpoint in the error text", async () => {
    const { sender } = await build([await subscription("secret-token")], () => {
      throw new Error("failed https://push.example.com/send/secret-token")
    })
    const result = await sender.send(USER, MESSAGE)
    expect(result.error).not.toContain("secret-token")
    expect(result.output).not.toContain("secret-token")
  })

  it("returns a failure instead of throwing when the store fails", async () => {
    const sender = await createWebPushSender({
      vapidKeys: (await generateVapidKeyPair()).keys,
      subject: "mailto:ops@example.com",
      store: {
        listByUser: () => Promise.reject(new Error("db down")),
        deleteByEndpoint: () => Promise.resolve(),
      },
      fetch: fakeFetch(answering(201)).fetcher,
    })
    const result = await sender.send(USER, MESSAGE)
    expect(result.success).toBe(false)
  })

  it("throws at construction on an empty subject", async () => {
    await expect(createWebPushSender({
      vapidKeys: (await generateVapidKeyPair()).keys,
      subject: " ",
      store: fakeStore([]).store,
    })).rejects.toThrow("subject")
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
  })

  it("generates a different pair each time", async () => {
    expect((await generateVapidKeyPair()).publicKey).not.toBe(
      (await generateVapidKeyPair()).publicKey,
    )
  })
})
