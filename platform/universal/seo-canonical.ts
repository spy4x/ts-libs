/**
 * The canonical address of a page, normalised before it is published. Public through `./seo.ts`.
 *
 * @module
 */

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
export function webUrl(input: string, label: string, base?: URL): URL {
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
