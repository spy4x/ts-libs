/**
 * The canonical address and the structured data a server-rendered page publishes.
 *
 * - **A canonical address is normalised before it is published.** Search engines and social
 *   networks read it, so it is parsed, required to be `http` or `https`, and stripped of the parts
 *   that must never reach a page — a user name, a password and a fragment. Anything that is not a
 *   web address is refused rather than printed.
 * - **A breadcrumb trail is the caller's, never a guess.** Nothing here reads a path and invents a
 *   name for a segment of it. A route that wants a `BreadcrumbList` states its own crumbs.
 * - **JSON-LD is escaped for the `<script>` it goes into**, so a value containing `</script>` cannot
 *   end the element early.
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

/**
 * Serialise JSON-LD for a `<script>` body.
 *
 * `<` is escaped to `\u003c` (valid JSON, same string) so a description containing `</script>`
 * cannot close the element it is embedded in.
 */
export function jsonLdText(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c")
}
