import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { type } from "arktype"

import {
  CONTACT_KINDS,
  contactHref,
  contactJsonLd,
  type ContactKind,
  contactKind,
  contactValueProblem,
  normalizeContactValue,
} from "./contact.ts"

/** One valid value and two invalid ones per kind, as the form would hold them after normalising. */
const CASES: Record<ContactKind, { valid: string; invalid: [string, string] }> = {
  telegram: { valid: "my_shop", invalid: ["my shop", "shop"] },
  zalo: { valid: "0912345678", invalid: ["09123abc78", "1234"] },
  whatsapp: { valid: "84912345678", invalid: ["0912345678", "+84912345678"] },
  instagram: { valid: "my.shop_vn", invalid: ["my..shop", ".myshop"] },
  facebook: { valid: "myshop.vn", invalid: ["my_shop", "profile.php"] },
  phone: { valid: "+84912345678", invalid: ["+84 91234 abc", "12345"] },
  email: { valid: "hello@example.com", invalid: ["hello@", "hello example.com"] },
  url: {
    valid: "https://example.com/shop",
    invalid: ["http://example.com", "javascript:alert(1)"],
  },
}

describe("contactValueProblem", () => {
  for (const kind of CONTACT_KINDS) {
    it(`accepts a valid ${kind} value and refuses two invalid ones with a sentence`, () => {
      const { valid, invalid } = CASES[kind]
      expect(contactValueProblem(kind, valid)).toBeNull()
      for (const value of invalid) {
        const problem = contactValueProblem(kind, value)
        expect(problem).toMatch(/^Enter .+\.$/)
      }
    })
  }

  it("refuses a web page that carries a user name and password", () => {
    expect(contactValueProblem("url", "https://user:secret@example.com/")).not.toBeNull()
  })
})

describe("normalizeContactValue", () => {
  it("reduces a pasted profile link or an @handle to the username", () => {
    expect(normalizeContactValue("telegram", " https://t.me/my_shop ")).toBe("my_shop")
    expect(normalizeContactValue("telegram", "t.me/my_shop")).toBe("my_shop")
    expect(normalizeContactValue("telegram", "@my_shop")).toBe("my_shop")
    expect(normalizeContactValue("instagram", "https://www.instagram.com/my.shop/")).toBe("my.shop")
    expect(normalizeContactValue("facebook", "https://m.facebook.com/myshop.vn")).toBe("myshop.vn")
  })

  it("leaves a link to another host as typed, for the check to refuse", () => {
    const typed = "https://evil.example/my_shop"
    expect(normalizeContactValue("telegram", typed)).toBe(typed)
    expect(contactValueProblem("telegram", typed)).not.toBeNull()
  })

  it("strips a phone number's separators, and the + of a Zalo or WhatsApp number", () => {
    expect(normalizeContactValue("phone", "+84 (91) 234-56.78")).toBe("+84912345678")
    expect(normalizeContactValue("zalo", "091 234 5678")).toBe("0912345678")
    expect(normalizeContactValue("zalo", "+84 912 345 678")).toBe("84912345678")
    expect(normalizeContactValue("whatsapp", "+84 912 345 678")).toBe("84912345678")
    expect(normalizeContactValue("zalo", "https://zalo.me/0912345678")).toBe("0912345678")
  })

  it("lowercases an e-mail address and keeps a value it cannot read", () => {
    expect(normalizeContactValue("email", " Hello@Example.com ")).toBe("hello@example.com")
    expect(normalizeContactValue("email", "not an address")).toBe("not an address")
  })
})

describe("contactHref", () => {
  it("builds each kind's link", () => {
    expect(contactHref("telegram", "my_shop")).toBe("https://t.me/my_shop")
    expect(contactHref("zalo", "0912345678")).toBe("https://zalo.me/0912345678")
    expect(contactHref("whatsapp", "84912345678")).toBe("https://wa.me/84912345678")
    expect(contactHref("instagram", "my.shop")).toBe("https://www.instagram.com/my.shop/")
    expect(contactHref("facebook", "myshop.vn")).toBe("https://www.facebook.com/myshop.vn")
    expect(contactHref("phone", "+84912345678")).toBe("tel:+84912345678")
    expect(contactHref("email", "hello@example.com")).toBe("mailto:hello@example.com")
    expect(contactHref("url", "https://Example.com")).toBe("https://example.com/")
  })

  it("throws rather than build a javascript: or credential-bearing link", () => {
    expect(() => contactHref("url", "javascript:alert(1)")).toThrow(TypeError)
    expect(() => contactHref("url", "https://user:secret@example.com/")).toThrow(TypeError)
    expect(() => contactHref("telegram", "x/../../evil")).toThrow(TypeError)
  })
})

describe("contactJsonLd", () => {
  it("puts profiles into sameAs and phone, Zalo, WhatsApp and e-mail only into contact points", () => {
    const answer = contactJsonLd([
      { kind: "telegram", value: "my_shop" },
      { kind: "zalo", value: "0912345678" },
      { kind: "phone", value: "+84912345678" },
      { kind: "email", value: "hello@example.com" },
      { kind: "whatsapp", value: "84912345678" },
      { kind: "instagram", value: "my.shop" },
      { kind: "url", value: "https://example.com/" },
      { kind: "telegram", value: "my_shop" },
    ])
    expect(answer.sameAs).toEqual([
      "https://t.me/my_shop",
      "https://www.instagram.com/my.shop/",
      "https://example.com/",
    ])
    expect(answer.telephone).toBe("+84912345678")
    expect(answer.email).toBe("hello@example.com")
    expect(answer.contactPoint).toEqual([
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        name: "Zalo",
        telephone: "0912345678",
        url: "https://zalo.me/0912345678",
      },
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        name: "Phone",
        telephone: "+84912345678",
      },
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        name: "Email",
        email: "hello@example.com",
      },
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        name: "WhatsApp",
        telephone: "+84912345678",
        url: "https://wa.me/84912345678",
      },
    ])
  })

  it("answers no keys for no links", () => {
    expect(contactJsonLd([])).toEqual({})
  })

  it("throws on a link whose value is not valid for its kind", () => {
    expect(() => contactJsonLd([{ kind: "email", value: "nope" }])).toThrow(TypeError)
  })
})

describe("contactKind", () => {
  it("accepts every kind and refuses any other word", () => {
    for (const kind of CONTACT_KINDS) expect(contactKind(kind)).toBe(kind)
    expect(contactKind("skype")).toBeInstanceOf(type.errors)
  })
})
