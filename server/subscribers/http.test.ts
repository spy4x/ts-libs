import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { TOKEN_PAGE_HEADERS, unsubscribeTokenFrom } from "./http.ts"

const URL_BASE = "https://example.com/unsubscribe"
const FORM = { "content-type": "application/x-www-form-urlencoded" }

describe("unsubscribeTokenFrom", () => {
  it("reads the token from the query string of a GET", async () => {
    expect(await unsubscribeTokenFrom(new Request(`${URL_BASE}?token=abc.def`))).toBe("abc.def")
  })

  it("prefers the query string over the body of a one-click POST", async () => {
    const request = new Request(`${URL_BASE}?token=from-query`, {
      method: "POST",
      headers: FORM,
      body: "List-Unsubscribe=One-Click&token=from-body",
    })
    expect(await unsubscribeTokenFrom(request)).toBe("from-query")
  })

  it("reads the token field of a form body", async () => {
    const request = new Request(URL_BASE, { method: "POST", headers: FORM, body: "token=abc.def" })
    expect(await unsubscribeTokenFrom(request)).toBe("abc.def")
  })

  it("answers null for a body over the cap", async () => {
    const body = `token=${"a".repeat(95)}` // 101 bytes
    const request = new Request(URL_BASE, { method: "POST", headers: FORM, body })
    expect(await unsubscribeTokenFrom(request, { maxBytes: 100 })).toBeNull()
  })

  it("caps the body at 4 KiB by default", async () => {
    const at = (size: number) =>
      new Request(URL_BASE, {
        method: "POST",
        headers: FORM,
        body: `token=${"a".repeat(size - 6)}`,
      })
    expect(await unsubscribeTokenFrom(at(4096))).toHaveLength(4090)
    expect(await unsubscribeTokenFrom(at(4097))).toBeNull()
  })

  it("answers null without a token anywhere, or a body without a content type", async () => {
    expect(await unsubscribeTokenFrom(new Request(URL_BASE))).toBeNull()
    expect(await unsubscribeTokenFrom(new Request(`${URL_BASE}?token=`))).toBeNull()
    const empty = new Request(URL_BASE, { method: "POST", headers: FORM, body: "token=" })
    expect(await unsubscribeTokenFrom(empty)).toBeNull()
    const untyped = new Request(URL_BASE, {
      method: "POST",
      body: new Blob(["token=abc"]),
    })
    expect(await unsubscribeTokenFrom(untyped)).toBeNull()
  })
})

describe("TOKEN_PAGE_HEADERS", () => {
  it("keeps token pages out of caches and the token out of the referrer", () => {
    expect(TOKEN_PAGE_HEADERS).toEqual({
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin",
    })
    expect(Object.isFrozen(TOKEN_PAGE_HEADERS)).toBe(true)
  })
})
