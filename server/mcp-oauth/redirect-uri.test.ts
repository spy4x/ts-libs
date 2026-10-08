import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { assertRedirectAllowlist, CLAUDE_REDIRECT_URI, redirectUriMatches } from "./redirect-uri.ts"

describe("redirectUriMatches", () => {
  it("matches an https URI only character for character", () => {
    expect(redirectUriMatches(CLAUDE_REDIRECT_URI, CLAUDE_REDIRECT_URI)).toBe(true)
    expect(redirectUriMatches(`${CLAUDE_REDIRECT_URI}/`, CLAUDE_REDIRECT_URI)).toBe(false)
    expect(redirectUriMatches(`${CLAUDE_REDIRECT_URI}?x=1`, CLAUDE_REDIRECT_URI)).toBe(false)
    expect(redirectUriMatches("https://CLAUDE.ai/api/mcp/auth_callback", CLAUDE_REDIRECT_URI))
      .toBe(false)
    expect(redirectUriMatches("https://claude.ai:8443/api/mcp/auth_callback", CLAUDE_REDIRECT_URI))
      .toBe(false)
  })

  it("matches a loopback URI on any port", () => {
    expect(redirectUriMatches("http://localhost:3118/callback", "http://localhost/callback"))
      .toBe(true)
    expect(redirectUriMatches("http://127.0.0.1:50000/callback", "http://127.0.0.1/callback"))
      .toBe(true)
    expect(redirectUriMatches("http://[::1]:50000/callback", "http://[::1]/callback")).toBe(true)
  })

  it("keeps host, path and query fixed for a loopback URI", () => {
    const registered = "http://localhost/callback"
    expect(redirectUriMatches("http://127.0.0.1:3118/callback", registered)).toBe(false)
    expect(redirectUriMatches("http://localhost:3118/other", registered)).toBe(false)
    expect(redirectUriMatches("http://localhost:3118/callback?x=1", registered)).toBe(false)
    expect(redirectUriMatches("https://localhost:3118/callback", registered)).toBe(false)
  })

  it("never lets a non-loopback host or scheme borrow the loopback rule", () => {
    expect(redirectUriMatches("https://localhost:3118/callback", "http://localhost/callback"))
      .toBe(false)
    expect(
      redirectUriMatches(
        "http://localhost.evil.example:3118/callback",
        "http://localhost/callback",
      ),
    )
      .toBe(false)
    expect(
      redirectUriMatches("https://evil.example:3118/api/mcp/auth_callback", CLAUDE_REDIRECT_URI),
    )
      .toBe(false)
  })

  it("refuses a fragment or user info", () => {
    expect(redirectUriMatches(`${CLAUDE_REDIRECT_URI}#x`, CLAUDE_REDIRECT_URI)).toBe(false)
    expect(redirectUriMatches("http://a@localhost:1/callback", "http://localhost/callback"))
      .toBe(false)
    expect(redirectUriMatches("http://localhost:1/callback#x", "http://localhost/callback"))
      .toBe(false)
  })

  it("refuses text that is not a URL", () => {
    expect(redirectUriMatches("not a url", "not a url")).toBe(false)
  })
})

describe("assertRedirectAllowlist", () => {
  it("accepts https and loopback http", () => {
    expect(() => assertRedirectAllowlist([CLAUDE_REDIRECT_URI, "http://127.0.0.1/callback"]))
      .not.toThrow()
  })

  it("refuses http off loopback, a fragment and an empty list", () => {
    expect(() => assertRedirectAllowlist(["http://claude.example/cb"])).toThrow(TypeError)
    expect(() => assertRedirectAllowlist([`${CLAUDE_REDIRECT_URI}#x`])).toThrow(TypeError)
    expect(() => assertRedirectAllowlist([])).toThrow(TypeError)
  })
})
