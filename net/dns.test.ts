import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { type DnsHost, dnsResolverOver, type NodeDns } from "./_dns-host.ts"

/** An error shaped like Deno's `NotFound` or Node's coded DNS errors. */
const named = (name: string) => Object.assign(new Error(name), { name })
const coded = (code: string) => Object.assign(new Error(code), { code })

/** A `node:dns/promises` stand-in that answers from `records`, or throws `error`. */
function nodeDns(records: { a?: string[]; aaaa?: string[] }, error?: Error) {
  const calls: string[] = []
  const answer = (family: "a" | "aaaa", hostname: string) => {
    calls.push(`${family}:${hostname}`)
    return error ? Promise.reject(error) : Promise.resolve(records[family] ?? [])
  }
  const dns: NodeDns = {
    resolve4: (hostname) => answer("a", hostname),
    resolve6: (hostname) => answer("aaaa", hostname),
  }
  return { load: () => Promise.resolve(dns), calls }
}

describe("dnsResolverOver on Deno", () => {
  const denoHost = (resolveDns: NonNullable<DnsHost["Deno"]>["resolveDns"]): DnsHost => ({
    Deno: { resolveDns },
    process: {},
  })

  it("asks Deno.resolveDns for the type, and never loads node:dns", async () => {
    const node = nodeDns({ a: ["198.51.100.1"] })
    const resolve = dnsResolverOver(
      () => denoHost((hostname, type) => Promise.resolve([`${type}:${hostname}`])),
      node.load,
    )
    expect(await resolve("example.com", "AAAA")).toEqual(["AAAA:example.com"])
    expect(node.calls).toEqual([])
  })

  it("answers NotFound with an empty list and lets every other failure through", async () => {
    const failing = (error: Error) =>
      dnsResolverOver(() => denoHost(() => Promise.reject(error)), nodeDns({}).load)
    expect(await failing(named("NotFound"))("example.com", "A")).toEqual([])
    await expect(failing(named("TimedOut"))("example.com", "A")).rejects.toThrow("TimedOut")
  })
})

describe("dnsResolverOver on Node and Bun", () => {
  const nodeHost = (): DnsHost => ({ process: {} })

  it("looks A up with resolve4 and AAAA with resolve6", async () => {
    const node = nodeDns({ a: ["198.51.100.1"], aaaa: ["2001:db8::1"] })
    const resolve = dnsResolverOver(nodeHost, node.load)
    expect(await resolve("example.com", "A")).toEqual(["198.51.100.1"])
    expect(await resolve("example.com", "AAAA")).toEqual(["2001:db8::1"])
    expect(node.calls).toEqual(["a:example.com", "aaaa:example.com"])
  })

  it("answers no record (ENODATA) and no such name (ENOTFOUND) with an empty list", async () => {
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const resolve = dnsResolverOver(nodeHost, nodeDns({}, coded(code)).load)
      expect(await resolve("example.com", "A")).toEqual([])
    }
  })

  it("lets a server failure or a timeout through, so it is never read as no address", async () => {
    for (const code of ["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"]) {
      const resolve = dnsResolverOver(nodeHost, nodeDns({}, coded(code)).load)
      await expect(resolve("example.com", "A")).rejects.toThrow(code)
    }
  })
})

describe("dnsResolverOver elsewhere", () => {
  it("rejects on a runtime with neither Deno nor process", async () => {
    await expect(dnsResolverOver(() => ({}), nodeDns({}).load)("example.com", "A")).rejects
      .toThrow("unsupported runtime")
  })
})
