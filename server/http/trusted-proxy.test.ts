import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { Hono } from "hono"
import { denoServeRemoteAddr } from "@spy4x/platform/rate-limit/hono"
import {
  createProxyPeers,
  FORWARDED_HEADERS,
  PROXY_ADDRESS_HARD_MAX_AGE_MS,
  PROXY_ADDRESS_MAX_AGE_MS,
  PROXY_LOOKUP_DEADLINE_MS,
  PROXY_LOOKUP_RETRY_MS,
  requireProxyForForwardedHeaders,
} from "./trusted-proxy.ts"

const TRAEFIK = "172.18.0.2"
const RECREATED = "172.18.0.3"
const NEIGHBOUR = "172.18.0.9"

type Answer = string[] | Error | `hang` | Promise<string[]>

/**
 * A resolver that answers from `table` and counts its lookups. `"hang"` never answers, like a
 * resolver whose upstream DNS is down; a promise answers when the test settles it.
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
      if (answer instanceof Promise) return answer
      return Promise.resolve(answer ?? [])
    },
  }
}

/**
 * A clock and timers the test moves by hand. `advance` moves the time, fires every timer that came
 * due and lets the promises waiting on them run.
 */
function fakeClock() {
  let time = 1_000_000
  const timers = new Set<{ at: number; callback: () => void }>()
  return {
    now: () => time,
    setTimer(callback: () => void, ms: number) {
      const timer = { at: time + ms, callback }
      timers.add(timer)
      return () => timers.delete(timer)
    },
    async advance(ms: number) {
      time += ms
      for (const timer of [...timers]) {
        if (timer.at > time) continue
        timers.delete(timer)
        timer.callback()
      }
      await settle()
    },
    /** How many timers are still waiting. */
    pending: () => timers.size,
  }
}

/** Lets promises that are already answered, or that a timer just answered, run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise and whether it has settled yet. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined }
  promise.then((value) => {
    state.settled = true
    state.value = value
  })
  return state
}

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

  it("refuses a moved proxy's old address on the first call after the addresses grow old", async () => {
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
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)

    expect(await isProxy(TRAEFIK)).toBe(false)
    expect(await isProxy(RECREATED)).toBe(true)
  })

  it("trusts a recreated proxy's new address on its first request, after the awaited lookup", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = [RECREATED]
    await clock.advance(PROXY_LOOKUP_RETRY_MS)

    expect(await isProxy(RECREATED)).toBe(true)
    expect(await isProxy(TRAEFIK)).toBe(false)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("looks up again for an unknown peer at most once a second", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    expect(await isProxy(NEIGHBOUR)).toBe(false)
    await clock.advance(PROXY_LOOKUP_RETRY_MS - 1)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    expect(resolver.lookups).toEqual([`traefik`])

    await clock.advance(1)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
    // A known address starts no lookup before the addresses grow old.
    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("trusts none of a burst from a moved proxy's old address while DNS hangs an hour later", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    // Traefik moves, the app sits idle for an hour, and then the resolver stops answering.
    table.traefik = `hang`
    await clock.advance(60 * 60 * 1000)
    const burst = Array.from({ length: 500 }, () => isProxy(TRAEFIK))
    await clock.advance(PROXY_LOOKUP_DEADLINE_MS)

    expect((await Promise.all(burst)).filter(Boolean)).toEqual([])
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("shares one lookup between concurrent calls and answers them all from it", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    const slow = Promise.withResolvers<string[]>()
    table.traefik = slow.promise
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    const oldAddress = Array.from({ length: 50 }, () => track(isProxy(TRAEFIK)))
    const newAddress = Array.from({ length: 50 }, () => track(isProxy(RECREATED)))
    await clock.advance(PROXY_LOOKUP_DEADLINE_MS / 2)
    expect([...oldAddress, ...newAddress].some((call) => call.settled)).toBe(false)

    slow.resolve([RECREATED])
    await settle()
    expect(oldAddress.map((call) => call.value)).toEqual(Array(50).fill(false))
    expect(newAddress.map((call) => call.value)).toEqual(Array(50).fill(true))
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("makes a call wait for a hung lookup no longer than the deadline", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = `hang`
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    const call = track(isProxy(TRAEFIK))
    await clock.advance(PROXY_LOOKUP_DEADLINE_MS - 1)
    expect(call.settled).toBe(false)
    await clock.advance(1)
    expect(call).toEqual({ settled: true, value: true })

    // Later calls do not wait again on the lookup that is still hung, and start no second one.
    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(await isProxy(NEIGHBOUR)).toBe(false)
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(resolver.lookups).toEqual([`traefik`, `traefik`])
  })

  it("cancels the deadline timer once a lookup answers", async () => {
    const clock = fakeClock()
    const isProxy = createProxyPeers({
      hosts: ["traefik"],
      resolver: fakeResolver({ traefik: [TRAEFIK] }),
      ...clock,
    })

    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(clock.pending()).toBe(0)
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
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)

    expect(await isProxy(TRAEFIK)).toBe(true)
    expect(errors).toEqual(["traefik"])
  })

  it("refuses a name's last addresses once lookups have failed past the hard maximum", async () => {
    const table: Record<string, Answer> = { traefik: [TRAEFIK] }
    const clock = fakeClock()
    const resolver = fakeResolver(table)
    const isProxy = createProxyPeers({ hosts: ["traefik"], resolver, ...clock })
    expect(await isProxy(TRAEFIK)).toBe(true)

    table.traefik = new Error("SERVFAIL")
    await clock.advance(PROXY_ADDRESS_HARD_MAX_AGE_MS - 1)
    expect(await isProxy(TRAEFIK)).toBe(true)
    await clock.advance(1)
    expect(await isProxy(TRAEFIK)).toBe(false)

    // A lookup that succeeds again restores the trust.
    table.traefik = [TRAEFIK]
    await clock.advance(PROXY_LOOKUP_RETRY_MS)
    expect(await isProxy(TRAEFIK)).toBe(true)
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
    await clock.advance(PROXY_ADDRESS_MAX_AGE_MS)
    expect(await isProxy(TRAEFIK)).toBe(true)

    // The failed lookup finished, so the next one can start once the retry time has passed.
    table.traefik = [RECREATED]
    await clock.advance(PROXY_LOOKUP_RETRY_MS)
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
