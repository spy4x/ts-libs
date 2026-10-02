import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { safeRedirectPath } from "./redirect-path.ts"

const OPTIONS = { fallback: "/notes", refuse: ["/api"] }

/** What `safeRedirectPath` answers for `value` with the options above. */
function next(value: string | null | undefined): string {
  return safeRedirectPath(value, OPTIONS)
}

describe("safeRedirectPath", () => {
  it("keeps a path on this origin with its query and hash", () => {
    expect(next("/notes/abc")).toBe("/notes/abc")
    expect(next("/groups?cursor=x%2Fy#top")).toBe("/groups?cursor=x%2Fy#top")
    expect(next("/")).toBe("/")
  })

  it("falls back when the value is missing or empty", () => {
    expect(next(null)).toBe("/notes")
    expect(next(undefined)).toBe("/notes")
    expect(next("")).toBe("/notes")
  })

  it("refuses a value that does not start with a slash", () => {
    expect(next("groups")).toBe("/notes")
    expect(next("evil.example")).toBe("/notes")
    expect(next(" /notes")).toBe("/notes")
  })

  it("refuses a protocol-relative value", () => {
    expect(next("//evil.example")).toBe("/notes")
    expect(next("///evil.example")).toBe("/notes")
  })

  it("refuses a value with a scheme", () => {
    expect(next("https://evil.example")).toBe("/notes")
    expect(next("javascript:alert(1)")).toBe("/notes")
    expect(next("data:text/html,hi")).toBe("/notes")
  })

  it("refuses a backslash anywhere", () => {
    expect(next("/\\evil.example")).toBe("/notes")
    expect(next("\\/evil.example")).toBe("/notes")
    expect(next("/notes\\abc")).toBe("/notes")
  })

  it("refuses a control character", () => {
    expect(next("/\t/evil.example")).toBe("/notes")
    expect(next("/\n/evil.example")).toBe("/notes")
    expect(next("/notes\u0000")).toBe("/notes")
    expect(next("/notes\u0085")).toBe("/notes")
  })

  it("refuses the percent-encoded forms of a slash pair, a backslash and a control character", () => {
    expect(next("/%2F%2Fevil.example")).toBe("/notes")
    expect(next("/%2f/evil.example")).toBe("/notes")
    expect(next("/%5Cevil.example")).toBe("/notes")
    expect(next("/%09/evil.example")).toBe("/notes")
    expect(next("/%252F%252Fevil.example")).toBe("/notes")
    expect(next("/%25255Cevil.example")).toBe("/notes")
  })

  it("refuses percent encoding that does not decode", () => {
    expect(next("/notes%")).toBe("/notes")
    expect(next("/notes%E0%A4%A")).toBe("/notes")
  })

  it("refuses a value still encoded after the last decoding round", () => {
    expect(next("/%2525252525")).toBe("/notes")
  })

  it("refuses dot segments that resolve to a leading slash pair", () => {
    expect(next("/.//evil.example")).toBe("/notes")
    expect(next("/a/..//evil.example")).toBe("/notes")
  })

  it("refuses encoded dot segments that resolve to a leading slash pair once decoded", () => {
    expect(next("/.%2F/evil.example")).toBe("/notes")
    expect(next("/%2e%2e%2f%2fevil.example")).toBe("/notes")
  })

  it("refuses a refused path behind doubly encoded dot segments", () => {
    expect(next("/notes/%252e%252e/api/auth/me")).toBe("/notes")
  })

  it("refuses the same paths for a refused prefix written with a trailing slash", () => {
    const withSlash = { fallback: "/notes", refuse: ["/api/"] }
    expect(safeRedirectPath("/api", withSlash)).toBe("/notes")
    expect(safeRedirectPath("/api/auth/me", withSlash)).toBe("/notes")
    expect(safeRedirectPath("/apiary", withSlash)).toBe("/apiary")
  })

  it("resolves dot segments that stay on this origin", () => {
    expect(next("/notes/../groups")).toBe("/groups")
  })

  it("refuses a refused path and everything below it", () => {
    expect(next("/api")).toBe("/notes")
    expect(next("/api/")).toBe("/notes")
    expect(next("/api/auth/me")).toBe("/notes")
    expect(next("/api?x=1")).toBe("/notes")
  })

  it("refuses a refused path whatever its letter case, encoding or dot segments", () => {
    expect(next("/API/auth/me")).toBe("/notes")
    expect(next("/%61pi/auth/me")).toBe("/notes")
    expect(next("/notes/../api/auth/me")).toBe("/notes")
    expect(next("/notes/%2e%2e/api/auth/me")).toBe("/notes")
  })

  it("refuses an encoded slash or a refused path hidden in a segment that dot segments remove", () => {
    expect(next("/a%2Fb/../%61pi/x")).toBe("/notes")
    expect(next("/a%2Fb/../%2561pi/x")).toBe("/notes")
    expect(next("/a%2Fb/../%2Fevil.example")).toBe("/notes")
  })

  it("returns a path that passes the check again unchanged", () => {
    for (
      const value of ["/notes/1?x=1#h", "/notes/../groups", "/a%20b", "/a%2Fb/../%2Fevil.example"]
    ) {
      const once = next(value)
      expect(next(once)).toBe(once)
    }
  })

  it("keeps a path that only shares the first letters of a refused one", () => {
    expect(next("/apiary")).toBe("/apiary")
  })

  it("refuses nothing on this origin without a refuse list", () => {
    expect(safeRedirectPath("/api/x", { fallback: "/" })).toBe("/api/x")
  })
})
