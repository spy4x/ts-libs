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
