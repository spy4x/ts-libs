/**
 * The canonical address, the structured data, the `sitemap.xml`, the RSS feed and the `llms.txt`
 * a server-rendered site publishes.
 *
 * - **A canonical address is normalised before it is published.** Search engines and social
 *   networks read it, so it is parsed, required to be `http` or `https`, and stripped of the parts
 *   that must never reach a page — a user name, a password and a fragment. Anything that is not a
 *   web address is refused rather than printed.
 * - **A breadcrumb trail is the caller's, never a guess.** Nothing here reads a path and invents a
 *   name for a segment of it. A route that wants a `BreadcrumbList` states its own crumbs.
 * - **JSON-LD is escaped for the `<script>` it goes into**, so a value containing `</script>` cannot
 *   end the element early.
 * - **Every address in a sitemap or an `llms.txt` is absolute and normalised** the same way a
 *   canonical address is, because both files are read on their own, away from any page.
 *
 * @module
 */

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
 * Parse an address that is going to be published, refusing anything that is not a web page.
 *
 * Three things are dropped rather than refused, because each is meaningless on a published
 * address and harmful in one: a user name and a password would print credentials into a page that
 * search engines and social networks read, and a fragment names a position inside a page rather
 * than a page. What survives is the origin, the path and the query, the three parts that identify
 * a page. `URL` normalises the rest for free — the host is lower-cased, a default port is dropped
 * and an origin with no path gains its `/`.
 *
 * @param input The address as the caller wrote it.
 * @param label What the address is, used in the error message.
 * @param base Resolves a relative address; omitted when the address must already be absolute.
 * @throws When the address does not parse, or its scheme is not `http` or `https`.
 */
function webUrl(input: string, label: string, base?: URL): URL {
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    throw new Error(`${label} must be an absolute URL, received: ${input}`)
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must be an http or https URL, received: ${input}`)
  }

  url.username = ""
  url.password = ""
  url.hash = ""
  return url
}

/**
 * Parse a canonical address into the normalised `URL` that will be published.
 *
 * Refusing rather than falling back is deliberate. A canonical address is the caller's own
 * arithmetic: a route built it out of an origin and a path, and if the result is
 * `javascript:alert(1)` or `/products/widgets` then the route is wrong, not the environment. The
 * alternatives are worse in a way nobody would notice: omitting the tag publishes a page with no
 * canonical address at all, and there is no origin to fall back to that would not be invented.
 *
 * @param canonical Absolute `http`/`https` address of the page.
 * @throws When it is relative, unparsable, or carries any other scheme.
 */
export function canonicalUrl(canonical: string): URL {
  return webUrl(canonical, "canonical")
}

/**
 * The canonical address as it should be published: one clean `http`/`https` address.
 *
 * `https://user:pw@ACME.Example:443/a/b?x=1#frag` becomes `https://acme.example/a/b?x=1`.
 */
export function normalizeCanonical(canonical: string): string {
  return canonicalUrl(canonical).href
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
 * canonical address handed in with a fragment used to produce `…#frag#breadcrumb`, an identifier
 * no other node could ever match.
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

/** One page in a `sitemap.xml`. */
export interface SitemapEntry {
  /** Absolute `http`/`https` address of the page. */
  url: string
  /** When the page's content last changed. Omit it rather than guess: a wrong date is ignored. */
  lastmod?: Date
}

/**
 * The text of a `sitemap.xml` that lists `entries` in the order given.
 *
 * Only `loc` and `lastmod` are written: search engines ignore `priority` and `changefreq`. Each
 * address is normalised like a canonical one and XML-escaped; `lastmod` is written as an ISO 8601
 * timestamp in UTC.
 *
 * @throws When an address is not an absolute `http`/`https` URL, or a `lastmod` is an invalid date.
 */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map(({ url, lastmod }) => {
    const loc = `    <loc>${escapeXml(webUrl(url, "sitemap url").href)}</loc>\n`
    if (lastmod === undefined) return `  <url>\n${loc}  </url>\n`
    if (Number.isNaN(lastmod.getTime())) {
      throw new Error(`sitemap lastmod must be a valid date, received one for: ${url}`)
    }
    return `  <url>\n${loc}    <lastmod>${lastmod.toISOString()}</lastmod>\n  </url>\n`
  })

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`
}

/** `value` safe inside an XML element body or a double- or single-quoted attribute. */
function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ENTITIES[char])
}

/**
 * Characters XML 1.0 forbids anywhere in a document, even escaped: C0 controls other than tab and
 * line breaks, and U+FFFE and U+FFFF. One of them in a feed makes every feed reader reject it.
 */
// deno-lint-ignore no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g

/** `value` escaped for XML, with the characters XML cannot hold removed. */
function xmlText(value: string): string {
  return escapeXml(value.replace(XML_FORBIDDEN, ""))
}

/** `value` as a CDATA section; a `]]>` inside it is split across two sections. */
function cdata(value: string): string {
  return `<![CDATA[${value.replace(XML_FORBIDDEN, "").replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
}

/** `date` as RFC 822 text in GMT, the form RSS 2.0 requires. */
function rssDate(date: Date, label: string): string {
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a valid date`)
  return date.toUTCString()
}

/** The feed itself: what an RSS reader shows as the source of the items. */
export interface RssChannel {
  /** Name of the feed, such as the blog's name. */
  title: string
  /** Absolute `http`/`https` address of the page the feed mirrors, such as `/blog`. */
  link: string
  /** One sentence on what the feed carries. */
  description: string
  /** Absolute `http`/`https` address the feed itself is served from, for `atom:link rel="self"`. */
  feedUrl: string
  /** Language of the items as a BCP 47 tag, such as `en` or `en-US`. */
  language?: string
  /** When the feed last changed. Defaults to the newest item's `pubDate`. */
  lastBuildDate?: Date
}

/** One post in an RSS feed. */
export interface RssItem {
  title: string
  /** Absolute `http`/`https` address of the post. Also its `guid`, marked as a permalink. */
  link: string
  /** Summary shown in the reader's list, as plain text. */
  description: string
  /** When the post was published. */
  pubDate: Date
  /** The whole post as HTML, written as `content:encoded` for readers that show full posts. */
  contentHtml?: string
}

/**
 * The text of an RSS 2.0 feed of `items`, in the order given.
 *
 * The channel carries an `atom:link rel="self"` to `feedUrl`, which feed validators ask for. Each
 * item's `guid` is its link, marked `isPermaLink="true"`. Text is XML-escaped and `contentHtml`
 * goes in a CDATA section; characters XML 1.0 cannot hold are removed from both, so one stray
 * control character in a post cannot break the whole feed. Every address is normalised like a
 * canonical one, and dates are written in GMT as RSS requires.
 *
 * @throws When an address is not an absolute `http`/`https` URL, or a date is invalid.
 */
export function rssXml(channel: RssChannel, items: readonly RssItem[]): string {
  const itemsXml = items.map((item) => {
    const link = xmlText(webUrl(item.link, "rss item link").href)
    const content = item.contentHtml === undefined
      ? ""
      : `      <content:encoded>${cdata(item.contentHtml)}</content:encoded>\n`
    return `    <item>\n` +
      `      <title>${xmlText(item.title)}</title>\n` +
      `      <link>${link}</link>\n` +
      `      <description>${xmlText(item.description)}</description>\n` +
      `      <pubDate>${rssDate(item.pubDate, `pubDate of ${item.link}`)}</pubDate>\n` +
      `      <guid isPermaLink="true">${link}</guid>\n` +
      content +
      `    </item>\n`
  })

  const newest = items.reduce<Date | undefined>(
    (latest, { pubDate }) => latest === undefined || pubDate > latest ? pubDate : latest,
    undefined,
  )
  const built = channel.lastBuildDate ?? newest
  const optional =
    (channel.language === undefined
      ? ""
      : `    <language>${xmlText(channel.language)}</language>\n`) +
    (built === undefined
      ? ""
      : `    <lastBuildDate>${rssDate(built, "lastBuildDate")}</lastBuildDate>\n`)

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" ` +
    `xmlns:content="http://purl.org/rss/1.0/modules/content/">\n` +
    `  <channel>\n` +
    `    <title>${xmlText(channel.title)}</title>\n` +
    `    <link>${xmlText(webUrl(channel.link, "rss channel link").href)}</link>\n` +
    `    <description>${xmlText(channel.description)}</description>\n` +
    optional +
    `    <atom:link href="${
      xmlText(webUrl(channel.feedUrl, "rss feedUrl").href)
    }" rel="self" type="application/rss+xml"/>\n` +
    itemsXml.join("") +
    `  </channel>\n` +
    `</rss>\n`
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
function personNode(
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
function nodeId(input: string, label: string): string {
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

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}

/** One link in an `llms.txt` section. */
export interface LlmsTxtLink {
  /** The link text. */
  title: string
  /** Absolute `http`/`https` address of the page. */
  url: string
  /** What a reader finds there, written after the link. */
  description?: string
}

/** One `## Section` of an `llms.txt` and its links. */
export interface LlmsTxtSection {
  title: string
  links: readonly LlmsTxtLink[]
}

/** What an `llms.txt` says: the site's name, a one-paragraph summary and its sections. */
export interface LlmsTxtDocument {
  title: string
  summary: string
  sections: readonly LlmsTxtSection[]
}

/**
 * The text of an `/llms.txt` in the format llmstxt.org describes: `# Title`, a `> summary` line,
 * then each section as a `## Section` heading followed by `- [Title](url): description` lines.
 *
 * Line breaks inside a title, summary or description become spaces, so a value cannot start a
 * heading or a list item of its own. `\`, `[` and `]` in a link text are backslash-escaped, and
 * every address is normalised like a canonical one with its parentheses percent-encoded, so neither
 * can end the link early.
 *
 * @throws When an address is not an absolute `http`/`https` URL.
 */
export function llmsTxt({ title, summary, sections }: LlmsTxtDocument): string {
  const blocks = [`# ${oneLine(title)}`, `> ${oneLine(summary)}`]

  for (const section of sections) {
    const links = section.links.map(({ title, url, description }) => {
      const href = webUrl(url, "llms.txt url").href.replace(
        /[()]/g,
        (paren) => paren === "(" ? "%28" : "%29",
      )
      const text = oneLine(title).replace(/[\\[\]]/g, "\\$&")
      const note = description === undefined ? "" : `: ${oneLine(description)}`
      return `- [${text}](${href})${note}`
    })
    blocks.push([`## ${oneLine(section.title)}`, ...links].join("\n"))
  }

  return `${blocks.join("\n\n")}\n`
}

/** `value` with every run of whitespace that holds a line break collapsed to one space. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]\s*/g, " ").trim()
}
