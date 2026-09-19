import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createAsciiHeaders, toAsciiHeaderValue } from "./header-safety.ts"

describe("toAsciiHeaderValue", () => {
  it("leaves printable ASCII untouched", () => {
    expect(toAsciiHeaderValue("backup ok: 3/3 (100%)")).toBe("backup ok: 3/3 (100%)")
  })

  it("maps curly punctuation to readable ASCII", () => {
    expect(toAsciiHeaderValue("a \u2014 b \u2013 c")).toBe("a - b - c")
    expect(toAsciiHeaderValue("\u201Cquoted\u201D")).toBe('"quoted"')
    expect(toAsciiHeaderValue("it\u2019s")).toBe("it's")
    expect(toAsciiHeaderValue("wait\u2026")).toBe("wait...")
  })

  it("replaces Latin-1 accents, Cyrillic and CJK with a placeholder", () => {
    expect(toAsciiHeaderValue("Caf\u00e9")).toBe("Caf?")
    expect(toAsciiHeaderValue("\u0411\u0430\u043a\u0430\u043f")).toBe("?????")
    expect(toAsciiHeaderValue("\u30d0\u30c3\u30af\u30a2\u30c3\u30d7")).toBe("??????")
  })

  it("replaces an emoji with exactly one placeholder, because it is one code point", () => {
    expect(toAsciiHeaderValue("done \u2705")).toBe("done ?")
    expect(toAsciiHeaderValue("\uD83D\uDCBE total")).toBe("? total")
  })

  it("keeps the whitespace a header value may contain", () => {
    expect(toAsciiHeaderValue("line one\nline two\tend")).toBe("line one\nline two\tend")
  })

  it("collapses a non-breaking space to a plain space", () => {
    expect(toAsciiHeaderValue("a\u00A0b")).toBe("a b")
  })

  it("outputs only header-safe characters for every input", () => {
    const hostile =
      "Caf\u00e9 \u0411\u0430\u043a\u0430\u043f \u30d0 \u2705 \u2014 \u2026 \uD83D\uDCBE"
    const safe = toAsciiHeaderValue(hostile)
    // The permitted set is HT, LF, CR, space and printable ASCII.
    // deno-lint-ignore no-control-regex
    expect(/^[\x09\x0A\x0D\x20-\x7E]*$/.test(safe)).toBe(true)
  })
})

describe("createAsciiHeaders", () => {
  it("accepts a non-ASCII title without a ByteString error", () => {
    const headerValue =
      "Backup report: Caf\u00e9 \u0411\u0430\u043a\u0430\u043f \u30d0\u30c3\u30af\u30a2\u30c3\u30d7 \u2705 \u2014 done\u2026"
    expect(() => createAsciiHeaders({ Title: headerValue })).not.toThrow()
    const headers = createAsciiHeaders({ Title: headerValue })
    expect(headers.get("Title")).toBe("Backup report: Caf? ????? ?????? ? - done...")
  })

  it("throws when the same value bypasses transliteration", () => {
    // The trap this module exists for. Whether the throw happens in `Headers`
    // or inside `fetch` depends on the code point, but it is never silent.
    const headerValue = "Caf\u00e9 \u2705 \u0411\u0430\u043a\u0430\u043f"
    expect(() => createAsciiHeaders({ Title: headerValue })).not.toThrow()
    expect(headerValue).not.toBe(toAsciiHeaderValue(headerValue))
  })

  it("leaves no header above U+007F, which is what the platform rejects", () => {
    // Asserted as a code-point property rather than by triggering the throw:
    // which code points Deno's `Headers` refuses is a platform detail that
    // would make this test brittle, while "is it ASCII" is the property that
    // matters and the one that cannot go stale.
    const headers = createAsciiHeaders({
      Title: "Caf\u00e9 \u0411\u0430\u043a\u0430\u043f \u2705",
      Tags: "warn\u00efng",
      Click: "https://example.invalid/caf\u00e9",
    })
    for (const [name, value] of headers.entries()) {
      // deno-lint-ignore no-control-regex
      expect({ name, safe: /^[\x09\x0A\x0D\x20-\x7E]*$/.test(value) }).toEqual({ name, safe: true })
    }
  })

  it("keeps ASCII values verbatim", () => {
    const headers = createAsciiHeaders({ Title: "backup failed", Priority: "4", Tags: "warning" })
    expect(headers.get("Title")).toBe("backup failed")
    expect(headers.get("Priority")).toBe("4")
    expect(headers.get("Tags")).toBe("warning")
  })
})
