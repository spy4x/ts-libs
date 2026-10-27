/**
 * The contact channels a website names: a messenger, a social profile, a phone number, an e-mail
 * address or a web page. One module checks the value a person typed, builds the link a page shows
 * and writes the structured data search engines read, so every site does all three the same way.
 *
 * - **A value is normalised, then checked.** {@link normalizeContactValue} trims what an operator
 *   typed, drops a leading `@`, takes the name out of a pasted profile link and strips the spaces
 *   and dashes of a phone number. {@link contactValueProblem} then says, in a sentence a person
 *   can act on, why the value is no value of its kind, or answers `null`. Store the normalised
 *   value.
 * - **A link is only ever built from a valid value.** {@link contactHref} throws on anything
 *   {@link contactValueProblem} refuses, so no page prints a `javascript:` address or one carrying
 *   credentials.
 * - **Profiles and numbers go to different places in structured data.** {@link contactJsonLd} puts
 *   a profile (Telegram, Instagram, Facebook, a web page) into `sameAs`, which says "this is the
 *   same organization". A phone number, a Zalo or WhatsApp number (both are messengers keyed by a
 *   phone number) and an e-mail address are ways to reach it, not identities, so they go into
 *   `telephone`, `email` and `contactPoint`, never `sameAs`.
 *
 * @module
 */

import { type Type, type } from "arktype"
import { parseBareAddress } from "@spy4x/email/address"
import { isEmailAddress } from "../validation/predicates.ts"

/** Every kind of contact channel, in the order a form offers them. */
export const CONTACT_KINDS = [
  "telegram",
  "zalo",
  "whatsapp",
  "instagram",
  "facebook",
  "phone",
  "email",
  "url",
] as const

/** One kind of contact channel. */
export type ContactKind = typeof CONTACT_KINDS[number]

/** The arktype type of a {@link ContactKind}, for a request body. */
export const contactKind: Type<ContactKind> = type.enumerated(...CONTACT_KINDS)

/** Each kind's name as a person reads it, such as in a form's select or a link without a label. */
export const CONTACT_KIND_NAMES: Readonly<Record<ContactKind, string>> = {
  telegram: "Telegram",
  zalo: "Zalo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  facebook: "Facebook",
  phone: "Phone",
  email: "Email",
  url: "Website",
}

/** One contact channel: its kind and its normalised value. */
export interface ContactLink {
  kind: ContactKind
  value: string
}

/** The longest web page address {@link contactValueProblem} accepts. */
export const CONTACT_URL_MAX_LENGTH = 2000

/** The hosts a pasted profile link may name, per kind whose value is a name or a number. */
const PROFILE_HOSTS: Partial<Record<ContactKind, readonly string[]>> = {
  telegram: ["t.me", "telegram.me"],
  zalo: ["zalo.me"],
  whatsapp: ["wa.me"],
  instagram: ["instagram.com", "www.instagram.com"],
  facebook: ["facebook.com", "www.facebook.com", "m.facebook.com", "fb.com"],
}

/** Kinds whose value is a phone number, and so loses its spaces, dashes, dots and brackets. */
const NUMBER_KINDS: ReadonlySet<ContactKind> = new Set(["zalo", "whatsapp", "phone"])

/** The checks of each kind, each with the sentence a person reads when the value fails it. */
const RULES: Readonly<Record<ContactKind, { valid: Type<string>; problem: string }>> = {
  // Telegram: 5 to 32 letters, digits and underscores, starting with a letter, not ending in `_`.
  telegram: {
    valid: type(/^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/),
    problem: "Enter a Telegram username: 5 to 32 letters, digits and underscores, such as " +
      "my_shop.",
  },
  // Zalo opens a chat by the number its account was registered with, local or international.
  zalo: {
    valid: type(/^[0-9]{8,15}$/),
    problem: "Enter the phone number of the Zalo account, digits only, such as 0912345678.",
  },
  // wa.me takes the international number with no `+` and no leading zero.
  whatsapp: {
    valid: type(/^[1-9][0-9]{7,14}$/),
    problem: "Enter the WhatsApp number with its country code, digits only, such as 84912345678.",
  },
  // Instagram: up to 30 letters, digits, periods and underscores; no period first, last or twice.
  instagram: {
    valid: type(/^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._]{1,30}$/),
    problem: "Enter an Instagram username: up to 30 letters, digits, periods and underscores.",
  },
  // Facebook: a page or profile username, at least 5 letters, digits and periods. `profile.php`
  // is the page of a profile without one, which a pasted `profile.php?id=` link reduces to.
  facebook: {
    valid: type(/^(?!\.)(?!.*\.$)(?!profile\.php$)[A-Za-z0-9.]{5,50}$/),
    problem: "Enter a Facebook page username: 5 to 50 letters, digits and periods, such as " +
      "myshop.",
  },
  // A number to dial, local or with a `+` and its country code.
  phone: {
    valid: type(/^\+?[0-9]{6,15}$/),
    problem: "Enter a phone number of 6 to 15 digits, with + and the country code if it has " +
      "one, such as +84912345678.",
  },
  email: {
    valid: type("string").narrow(isEmailAddress),
    problem: "Enter an email address, such as hello@example.com.",
  },
  url: {
    valid: type("string").narrow(isHttpsPage),
    problem: "Enter a full https:// link, such as https://example.com.",
  },
}

/**
 * Whether `value` is an absolute `https:` address with a host and no user name or password, no
 * longer than {@link CONTACT_URL_MAX_LENGTH}: the only web page a contact link may open.
 */
function isHttpsPage(value: string): boolean {
  if (value.length > CONTACT_URL_MAX_LENGTH || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === "https:" && url.hostname !== "" && url.username === "" &&
    url.password === ""
}

/**
 * The first path segment of `input` when it is a link to one of `hosts`, such as `my_shop` from
 * `https://t.me/my_shop`, else `input` unchanged.
 */
function fromProfileLink(input: string, hosts: readonly string[]): string {
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`
  if (!URL.canParse(withScheme)) return input
  const url = new URL(withScheme)
  if (!hosts.includes(url.hostname)) return input
  return url.pathname.split("/").find((segment) => segment !== "") ?? input
}

/**
 * What an operator typed, in the form {@link contactValueProblem} checks and a store keeps:
 * trimmed; a profile link such as `https://t.me/my_shop` reduced to `my_shop`; a leading `@`
 * dropped; a phone number without spaces, dashes, dots and brackets (and, for Zalo and WhatsApp,
 * without its `+`); an e-mail address lowercased. It never makes an invalid value valid by
 * guessing, and it leaves a value it does not understand for {@link contactValueProblem} to refuse.
 */
export function normalizeContactValue(kind: ContactKind, input: string): string {
  let value = input.trim()
  const hosts = PROFILE_HOSTS[kind]
  if (hosts) value = fromProfileLink(value, hosts)
  if (kind === "telegram" || kind === "instagram" || kind === "facebook") {
    value = value.replace(/^@/, "")
  }
  if (NUMBER_KINDS.has(kind)) {
    value = value.replace(/[\s().-]/g, "")
    if (kind !== "phone") value = value.replace(/^\+/, "")
  }
  if (kind === "email") value = parseBareAddress(value) ?? value
  return value
}

/**
 * Why `value` is no {@link ContactKind} `kind`, as one sentence for the form field, or `null` when
 * it is one. Checks the value as given: normalise it first with {@link normalizeContactValue}.
 */
export function contactValueProblem(kind: ContactKind, value: string): string | null {
  const rule = RULES[kind]
  return rule.valid(value) instanceof type.errors ? rule.problem : null
}

/**
 * The link that opens the channel: `https://t.me/<username>`, `https://zalo.me/<digits>`,
 * `https://wa.me/<digits>`, the Instagram or Facebook profile, `tel:`, `mailto:`, or the web page
 * itself.
 *
 * @throws {TypeError} When {@link contactValueProblem} refuses `value`, so no unchecked text ever
 * becomes an `href`.
 */
export function contactHref(kind: ContactKind, value: string): string {
  const problem = contactValueProblem(kind, value)
  if (problem !== null) throw new TypeError(`Not a ${CONTACT_KIND_NAMES[kind]} value: ${problem}`)
  switch (kind) {
    case "telegram":
      return `https://t.me/${value}`
    case "zalo":
      return `https://zalo.me/${value}`
    case "whatsapp":
      return `https://wa.me/${value}`
    case "instagram":
      return `https://www.instagram.com/${value}/`
    case "facebook":
      return `https://www.facebook.com/${value}`
    case "phone":
      return `tel:${value}`
    case "email":
      return `mailto:${value}`
    case "url":
      return new URL(value).href
  }
}

/** A schema.org `ContactPoint`: one way to reach an organization. */
export interface ContactPointJsonLd {
  "@type": "ContactPoint"
  contactType: string
  /** The messenger's or channel's name, such as `Zalo`. */
  name: string
  telephone?: string
  email?: string
  /** The link that opens the chat, for a messenger. */
  url?: string
}

/** The contact properties of a schema.org `Organization`; a key with nothing to say is left out. */
export interface ContactJsonLd {
  /** Profiles of the same organization elsewhere: Telegram, Instagram, Facebook, web pages. */
  sameAs?: string[]
  /** The first phone number. */
  telephone?: string
  /** The first e-mail address. */
  email?: string
  /** Every phone number, Zalo and WhatsApp number and e-mail address, in the given order. */
  contactPoint?: ContactPointJsonLd[]
}

/**
 * The properties of a schema.org `Organization` that `links` describe, to spread into the node.
 * Telegram, Instagram, Facebook and web pages go into `sameAs`, each once. Phone numbers, Zalo and
 * WhatsApp numbers and e-mail addresses each become a `contactPoint`, the first phone number is
 * also `telephone` and the first address `email`; none of them is ever in `sameAs`, which names
 * identities, not ways to call.
 *
 * @param contactType The `contactType` of every contact point.
 * @throws {TypeError} When a link's value is not valid for its kind (see {@link contactHref}).
 */
export function contactJsonLd(
  links: readonly ContactLink[],
  contactType = "customer service",
): ContactJsonLd {
  const sameAs: string[] = []
  const contactPoint: ContactPointJsonLd[] = []
  const answer: ContactJsonLd = {}
  for (const { kind, value } of links) {
    const href = contactHref(kind, value)
    const name = CONTACT_KIND_NAMES[kind]
    switch (kind) {
      case "telegram":
      case "instagram":
      case "facebook":
      case "url":
        if (!sameAs.includes(href)) sameAs.push(href)
        break
      case "phone":
        answer.telephone ??= value
        contactPoint.push({ "@type": "ContactPoint", contactType, name, telephone: value })
        break
      case "zalo":
      case "whatsapp":
        contactPoint.push({
          "@type": "ContactPoint",
          contactType,
          name,
          telephone: kind === "whatsapp" ? `+${value}` : value,
          url: href,
        })
        break
      case "email":
        answer.email ??= value
        contactPoint.push({ "@type": "ContactPoint", contactType, name, email: value })
        break
    }
  }
  if (sameAs.length > 0) answer.sameAs = sameAs
  if (contactPoint.length > 0) answer.contactPoint = contactPoint
  return answer
}
