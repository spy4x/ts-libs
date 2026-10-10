import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import type { ApiResult } from "./api.ts"
import { createOfflineFetch, INVALID_REPLY_CODE } from "./offline-fetch.ts"

type Send = <T>(path: string, init?: RequestInit) => Promise<ApiResult<T>>

/** A `send` that answers from a queue: a value is an answer, an `Error` is "no answer". */
function script(...steps: Array<ApiResult<unknown> | Error>): Send {
  return (() => {
    const step = steps.shift()
    if (step === undefined) throw new Error("script ran out")
    return step instanceof Error ? Promise.reject(step) : Promise.resolve(step)
  }) as Send
}

const ok = (data: unknown): ApiResult<unknown> => ({ ok: true, status: 200, data })
const refused = (status: number, code?: string): ApiResult<unknown> => ({
  ok: false,
  status,
  error: { status, message: "no", ...(code ? { code } : {}) },
})
const down = () => new TypeError("Failed to fetch")

describe("createOfflineFetch", () => {
  it("reports offline and sets the flag when the request gets no answer", async () => {
    const api = createOfflineFetch({ send: script(down()) })

    const result = await api.fetch("/api/x")

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: { status: 0, message: "The server did not answer" },
      offline: true,
    })
    expect(api.requestFailed).toBe(true)
  })

  it("clears the flag when a later request is answered", async () => {
    const api = createOfflineFetch({ send: script(down(), ok({ a: 1 })) })

    await api.fetch("/api/x")
    const result = await api.fetch("/api/x")

    expect(result).toEqual({ ok: true, status: 200, data: { a: 1 } })
    expect(api.requestFailed).toBe(false)
  })

  it("treats an error status as an answer: not offline, flag cleared", async () => {
    const api = createOfflineFetch({ send: script(down(), refused(503, "caldav_unreachable")) })

    await api.fetch("/api/x")
    const result = await api.fetch("/api/x")

    expect(result).toEqual({
      ok: false,
      status: 503,
      error: { status: 503, message: "no", code: "caldav_unreachable" },
      offline: false,
    })
    expect(api.requestFailed).toBe(false)
  })

  it("returns the parsed body when it matches the schema", async () => {
    const api = createOfflineFetch({ send: script(ok({ id: 3 })) })

    const result = await api.fetch("/api/x", {}, type({ id: "number" }))

    expect(result).toEqual({ ok: true, status: 200, data: { id: 3 } })
  })

  it("answers a schema mismatch as an error result, not as offline, and clears the flag", async () => {
    const api = createOfflineFetch({ send: script(down(), ok({ id: "three" })) })

    await api.fetch("/api/x")
    const result = await api.fetch("/api/x", {}, type({ id: "number" }))

    expect(result).toEqual({
      ok: false,
      status: 200,
      error: {
        status: 200,
        message: "The server sent an unusable reply",
        code: INVALID_REPLY_CODE,
      },
      offline: false,
    })
    expect(api.requestFailed).toBe(false)
  })

  it("calls subscribers on change only, and not after unsubscribing", async () => {
    const api = createOfflineFetch({ send: script(ok(1), down(), down(), ok(2), down()) })
    const seen: boolean[] = []
    const stop = api.subscribe((failed) => seen.push(failed))

    await api.fetch("/a") // answered: still false
    await api.fetch("/a") // fails: true
    await api.fetch("/a") // fails again: no change
    await api.fetch("/a") // answered: false
    stop()
    await api.fetch("/a") // fails after unsubscribing

    expect(seen).toEqual([true, false])
    expect(api.requestFailed).toBe(true)
  })

  it("lets another transport set the flag through report", () => {
    const api = createOfflineFetch()
    const seen: boolean[] = []
    api.subscribe((failed) => seen.push(failed))

    api.report(true)
    api.report(true)
    api.report(false)

    expect(seen).toEqual([true, false])
  })

  it("rejects with the abort reason and leaves the flag alone when the caller aborts", async () => {
    const controller = new AbortController()
    controller.abort(new Error("stop"))
    const api = createOfflineFetch({ send: script(new DOMException("aborted", "AbortError")) })

    await expect(api.fetch("/api/x", { signal: controller.signal })).rejects.toThrow("stop")
    expect(api.requestFailed).toBe(false)
  })

  it("sends through apiFetch by default, so a rejecting fetch is offline", async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError("Failed to fetch"))) as typeof fetch
    try {
      const api = createOfflineFetch()
      const result = await api.fetch("/api/x")
      expect(result.ok === false && result.offline).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })
})
