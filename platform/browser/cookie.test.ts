import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { getCookie } from "./cookie.ts"

function fakeDoc(cookie: string): Pick<Document, "cookie"> {
  return { cookie }
}

describe("getCookie", () => {
  it("does not match a differently-named cookie for a name containing '.'", () => {
    expect(getCookie("foo.bar", fakeDoc("fooXbar=nope"))).toBe(null)
  })

  it("reads back a cookie whose name contains '['", () => {
    expect(getCookie("foo[bar", fakeDoc("foo[bar=value"))).toBe("value")
  })

  it("keeps a value containing '=' whole", () => {
    expect(getCookie("token", fakeDoc("token=abc=def=="))).toBe("abc=def==")
  })

  it("returns null with no document and doc explicitly undefined", () => {
    const globalDocument = (globalThis as { document?: unknown }).document
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).document
    try {
      expect(getCookie("a", undefined)).toBe(null)
    } finally {
      if (globalDocument !== undefined) {
        ;(globalThis as { document?: unknown }).document = globalDocument
      }
    }
  })

  it("returns null for a missing name", () => {
    expect(getCookie("missing", fakeDoc("foo=bar; baz=qux"))).toBe(null)
  })

  it("throws on a malformed percent-escape", () => {
    expect(() => getCookie("bad", fakeDoc("bad=%E0%A4%A"))).toThrow(URIError)
  })

  it("tolerates a missing space between entries", () => {
    expect(getCookie("b", fakeDoc("a=1;b=2; c=3"))).toBe("2")
  })
})
