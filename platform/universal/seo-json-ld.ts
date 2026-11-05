/**
 * schema.org JSON-LD for breadcrumbs, FAQ pages, blog posts and item lists, escaped for its `<script>`. Public through `./seo.ts`; product JSON-LD is in `./seo-product.ts`.
 *
 * @module
 */

import { canonicalUrl, webUrl } from "./seo-canonical.ts"

/** One entry in the breadcrumb trail a page declares. */
export interface Crumb {
  /** Visible name of the entry, exactly as it should appear. Never derived from the address. */
  name: string
  /**
   * Where the entry points. Absolute, or relative to the page's canonical address.
   *
   * The last entry normally omits it: a trail ends on the current page, whose address is the
   * canonical one.
   */
  href?: string
}

/** A schema.org `ListItem` as it appears inside a `BreadcrumbList`. */
export interface BreadcrumbListItem {
  "@type": "ListItem"
  position: number
  name: string
  item: string
}

/** A schema.org `BreadcrumbList` node. */
export interface BreadcrumbListJsonLd {
  "@type": "BreadcrumbList"
  "@id": string
  itemListElement: BreadcrumbListItem[]
}

/**
 * `itemListElement` for a schema.org `BreadcrumbList`, built from the crumbs the caller stated.
 *
 * Positions are 1-based and follow the array. Every `item` is an absolute address, because the
 * structured data has to stand alone in a search result: a crumb's `href` is resolved against the
 * canonical address and normalised the same way it is, and a crumb with no `href` — the last one,
 * the page itself — takes the canonical address.
 *
 * @param canonical Absolute address of the page the trail ends on.
 * @param crumbs The trail, root first, current page last.
 */
export function breadcrumbItems(
  canonical: string,
  crumbs: readonly Crumb[],
): BreadcrumbListItem[] {
  const base = canonicalUrl(canonical)

  return crumbs.map((crumb, index) => ({
    "@type": "ListItem",
    position: index + 1,
    name: crumb.name,
    item: crumb.href === undefined ? base.href : webUrl(crumb.href, "crumb href", base).href,
  }))
}

/**
 * The complete `BreadcrumbList` node, `@id`-anchored to the page it describes.
 *
 * The anchor is built from the normalised address, which is why it carries exactly one `#`: a
 * canonical address handed in with a fragment never yields `…#frag#breadcrumb`, an identifier no
 * other node could match.
 */
export function breadcrumbListJsonLd(
  canonical: string,
  crumbs: readonly Crumb[],
): BreadcrumbListJsonLd {
  const base = canonicalUrl(canonical)

  return {
    "@type": "BreadcrumbList",
    "@id": `${base.href}#breadcrumb`,
    itemListElement: breadcrumbItems(base.href, crumbs),
  }
}

/** One question and its answer, as a page shows them. */
export interface FaqItem {
  question: string
  /** The answer as plain text, the same words the page shows. */
  answerText: string
}

/** A schema.org `Question` inside an `FAQPage`. */
export interface FaqQuestionJsonLd {
  "@type": "Question"
  name: string
  acceptedAnswer: { "@type": "Answer"; text: string }
}

/** A schema.org `FAQPage` node. */
export interface FaqPageJsonLd {
  "@type": "FAQPage"
  mainEntity: FaqQuestionJsonLd[]
}

/**
 * The `FAQPage` node for the questions a page shows, in the order it shows them.
 *
 * Search engines expect the same questions and answers to be visible on the page, so pass the
 * list the page renders rather than a separate copy.
 */
export function faqPageJsonLd(items: readonly FaqItem[]): FaqPageJsonLd {
  return {
    "@type": "FAQPage",
    mainEntity: items.map(({ question, answerText }) => ({
      "@type": "Question",
      name: question,
      acceptedAnswer: { "@type": "Answer", text: answerText },
    })),
  }
}

/**
 * Serialise JSON-LD for a `<script>` body.
 *
 * `<`, `>` and `&` are escaped to `\u003c`, `\u003e` and `\u0026` (valid JSON, same string) so
 * a value containing `</script>`, `<!--` or an entity cannot close or alter the element it is
 * embedded in. U+2028 and U+2029 are escaped to `\u2028` and `\u2029` because older JavaScript
 * parsers treat them as line terminators inside a string.
 */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, jsonLdEscape)
}

/** The `\uXXXX` escape of one character `jsonLdText` must not emit raw. */
function jsonLdEscape(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
}

/** A person named as a post's author, or as its publisher. */
export interface JsonLdPerson {
  name: string
  /** Absolute `http`/`https` address of the person's page. */
  url?: string
  /** The `@id` of the person's node elsewhere on the site, such as `https://example.com/#person`. */
  id?: string
}

/** The blog a post belongs to, described in full so the post's page stands alone. */
export interface JsonLdBlog {
  /** The blog's `@id`, the same one its own page uses, such as `https://example.com/blog#blog`. */
  id: string
  name: string
  /** Absolute `http`/`https` address of the blog's index page. */
  url: string
}

/** What {@link blogPostingJsonLd} describes. */
export interface BlogPost {
  /** Canonical absolute address of the post. */
  url: string
  /** The post's title. */
  headline: string
  description: string
  /** Absolute or post-relative address of the post's main image; Google shows it in results. */
  image?: string | { url: string; width: number; height: number }
  datePublished: Date
  /** Defaults to `datePublished`. */
  dateModified?: Date
  author: JsonLdPerson
  /**
   * Who publishes the site: an `@id` reference to a node the page already has, or a full node.
   * Omitted, the post names no publisher.
   */
  publisher?: { id: string } | ({ type: "Person" | "Organization" } & JsonLdPerson)
  /** The post's topic or category, such as `"Engineering"`. */
  section?: string
  /** BCP 47 language tag, such as `en-US`. */
  inLanguage?: string
  /** Reading time in whole minutes, written as `timeRequired` (`PT5M`). */
  readingMinutes?: number
  /** The blog the post belongs to, written as `isPartOf`. */
  blog?: JsonLdBlog
}

/** A schema.org `Person` or `Organization` node, or a reference to one by `@id`. */
export interface JsonLdPersonNode {
  "@type"?: "Person" | "Organization"
  "@id"?: string
  name?: string
  url?: string
}

/** A schema.org `BlogPosting` node. */
export interface BlogPostingJsonLd {
  "@type": "BlogPosting"
  "@id": string
  headline: string
  description: string
  image?: string | { "@type": "ImageObject"; url: string; width: number; height: number }
  datePublished: string
  dateModified: string
  author: JsonLdPersonNode
  publisher?: JsonLdPersonNode
  mainEntityOfPage: { "@type": "WebPage"; "@id": string }
  articleSection?: string
  inLanguage?: string
  timeRequired?: string
  isPartOf?: { "@type": "Blog"; "@id": string; name: string; url: string }
}

/** The JSON-LD node of a person, every address normalised. */
export function personNode(
  person: JsonLdPerson,
  type: "Person" | "Organization",
  label: string,
): JsonLdPersonNode {
  return {
    "@type": type,
    ...(person.id === undefined ? {} : { "@id": nodeId(person.id, `${label} id`) }),
    name: person.name,
    ...(person.url === undefined ? {} : { url: webUrl(person.url, `${label} url`).href }),
  }
}

/**
 * An `@id` address: normalised like a canonical one, but keeping its fragment, because a node id
 * such as `https://example.com/#person` is told apart from the page by it.
 */
export function nodeId(input: string, label: string): string {
  return webUrl(input, label).href + new URL(input).hash
}

/** `date` as ISO 8601 in UTC, throwing a readable error when it is invalid. */
function isoDate(date: Date, label: string): string {
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`)
  return date.toISOString()
}

/**
 * The schema.org `BlogPosting` node for one post, with the fields Google reads for an article:
 * `headline`, `image`, `datePublished`, `dateModified`, `author` and `publisher`, plus
 * `mainEntityOfPage`, `articleSection`, `inLanguage`, `timeRequired` and `isPartOf`.
 *
 * Like the other nodes here it carries no `@context`: put it in a `@graph` with the page's other
 * nodes, or spread `{ "@context": "https://schema.org", ... }` around it, and print it with
 * {@link jsonLdText}. Its `@id` is the canonical address plus `#article`. Optional fields that are
 * not given are left out rather than written empty.
 *
 * @throws When an address is not an absolute `http`/`https` URL (the image may be relative to the
 *   post), a date is invalid, or `readingMinutes` is not a positive whole number.
 */
export function blogPostingJsonLd(post: BlogPost): BlogPostingJsonLd {
  const canonical = canonicalUrl(post.url).href
  const base = new URL(canonical)
  const published = isoDate(post.datePublished, "datePublished")
  if (
    post.readingMinutes !== undefined &&
    (!Number.isInteger(post.readingMinutes) || post.readingMinutes < 1)
  ) {
    throw new Error(
      `readingMinutes must be a positive whole number, received: ${post.readingMinutes}`,
    )
  }

  let image: BlogPostingJsonLd["image"]
  if (typeof post.image === "string") image = webUrl(post.image, "image", base).href
  else if (post.image !== undefined) {
    const { url, width, height } = post.image
    image = { "@type": "ImageObject", url: webUrl(url, "image", base).href, width, height }
  }

  let publisher: JsonLdPersonNode | undefined
  if (post.publisher !== undefined) {
    publisher = "type" in post.publisher
      ? personNode(post.publisher, post.publisher.type, "publisher")
      : { "@id": nodeId(post.publisher.id, "publisher id") }
  }

  return {
    "@type": "BlogPosting",
    "@id": `${canonical}#article`,
    headline: post.headline,
    description: post.description,
    ...(image === undefined ? {} : { image }),
    datePublished: published,
    dateModified: post.dateModified === undefined
      ? published
      : isoDate(post.dateModified, "dateModified"),
    author: personNode(post.author, "Person", "author"),
    ...(publisher === undefined ? {} : { publisher }),
    mainEntityOfPage: { "@type": "WebPage", "@id": canonical },
    ...(post.section === undefined ? {} : { articleSection: post.section }),
    ...(post.inLanguage === undefined ? {} : { inLanguage: post.inLanguage }),
    ...(post.readingMinutes === undefined ? {} : { timeRequired: `PT${post.readingMinutes}M` }),
    ...(post.blog === undefined ? {} : {
      isPartOf: {
        "@type": "Blog",
        "@id": nodeId(post.blog.id, "blog id"),
        name: post.blog.name,
        url: webUrl(post.blog.url, "blog url").href,
      },
    }),
  }
}

/** A schema.org `ItemList` of the items a category or catalog page links to. */
export interface ItemListJsonLd {
  "@type": "ItemList"
  "@id": string
  itemListElement: { "@type": "ListItem"; position: number; url: string }[]
}

/**
 * The `ItemList` node for a category or catalog page: one `ListItem` per item, with its 1-based
 * `position` and the absolute `url` of the item's own page, in the order the page shows them.
 * This is the summary-page shape Google reads for a list of items that each have a page.
 *
 * @param canonical Absolute address of the list page; the node's `@id` is it plus `#itemlist`.
 * @param urls The items' pages, absolute or relative to the list page.
 * @throws When an address is not an `http`/`https` URL.
 */
export function itemListJsonLd(canonical: string, urls: readonly string[]): ItemListJsonLd {
  const base = canonicalUrl(canonical)
  return {
    "@type": "ItemList",
    "@id": `${base.href}#itemlist`,
    itemListElement: urls.map((url, index) => ({
      "@type": "ListItem",
      position: index + 1,
      url: webUrl(url, "item list url", base).href,
    })),
  }
}
