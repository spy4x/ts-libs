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
 * - **A product's price is exact.** It arrives as a whole number in the currency's smallest unit
 *   and is written in that currency's own decimals, with no floating-point division.
 *
 * Each output format lives in a sibling module, re-exported here: `seo-canonical.ts`,
 * `seo-json-ld.ts`, `seo-product.ts`, `seo-xml.ts` (sitemap and RSS) and `seo-llms-txt.ts`.
 *
 * A page published in several languages lists every version in `alternates`, its own included, and
 * each version's entry repeats the same list. `sitemapXml` writes one
 * `<xhtml:link rel="alternate" hreflang="…" href="…"/>` per version and declares the `xhtml`
 * namespace only when some entry has one, so a sitemap without alternates is unchanged. `lang` is a
 * BCP 47 tag, written in its canonical form (`en-us` becomes `en-US`, and a deprecated code such as
 * `iw` becomes `he`), or `x-default` for the version shown to everyone else; any other value throws.
 *
 * ```ts
 * import { sitemapXml } from "@spy4x/platform/universal/seo"
 *
 * const alternates = [
 *   { lang: "vi", url: "https://shop.example/" },
 *   { lang: "en", url: "https://shop.example/en/" },
 *   { lang: "x-default", url: "https://shop.example/" },
 * ]
 * const xml = sitemapXml([
 *   { url: "https://shop.example/", alternates },
 *   { url: "https://shop.example/en/", alternates },
 * ])
 * ```
 *
 * @module
 */

export { canonicalUrl, normalizeCanonical } from "./seo-canonical.ts"
export {
  blogPostingJsonLd,
  breadcrumbItems,
  breadcrumbListJsonLd,
  faqPageJsonLd,
  itemListJsonLd,
  jsonLdText,
} from "./seo-json-ld.ts"
export type {
  BlogPost,
  BlogPostingJsonLd,
  BreadcrumbListItem,
  BreadcrumbListJsonLd,
  Crumb,
  FaqItem,
  FaqPageJsonLd,
  FaqQuestionJsonLd,
  ItemListJsonLd,
  JsonLdBlog,
  JsonLdPerson,
  JsonLdPersonNode,
} from "./seo-json-ld.ts"
export { productJsonLd } from "./seo-product.ts"
export type {
  OfferJsonLd,
  ProductGroupJsonLd,
  ProductJsonLd,
  ProductPage,
  ProductVariant,
} from "./seo-product.ts"
export { rssXml, sitemapXml } from "./seo-xml.ts"
export type { RssChannel, RssItem, SitemapAlternate, SitemapEntry } from "./seo-xml.ts"
export { llmsTxt } from "./seo-llms-txt.ts"
export type { LlmsTxtDocument, LlmsTxtLink, LlmsTxtSection } from "./seo-llms-txt.ts"
