// The "Fetcher" contract, written once and run against both implementations:
// "_fake-fetcher.contract.test.ts" runs it on the fake the net tests inject (unit tier) and
// "fetcher-contract.integration.test.ts" on the platform "fetch" against a loopback "Deno.serve"
// server. "safe-fetch.test.ts" scripts its hops with the fake, so a case the fake gets wrong here
// is a case those tests get wrong too.
//
// Not a test file in itself: it is named "*.test.ts" only so the root "publish.exclude" pattern
// keeps it out of the published package, and it registers no tests until a caller runs
// "describeFetcherContract".

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { ReceivedRequest, ResponseSpec } from "./_fake-fetcher.test.ts"
import type { Fetcher } from "./safe-fetch.ts"

/** A fetcher, the way to give it something to answer, and how to dispose of both. */
export interface FetcherFixture {
  fetcher: Fetcher
  /** Registers what "path" answers and returns the URL to request it by. */
  serve(path: string, spec: ResponseSpec): string
  /** Every request the other side has received, in order. */
  requests: ReceivedRequest[]
  close(): Promise<void>
}

/** Opens a fresh fixture for one case. */
export type OpenFetcher = () => Promise<FetcherFixture>

async function withFixture(
  open: OpenFetcher,
  body: (fixture: FetcherFixture) => Promise<void>,
): Promise<void> {
  const fixture = await open()
  try {
    await body(fixture)
  } finally {
    await fixture.close()
  }
}

const encoder = new TextEncoder()

/** Reads a stream to its end and returns the chunk sizes, in order. */
async function chunkSizes(response: Response): Promise<number[]> {
  const sizes: number[] = []
  const reader = response.body!.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return sizes
    sizes.push(value.byteLength)
  }
}

/** Registers the contract suite for one implementation. */
export function describeFetcherContract(name: string, open: OpenFetcher): void {
  describe(`${name} (fetcher contract)`, () => {
    it("answers with the status, headers and body it was given", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/page", {
          status: 201,
          headers: { "x-probe": "one", "content-type": "text/plain" },
          body: "hello",
        })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        expect(response.status).toBe(201)
        expect(response.headers.get("x-probe")).toBe("one")
        expect(response.headers.get("content-type")).toContain("text/plain")
        expect(await response.text()).toBe("hello")
      })
    })

    it("reports the URL it was asked for as response.url", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/where?q=1", { body: "x" })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        expect(response.url).toBe(url)
        await response.body?.cancel()
      })
    })

    it("returns a redirect as it is, with Location untouched, and does not follow it", async () => {
      await withFixture(open, async ({ fetcher, serve, requests }) => {
        serve("/target", { body: "landed" })
        const relative = serve("/relative", { status: 302, headers: { location: "/target" } })
        const absolute = serve("/absolute", {
          status: 307,
          headers: { location: "https://elsewhere.test/a?b=1" },
        })
        const first = await fetcher.fetch(relative, { redirect: "manual" })
        expect(first.status).toBe(302)
        expect(first.headers.get("location")).toBe("/target")
        expect(first.url).toBe(relative)
        await first.body?.cancel()
        const second = await fetcher.fetch(absolute, { redirect: "manual" })
        expect(second.status).toBe(307)
        expect(second.headers.get("location")).toBe("https://elsewhere.test/a?b=1")
        await second.body?.cancel()
        expect(requests.map((r) => r.path)).toEqual(["/relative", "/absolute"])
      })
    })

    it("sends the method and headers it was given, once per call", async () => {
      await withFixture(open, async ({ fetcher, serve, requests }) => {
        const url = serve("/echo", { body: "x" })
        const response = await fetcher.fetch(url, {
          redirect: "manual",
          method: "POST",
          headers: { "x-probe": "two" },
        })
        await response.body?.cancel()
        expect(requests.length).toBe(1)
        expect(requests[0].method).toBe("POST")
        expect(requests[0].headers["x-probe"]).toBe("two")
      })
    })

    it("delivers a streamed body whole, with every byte of every chunk", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const chunks = [encoder.encode("héllo "), encoder.encode("wörld")]
        const url = serve("/stream", { body: chunks })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        const bytes = new Uint8Array(await response.arrayBuffer())
        expect(bytes.byteLength).toBe(chunks[0].byteLength + chunks[1].byteLength)
        expect(new TextDecoder().decode(bytes)).toBe("héllo wörld")
      })
    })

    it("delivers a large body in full, however it is chunked", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const chunks = Array.from({ length: 8 }, () => new Uint8Array(32 * 1024).fill(7))
        const url = serve("/large", { body: chunks })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        const total = (await chunkSizes(response)).reduce((a, b) => a + b, 0)
        expect(total).toBe(8 * 32 * 1024)
      })
    })

    it("reads a response with no body as an empty text", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/empty", { status: 302, headers: { location: "/x" } })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        expect(await response.text()).toBe("")
      })
    })

    it("hands over the first chunk of a body that never finishes", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/stall", { body: [encoder.encode("first")], stall: true })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        const reader = response.body!.getReader()
        const { done, value } = await reader.read()
        expect(done).toBe(false)
        expect(new TextDecoder().decode(value)).toBe("first")
        await reader.cancel()
      })
    })

    it("lets an unread body be cancelled, twice", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/unread", { body: [encoder.encode("abc")], stall: true })
        const response = await fetcher.fetch(url, { redirect: "manual" })
        await response.body?.cancel()
        await response.body?.cancel()
      })
    })

    it("rejects with an AbortError when the signal is already aborted", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/early", { body: "x" })
        const controller = new AbortController()
        controller.abort()
        const error = await fetcher.fetch(url, { redirect: "manual", signal: controller.signal })
          .then(() => undefined, (e: unknown) => e)
        expect((error as Error | undefined)?.name).toBe("AbortError")
      })
    })

    it("rejects with an AbortError when the signal aborts before the response arrives", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/hang", { hang: true })
        const controller = new AbortController()
        const pending = fetcher.fetch(url, { redirect: "manual", signal: controller.signal })
          .then(() => undefined, (e: unknown) => e)
        setTimeout(() => controller.abort(), 20)
        expect(((await pending) as Error | undefined)?.name).toBe("AbortError")
      })
    })

    it("fails a body read with an AbortError when the signal aborts mid-body", async () => {
      await withFixture(open, async ({ fetcher, serve }) => {
        const url = serve("/stall-abort", { body: [encoder.encode("first")], stall: true })
        const controller = new AbortController()
        const response = await fetcher.fetch(url, { redirect: "manual", signal: controller.signal })
        const reader = response.body!.getReader()
        await reader.read()
        controller.abort()
        const error = await reader.read().then(() => undefined, (e: unknown) => e)
        expect((error as Error | undefined)?.name).toBe("AbortError")
      })
    })
  })
}
