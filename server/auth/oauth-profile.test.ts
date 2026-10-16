// The display fields of an OAuth profile: how a provider's name and picture are cleaned before an
// app shows or stores them.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import {
  cleanOAuthAvatarUrl,
  cleanOAuthName,
  cleanOAuthProfile,
  MAX_OAUTH_AVATAR_URL_LENGTH,
  MAX_OAUTH_NAME_LENGTH,
} from "./oauth-profile.ts"

describe("cleanOAuthName", () => {
  it("keeps an ordinary name, trimmed", () => {
    expect(cleanOAuthName("  Zoë O'Brien  ")).toBe("Zoë O'Brien")
  })

  it("keeps an emoji, which is a whole surrogate pair", () => {
    expect(cleanOAuthName("Ann \u{1F680}")).toBe("Ann \u{1F680}")
  })

  it("drops NUL and lone surrogates instead of refusing the name", () => {
    expect(cleanOAuthName("A\u0000n\ud800n\udc00")).toBe("Ann")
  })

  it("is undefined for a value that is not a string, or nothing but spaces and unstorable characters", () => {
    for (const value of [undefined, null, 7, {}, "", "   ", "\u0000\ud800"]) {
      expect(cleanOAuthName(value)).toBeUndefined()
    }
  })

  it("cuts a long name to the limit", () => {
    expect(MAX_OAUTH_NAME_LENGTH).toBe(200)
    expect(cleanOAuthName("a".repeat(201))).toBe("a".repeat(200))
    expect(cleanOAuthName("a".repeat(200))).toBe("a".repeat(200))
  })

  it("never leaves half a surrogate pair where the cut falls inside one", () => {
    const name = cleanOAuthName(`${"a".repeat(199)}\u{1F680}`)
    expect(name).toBe("a".repeat(199))
    expect(name?.isWellFormed()).toBe(true)
  })
})

describe("cleanOAuthAvatarUrl", () => {
  it("keeps an https: URL, normalised", () => {
    expect(cleanOAuthAvatarUrl("https://Avatars.test/u/1?v=4")).toBe("https://avatars.test/u/1?v=4")
  })

  it("drops a URL of any other scheme, a relative one, and a value that is not a string", () => {
    for (
      const value of [
        "http://avatars.test/a.png",
        "javascript:alert(1)",
        "data:image/png;base64,AA==",
        "//avatars.test/a.png",
        "/a.png",
        "not a url",
        "",
        undefined,
        42,
      ]
    ) {
      expect(cleanOAuthAvatarUrl(value)).toBeUndefined()
    }
  })

  it("drops a URL carrying a user name or password", () => {
    expect(cleanOAuthAvatarUrl("https://user@avatars.test/a.png")).toBeUndefined()
    expect(cleanOAuthAvatarUrl("https://user:pw@avatars.test/a.png")).toBeUndefined()
    expect(cleanOAuthAvatarUrl("https://:pw@avatars.test/a.png")).toBeUndefined()
  })

  it("drops a URL longer than the limit, before or after normalising", () => {
    const prefix = "https://avatars.test/"
    const atLimit = prefix + "a".repeat(MAX_OAUTH_AVATAR_URL_LENGTH - prefix.length)
    expect(cleanOAuthAvatarUrl(atLimit)).toBe(atLimit)
    expect(cleanOAuthAvatarUrl(`${atLimit}a`)).toBeUndefined()
    // A space becomes `%20`, three characters, so this grows past the limit only when normalised.
    const grows = prefix + " ".repeat(10) +
      "a".repeat(MAX_OAUTH_AVATAR_URL_LENGTH - prefix.length - 10)
    expect(grows.length).toBe(MAX_OAUTH_AVATAR_URL_LENGTH)
    expect(cleanOAuthAvatarUrl(grows)).toBeUndefined()
    // The default port is dropped when normalised, so this shrinks back under the limit; the value
    // as given is still too long.
    const shrinks = "https://avatars.test:443/" + "a".repeat(MAX_OAUTH_AVATAR_URL_LENGTH - 23)
    expect(shrinks.length).toBe(MAX_OAUTH_AVATAR_URL_LENGTH + 2)
    expect(new URL(shrinks).href.length).toBeLessThanOrEqual(MAX_OAUTH_AVATAR_URL_LENGTH)
    expect(cleanOAuthAvatarUrl(shrinks)).toBeUndefined()
  })
})

describe("cleanOAuthProfile", () => {
  it("cleans name and avatar URL, leaves out the ones that do not survive, and keeps the rest", () => {
    const profile = cleanOAuthProfile({
      subject: "s",
      email: "a@x.test",
      emailVerified: true,
      name: " Ann\u0000 ",
      avatarUrl: "http://avatars.test/a.png",
    })
    expect(profile).toEqual({ subject: "s", email: "a@x.test", emailVerified: true, name: "Ann" })
    expect("avatarUrl" in profile).toBe(false)
  })
})
