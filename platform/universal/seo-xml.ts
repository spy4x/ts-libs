/**
 * The `sitemap.xml` and the RSS feed. Public through `./seo.ts`.
 *
 * @module
 */

import { webUrl } from "./seo-canonical.ts"

/** One page in a `sitemap.xml`. */
export interface SitemapEntry {
  /** Absolute `http`/`https` address of the page. */
  url: string
  /** When the page's content last changed. Omit it rather than guess: a wrong date is ignored. */
  lastmod?: Date
  /** Absolute `http`/`https` addresses of the images the page shows, such as product photos. */
  images?: readonly string[]
  /**
   * The page's language versions, written as `hreflang` links. List every version, this page's
   * own included, and give each version's entry the same list: search engines ignore a link that
   * the other page does not return.
   */
  alternates?: readonly SitemapAlternate[]
}

/** One language version of a page in a `sitemap.xml`. */
export interface SitemapAlternate {
  /** BCP 47 language tag of the version, such as `en` or `pt-BR`, or `x-default` for the fallback. */
  lang: string
  /** Absolute `http`/`https` address of the version. */
  url: string
}

/** The namespace of Google's image sitemap extension, declared once any entry lists an image. */
const SITEMAP_IMAGE_NS = "http://www.google.com/schemas/sitemap-image/1.1"

/** The XHTML namespace of the `hreflang` links, declared once any entry lists an alternate. */
const SITEMAP_XHTML_NS = "http://www.w3.org/1999/xhtml"

/**
 * The text of a `sitemap.xml` that lists `entries` in the order given.
 *
 * Only `loc`, `lastmod`, the language versions and the images are written: search engines ignore
 * `priority` and `changefreq`. Each address is normalised like a canonical one and XML-escaped;
 * `lastmod` is written as an ISO 8601 timestamp in UTC. An entry's `alternates` become
 * `xhtml:link rel="alternate"` elements, each language tag in its canonical form (`iw` becomes `he`), and its `images`
 * become `image:image` elements of Google's image extension. Each namespace is declared on `urlset`
 * only when an element of it is written.
 *
 * @example A page in English and Vietnamese
 * ```ts
 * const alternates = [
 *   { lang: "vi", url: "https://shop.example/" },
 *   { lang: "en", url: "https://shop.example/en/" },
 *   { lang: "x-default", url: "https://shop.example/" },
 * ]
 * sitemapXml([
 *   { url: "https://shop.example/", alternates },
 *   { url: "https://shop.example/en/", alternates },
 * ])
 * ```
 *
 * @throws When an address is not an absolute `http`/`https` URL, a `lastmod` is an invalid date, or
 * an alternate's `lang` is neither a BCP 47 language tag nor `x-default`.
 */
export function sitemapXml(entries: readonly SitemapEntry[]): string {
  let withImages = false
  let withAlternates = false
  const urls = entries.map(({ url, lastmod, images = [], alternates = [] }) => {
    let body = `    <loc>${escapeXml(webUrl(url, "sitemap url").href)}</loc>\n`
    if (lastmod !== undefined) {
      if (Number.isNaN(lastmod.getTime())) {
        throw new Error(`sitemap lastmod must be a valid date, received one for: ${url}`)
      }
      body += `    <lastmod>${lastmod.toISOString()}</lastmod>\n`
    }
    for (const alternate of alternates) {
      withAlternates = true
      const hreflang = escapeXml(hreflangTag(alternate.lang))
      const href = escapeXml(webUrl(alternate.url, "sitemap alternate").href)
      body += `    <xhtml:link rel="alternate" hreflang="${hreflang}" href="${href}"/>\n`
    }
    for (const image of images) {
      withImages = true
      const loc = escapeXml(webUrl(image, "sitemap image").href)
      body += `    <image:image>\n      <image:loc>${loc}</image:loc>\n    </image:image>\n`
    }
    return `  <url>\n${body}  </url>\n`
  })

  const imageNs = withImages ? ` xmlns:image="${SITEMAP_IMAGE_NS}"` : ""
  const xhtmlNs = withAlternates ? ` xmlns:xhtml="${SITEMAP_XHTML_NS}"` : ""
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${imageNs}${xhtmlNs}>\n` +
    `${urls.join("")}</urlset>\n`
}

/** `lang` in its canonical form (case fixed, deprecated codes replaced), or `x-default`; anything else is refused. */
function hreflangTag(lang: string): string {
  if (lang === "x-default") return lang
  try {
    const [tag] = Intl.getCanonicalLocales(lang)
    if (tag !== undefined) return tag
  } catch {
    // RangeError: not a BCP 47 tag; refused below with the value named.
  }
  throw new Error(`sitemap alternate lang must be a BCP 47 language tag, received: ${lang}`)
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

const XML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}
