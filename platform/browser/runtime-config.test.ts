import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type } from "arktype"
import { loadRuntimeConfig } from "./runtime-config.ts"

const schema = type({ "env?": "string", "dsn?": "string" }).onUndeclaredKey("delete")

function serving(body: string, status = 200) {
  const urls: string[] = []
  const inits: (RequestInit | undefined)[] = []
  const fetcher = ((url: string, init?: RequestInit) => {
    urls.push(url)
    inits.push(init)
    return Promise.resolve(new Response(body, { status }))
  }) as unknown as typeof fetch
  return { fetcher, urls, inits }
}

/** Runs `run` with `console.warn` captured, so a fallback's warning is checked, not printed. */
async function warned<T>(run: () => Promise<T>): Promise<{ result: T; warnings: unknown[][] }> {
  const original = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => void warnings.push(args)
  try {
    return { result: await run(), warnings }
  } finally {
    console.warn = original
  }
}

describe("loadRuntimeConfig", () => {
  it("returns the file's values, read from /config.json by default", async () => {
    const { fetcher, urls } = serving(`{"env":"stag","dsn":"https://k@t.example/1"}`)

    const config = await loadRuntimeConfig(schema, { fetcher, defaults: {} })

    expect(config).toEqual({ env: "stag", dsn: "https://k@t.example/1" })
    expect(urls).toEqual(["/config.json"])
  })

  it("reads the address the caller names", async () => {
    const { fetcher, urls } = serving(`{}`)

    await loadRuntimeConfig(schema, { url: "/app/settings.json", fetcher, defaults: {} })

    expect(urls).toEqual(["/app/settings.json"])
  })

  it("asks the network, not the browser's HTTP cache", async () => {
    const { fetcher, inits } = serving(`{}`)

    await loadRuntimeConfig(schema, { fetcher, defaults: {} })

    expect(inits[0]?.cache).toBe("no-store")
  })

  it("uses the global fetch when the caller passes none", async () => {
    const original = globalThis.fetch
    const { fetcher, urls } = serving(`{"env":"prod"}`)
    globalThis.fetch = fetcher
    try {
      expect(await loadRuntimeConfig(schema, { defaults: {} })).toEqual({ env: "prod" })
      expect(urls).toEqual(["/config.json"])
    } finally {
      globalThis.fetch = original
    }
  })

  it("drops keys a deleting schema does not name", async () => {
    const { fetcher } = serving(`{"env":"prod","secret":"x"}`)

    expect(await loadRuntimeConfig(schema, { fetcher, defaults: {} })).toEqual({ env: "prod" })
  })

  it("returns the defaults and warns once for a status other than 2xx", async () => {
    const { fetcher } = serving(`{"env":"prod"}`, 404)

    const { result, warnings } = await warned(() =>
      loadRuntimeConfig(schema, { fetcher, defaults: { env: "dev" } })
    )

    expect(result).toEqual({ env: "dev" })
    expect(warnings.length).toBe(1)
  })

  it("returns the defaults and warns once for a body that is not JSON", async () => {
    const { fetcher } = serving(`<html>`)

    const { result, warnings } = await warned(() =>
      loadRuntimeConfig(schema, { fetcher, defaults: { env: "dev" } })
    )

    expect(result).toEqual({ env: "dev" })
    expect(warnings.length).toBe(1)
  })

  it("returns the defaults and warns once for a file the schema rejects", async () => {
    const { fetcher } = serving(`{"env":5}`)

    const { result, warnings } = await warned(() =>
      loadRuntimeConfig(schema, { fetcher, defaults: { env: "dev" } })
    )

    expect(result).toEqual({ env: "dev" })
    expect(warnings.length).toBe(1)
  })

  it("returns the defaults and warns once when the network fails", async () => {
    const fetcher = (() => Promise.reject(new TypeError("offline"))) as unknown as typeof fetch

    const { result, warnings } = await warned(() =>
      loadRuntimeConfig(schema, { fetcher, defaults: { env: "dev" } })
    )

    expect(result).toEqual({ env: "dev" })
    expect(warnings.length).toBe(1)
  })

  it("falls back only when a required key is missing", async () => {
    const strict = type({ apiUrl: "string" })

    const ok = await loadRuntimeConfig(strict, {
      fetcher: serving(`{"apiUrl":"https://api.example"}`).fetcher,
      defaults: { apiUrl: "http://localhost" },
    })
    const { result: missing } = await warned(() =>
      loadRuntimeConfig(strict, {
        fetcher: serving(`{}`).fetcher,
        defaults: { apiUrl: "http://localhost" },
      })
    )

    expect(ok.apiUrl).toBe("https://api.example")
    expect(missing.apiUrl).toBe("http://localhost")
  })
})
