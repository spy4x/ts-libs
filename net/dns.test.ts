import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import {
  type DnsHost,
  dnsResolverOver,
  type NodeDns,
  rejoinSplitTxt,
  txtResolverOver,
} from "./_dns-host.ts"

/** An error shaped like Deno's `NotFound` or Node's coded DNS errors. */
const named = (name: string) => Object.assign(new Error(name), { name })
const coded = (code: string) => Object.assign(new Error(code), { code })

/** A `node:dns/promises` stand-in that answers from `records`, or throws `error`. */
function nodeDns(
  records: { a?: string[]; aaaa?: string[]; txt?: string[][] },
  error?: Error,
) {
  const calls: string[] = []
  const answer = <T>(family: "a" | "aaaa" | "txt", hostname: string): Promise<T> => {
    calls.push(`${family}:${hostname}`)
    return error ? Promise.reject(error) : Promise.resolve((records[family] ?? []) as T)
  }
  const dns: NodeDns = {
    resolve4: (hostname) => answer("a", hostname),
    resolve6: (hostname) => answer("aaaa", hostname),
    resolveTxt: (hostname) => answer("txt", hostname),
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

describe("txtResolverOver", () => {
  // A DKIM key published as two strings of one record, next to an unrelated record.
  const records = [["v=DKIM1; k=rsa; p=MIIB", "IjANBg"], ["google-site-verification=x"]]

  it("asks Deno.resolveDns for TXT and passes its records through unjoined", async () => {
    const asked: string[] = []
    const node = nodeDns({})
    const resolve = txtResolverOver(
      () => ({
        Deno: {
          resolveDns: (hostname, type) => {
            asked.push(`${type}:${hostname}`)
            return Promise.resolve(records)
          },
        },
        process: {},
      }),
      node.load,
    )
    expect(await resolve("sel._domainkey.example.com")).toEqual(records)
    expect(asked).toEqual(["TXT:sel._domainkey.example.com"])
    expect(node.calls).toEqual([])
  })

  it("looks TXT up with Node's resolveTxt, in the same shape as Deno's answer", async () => {
    const node = nodeDns({ txt: records })
    const resolve = txtResolverOver(() => ({ process: {} }), node.load)
    expect(await resolve("sel._domainkey.example.com")).toEqual(records)
    expect(node.calls).toEqual(["txt:sel._domainkey.example.com"])
  })

  it("joins on Bun the strings of one record that Bun answers as separate records", async () => {
    const head = "v=DKIM1; k=rsa; p=" + "A".repeat(237)
    const flattened = [[head], ["IDAQAB"], ["google-site-verification=x"]]
    const bun = txtResolverOver(
      () => ({ process: { versions: { bun: "1.4.4" } } }),
      nodeDns({ txt: flattened }).load,
    )
    const node = txtResolverOver(
      () => ({ process: { versions: {} } }),
      nodeDns({ txt: flattened }).load,
    )
    const joined = [[head, "IDAQAB"], ["google-site-verification=x"]]
    expect(await bun("sel._domainkey.example.com")).toEqual(joined)
    expect(await node("sel._domainkey.example.com")).toEqual(flattened)
  })

  it("leaves an answer whose records hold several strings, the shape Bun did not flatten", () => {
    expect(rejoinSplitTxt(records)).toEqual(records)
    const short = [["a"], ["b"]]
    expect(rejoinSplitTxt(short)).toEqual(short)
    expect(rejoinSplitTxt([])).toEqual([])
  })

  it("answers no TXT record with an empty list on every runtime, and lets a timeout through", async () => {
    const onDeno = txtResolverOver(
      () => ({ Deno: { resolveDns: () => Promise.reject(named("NotFound")) } }),
      nodeDns({}).load,
    )
    expect(await onDeno("example.com")).toEqual([])
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const onNode = txtResolverOver(() => ({ process: {} }), nodeDns({}, coded(code)).load)
      expect(await onNode("example.com")).toEqual([])
    }
    const timedOut = txtResolverOver(() => ({ process: {} }), nodeDns({}, coded("ETIMEOUT")).load)
    await expect(timedOut("example.com")).rejects.toThrow("ETIMEOUT")
  })
})

describe("a lookup's abort signal", () => {
  it("is handed to Deno.resolveDns", async () => {
    const signal = new AbortController().signal
    let seen: AbortSignal | undefined
    const resolve = dnsResolverOver(
      () => ({
        Deno: {
          resolveDns: (_hostname, _type, options) => {
            seen = options?.signal
            return Promise.resolve([])
          },
        },
      }),
      nodeDns({}).load,
    )
    await resolve("example.com", "A", { signal })
    expect(seen).toBe(signal)
  })

  it("stops the wait for Node's answer and rejects with the signal's reason", async () => {
    const hung: NodeDns = {
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
      resolveTxt: () => new Promise(() => {}),
    }
    const resolve = dnsResolverOver(() => ({ process: {} }), () => Promise.resolve(hung))
    const controller = new AbortController()
    const lookup = resolve("example.com", "A", { signal: controller.signal })
    controller.abort(new Error("no longer wanted"))
    await expect(lookup).rejects.toThrow("no longer wanted")
  })

  it("rejects at once when the signal has already aborted, before any lookup", async () => {
    const node = nodeDns({ a: ["198.51.100.1"] })
    const resolve = dnsResolverOver(() => ({ process: {} }), node.load)
    await expect(resolve("example.com", "A", { signal: AbortSignal.abort(new Error("gone")) }))
      .rejects.toThrow("gone")
    expect(node.calls).toEqual([])
  })
})
