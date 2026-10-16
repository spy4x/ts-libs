import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { denoServeRemoteAddr } from "@spy4x/platform/rate-limit/hono"
import {
  createProxyPeers,
  FORWARDED_HEADERS,
  PROXY_ADDRESS_MAX_AGE_MS,
  PROXY_LOOKUP_RETRY_MS,
  requireProxyForForwardedHeaders,
} from "./trusted-proxy.ts"

const TRAEFIK = "172.18.0.2"
const RECREATED = "172.18.0.3"
const NEIGHBOUR = "172.18.0.9"

type Answer = string[] | Error | `hang`

/**
 * A resolver that answers from `table` and counts its lookups. `"hang"` never answers, like a
 * resolver whose upstream DNS is down.
 */
function fakeResolver(table: Record<string, Answer>) {
  const lookups: string[] = []
  return {
    lookups,
    resolve(name: string): Promise<string[]> {
      lookups.push(name)
      const answer = table[name]
      if (answer === `hang`) return new Promise(() => {})
      if (answer instanceof Error) return Promise.reject(answer)
      return Promise.resolve(answer ?? [])
    },
  }
}

/** A clock the test moves by hand. */
function fakeClock() {
  let time = 1_000_000
  return { now: () => time, advance: (ms: number) => time += ms }
}

/** Lets a background lookup that the fake resolver answers at once finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("createProxyPeers", () => {
  it("trusts the address a proxy's name resolves to, and no other", async () => {
    const resolver = fakeResolver({ traefik: [TRAEFIK] })
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver })

    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    expect(await isProxy(undefined)).toBe(false)
    expect(await isProxy("not an address")).toBe(false)
  })

  it("trusts an IP address in the list without a lookup, in any spelling", async () => {
    const resolver = fakeResolver({})
    const isProxy = createProxyPeers({
      hosts: ["127.0.0.1", "0:0:0:0:0:0:0:1", " ::FFFF:192.0.2.5 "],
      resolver,
    })

    expect(await isProxy("::ffff:127.0.0.1")).toBe(true)
    expect(await isProxy("::1")).toBe(true)
    expect(await isProxy("192.0.2.5")).toBe(true)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    expect(resolver.lookups).toEqual([])
  })

  it("stops trusting a proxy's old address once it is looked up again", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const isProxy = createProxyPeers({
      hosts: ["traefik"],
      resolver: fakeResolver(table),
      ...clock,
    })
    expect(await isProxy(TRAEFIK)).toBe(true)

    // Traefik is recreated at a new address, and its old one goes to another container.
    table.traefik = [RECREATED]
    clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    await isProxy(TRAEFIK) // starts the lookup
    await settle()

    expect(await isProxy(TRAEFIK)).toBe(false)
    expect(await isProxy(RECREATED)).toBe(true)
  })

  it("looks up again for an unknown peer, at most once a second", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = [RECREATED]
    expect(await isProxy(RECREATED)).toBe(false)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    await settle()
    expect(resolver.lookups).toEqual([`traefik`])

    clock.advance(PROXY_LOOKUP_RETRY_MS)
    expect(await isProxy(RECREATED)).toBe(false) // answered before its lookup ends
    await settle()
    expect(await isProxy(RECREATED)).toBe(true)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
    // A known address starts no lookup before the addresses grow old.
    expect(await isProxy(RECREATED)).toBe(true)
    await settle()
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("answers from the known addresses while a lookup hangs", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = `hang`
    clock.advance(PROXY_ADDRESS_MAX_AGE_MS)

    // Each call settles on its own: none of them waits for the lookup that never ends.
    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    expect(await isProxy(TRAEFIK)).toBe(true)
    // One lookup at a time: the hung one is not started again.
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("keeps a name's last addresses when a lookup fails, and reports the failure", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const errors: string[] = []
    const isProxy = createProxyPeers({
      hosts: ["traefik"],
      resolver: fakeResolver(table),
      ...clock,
      onError: (host) => errors.push(host),
    })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = new Error("SERVFAIL")
    clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    await isProxy(TRAEFIK)
    await settle()

    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(errors).toEqual(["traefik"])
  })

  it("keeps the last addresses when the failure reporter itself throws", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({
      hosts: ["traefik"],
      resolver,
      ...clock,
      onError: () => {
        throw new Error("logger down")
      },
    })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = new Error("SERVFAIL")
    clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    await isProxy(TRAEFIK)
    await settle()
    expect(await isProxy(TRAEFIK)).toBe(true)

    // The failed lookup finished, so the next one can start once the retry time has passed.
    table.traefik = [RECREATED]
    clock.advance(PROXY_LOOKUP_RETRY_MS)
    await isProxy(RECREATED)
    await settle()
    expect(await isProxy(RECREATED)).toBe(true)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`, `traefik`])
  })

  it("trusts every name in the list, and nothing for a name that does not resolve", async () => {
    const resolver = fakeResolver({ traefik: [TRAEFIK], "app-mpa": ["172.18.0.4"] })
    const isProxy = createProxyPeers({ hosts: ["traefik", "app-mpa", "gone"], resolver })

    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(await isProxy("172.18.0.4")).toBe(true)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
  })
})

describe("requireProxyForForwardedHeaders", () => {
  /** The check in front of a route that answers 200, with Traefik at {@link TRAEFIK}. */
  function buildApp(message?: string) {
    const isProxy = createProxyPeers({
      hosts: ["traefik"],
      resolver: fakeResolver({ traefik: [TRAEFIK] }),
    })
    const app = new Hono()
    app.use(
      "*",
      requireProxyForForwardedHeaders(isProxy, { remoteAddr: denoServeRemoteAddr, message }),
    )
    app.all("*", (c) => c.text("reached"))
    return app
  }

  /** The response to a request with `headers`, from a connection whose other end is `peer`. */
  function requestFrom(peer: string, headers: Record<string, string> = {}, message?: string) {
    const env = { remoteAddr: { transport: "tcp", hostname: peer, port: 40000 } }
    return buildApp(message).request("http://api.test/api/auth/password/check", { headers }, env)
  }

  it("refuses a forged client address from a container beside the proxy", async () => {
    for (const name of FORWARDED_HEADERS) {
      const response = await requestFrom(NEIGHBOUR, { [name]: "192.0.2.1" })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({
        error: "Forwarded headers are accepted from the proxy only",
      })
    }
  })

  it("passes the proxy's client address, and a neighbour that names no client", async () => {
    expect((await requestFrom(TRAEFIK, { "x-real-ip": "192.0.2.1" })).status).toBe(200)
    expect((await requestFrom(NEIGHBOUR)).status).toBe(200)
  })

  it("refuses a forwarded header on a request with no peer address", async () => {
    const response = await buildApp().request("http://api.test/api/health", {
      headers: { "x-real-ip": "192.0.2.1" },
    })
    expect(response.status).toBe(403)
  })

  it("words the refusal with the message it is given", async () => {
    const response = await requestFrom(NEIGHBOUR, { "x-real-ip": "192.0.2.1" }, "Nope")
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "Nope" })
  })

  it("refuses to build without a peer address resolver or with an empty message", () => {
    const isProxy = createProxyPeers({ hosts: ["127.0.0.1"] })
    expect(() => requireProxyForForwardedHeaders(isProxy, {} as never)).toThrow(TypeError)
    expect(() =>
      requireProxyForForwardedHeaders(isProxy, { remoteAddr: denoServeRemoteAddr, message: " " })
    )
      .toThrow(TypeError)
  })
})
