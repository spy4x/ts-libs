import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { normalizeUrlShape } from "./url-shape.ts"

describe("normalizeUrlShape", () => {
  it("leaves an already-normalised URL unchanged", () => {
    expect(normalizeUrlShape("https://example.com/path?q=1#frag")).toEqual({
      ok: true,
      url: "https://example.com/path?q=1#frag",
    })
  })

  it("adds https when the input carries no scheme", () => {
    expect(normalizeUrlShape("example.com/path")).toEqual({
      ok: true,
      url: "https://example.com/path",
    })
  })

  it("trims surrounding whitespace", () => {
    expect(normalizeUrlShape("  example.com  ")).toEqual({
      ok: true,
      url: "https://example.com",
    })
  })

  it("lowercases the scheme and the host but not the path", () => {
    expect(normalizeUrlShape("HTTPS://EXAMPLE.COM/Path")).toEqual({
      ok: true,
      url: "https://example.com/Path",
    })
  })

  it("strips the default port for the scheme", () => {
    expect(normalizeUrlShape("https://example.com:443/path")).toEqual({
      ok: true,
      url: "https://example.com/path",
    })
    expect(normalizeUrlShape("http://example.com:80/path")).toEqual({
      ok: true,
      url: "http://example.com/path",
    })
  })

  it("keeps a non-default port", () => {
    expect(normalizeUrlShape("https://example.com:8443/path")).toEqual({
      ok: true,
      url: "https://example.com:8443/path",
    })
  })

  it("accepts a scheme-less host with a port", () => {
    expect(normalizeUrlShape("example.com:8443")).toEqual({
      ok: true,
      url: "https://example.com:8443",
    })
    expect(normalizeUrlShape("example.com:8443/path")).toEqual({
      ok: true,
      url: "https://example.com:8443/path",
    })
  })

  it("drops the empty path the URL parser adds", () => {
    expect(normalizeUrlShape("example.com")).toEqual({ ok: true, url: "https://example.com" })
    expect(normalizeUrlShape("https://example.com")).toEqual({
      ok: true,
      url: "https://example.com",
    })
  })

  it("keeps a trailing slash that was typed", () => {
    expect(normalizeUrlShape("https://example.com/")).toEqual({
      ok: true,
      url: "https://example.com/",
    })
    expect(normalizeUrlShape("example.com/")).toEqual({ ok: true, url: "https://example.com/" })
  })

  it("preserves the query string and the fragment", () => {
    expect(normalizeUrlShape("example.com?a=1&b=2#section")).toEqual({
      ok: true,
      url: "https://example.com?a=1&b=2#section",
    })
  })

  it("preserves query and fragment case", () => {
    expect(normalizeUrlShape("https://example.com?Q=AbC#Frag")).toEqual({
      ok: true,
      url: "https://example.com?Q=AbC#Frag",
    })
  })

  it("does not mistake a slash in the query for a path", () => {
    expect(normalizeUrlShape("example.com?a=/b")).toEqual({
      ok: true,
      url: "https://example.com?a=/b",
    })
  })

  it("rejects an empty input", () => {
    expect(normalizeUrlShape("")).toEqual({
      ok: false,
      code: "empty",
      message: "Enter a URL",
    })
  })

  it("rejects a whitespace-only input", () => {
    expect(normalizeUrlShape("   ")).toEqual({
      ok: false,
      code: "empty",
      message: "Enter a URL",
    })
  })

  it("rejects a non-http(s) scheme", () => {
    expect(normalizeUrlShape("javascript:alert(1)")).toEqual({
      ok: false,
      code: "unsupported_protocol",
      message: "URL must start with http:// or https://",
    })
    expect(normalizeUrlShape("ftp://example.com")).toEqual({
      ok: false,
      code: "unsupported_protocol",
      message: "URL must start with http:// or https://",
    })
  })

  it("rejects unparseable input", () => {
    expect(normalizeUrlShape("https://")).toEqual({
      ok: false,
      code: "invalid_format",
      message: "Invalid URL format",
    })
    expect(normalizeUrlShape("https://example.com:99999/")).toEqual({
      ok: false,
      code: "invalid_format",
      message: "Invalid URL format",
    })
  })

  it("rejects embedded whitespace or control characters", () => {
    expect(normalizeUrlShape("https://exa mple.com")).toEqual({
      ok: false,
      code: "invalid_format",
      message: "URL contains invalid characters",
    })
    expect(normalizeUrlShape("https://exa\u0000mple.com")).toEqual({
      ok: false,
      code: "invalid_format",
      message: "URL contains invalid characters",
    })
  })

  it("rejects a hostname without a dot", () => {
    expect(normalizeUrlShape("localhost")).toEqual({
      ok: false,
      code: "invalid_hostname",
      message: "Invalid domain",
    })
    expect(normalizeUrlShape("https://localhost:8080/path")).toEqual({
      ok: false,
      code: "invalid_hostname",
      message: "Invalid domain",
    })
  })

  it("rejects a hostname with a leading or trailing dot", () => {
    expect(normalizeUrlShape("https://example.com.")).toEqual({
      ok: false,
      code: "invalid_hostname",
      message: "Invalid domain",
    })
  })
})
