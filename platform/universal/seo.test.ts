import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { parseXml, type XmlElement } from "@spy4x/caldav/xml"
import {
  blogPostingJsonLd,
  breadcrumbItems,
  breadcrumbListJsonLd,
  canonicalUrl,
  faqPageJsonLd,
  itemListJsonLd,
  jsonLdText,
  llmsTxt,
  normalizeCanonical,
  productJsonLd,
  type ProductPage,
  rssXml,
  sitemapXml,
} from "./seo.ts"

/** The trail a route states for `/products/widgets`, root first, current page last. */
const TRAIL = [
  { name: "Home", href: "/" },
  { name: "Products", href: "/products" },
  { name: "Widgets" },
]

describe("canonicalUrl", () => {
  it("throws a readable error for a relative canonical", () => {
    expect(() => canonicalUrl("/blog")).toThrow("canonical must be an absolute URL")
  })

  it("refuses a javascript: canonical", () => {
    expect(() => canonicalUrl("javascript:alert(1)")).toThrow(
      "canonical must be an http or https URL",
    )
  })

  it("refuses a data: canonical", () => {
    expect(() => canonicalUrl("data:text/html,hello")).toThrow(
      "canonical must be an http or https URL",
    )
  })

  it("refuses a scheme that is not the web, such as ftp", () => {
    expect(() => canonicalUrl("ftp://acme.example/file")).toThrow(
      "canonical must be an http or https URL",
    )
  })

  it("accepts a plain http canonical unchanged", () => {
    expect(canonicalUrl("http://acme.example/a").href).toBe("http://acme.example/a")
  })

  it("accepts a plain https canonical unchanged", () => {
    expect(canonicalUrl("https://acme.example/a").href).toBe("https://acme.example/a")
  })
})

describe("normalizeCanonical", () => {
  it("drops a user name and password", () => {
    expect(normalizeCanonical("https://user:pw@acme.example/a")).toBe("https://acme.example/a")
  })

  it("drops a user name that arrives without a password", () => {
    expect(normalizeCanonical("https://user@acme.example/a")).toBe("https://acme.example/a")
  })

  it("drops a fragment", () => {
    expect(normalizeCanonical("https://acme.example/a#reviews")).toBe("https://acme.example/a")
  })

  it("keeps the query string, which identifies the page", () => {
    expect(normalizeCanonical("https://acme.example/a?page=2")).toBe(
      "https://acme.example/a?page=2",
    )
  })

  it("drops the default port and keeps a non-default one", () => {
    expect(normalizeCanonical("https://acme.example:443/a")).toBe("https://acme.example/a")
    expect(normalizeCanonical("http://acme.example:8080/a")).toBe("http://acme.example:8080/a")
  })

  it("lower-cases the host and leaves the path's case alone", () => {
    expect(normalizeCanonical("https://ACME.Example/Products/Widgets")).toBe(
      "https://acme.example/Products/Widgets",
    )
  })

  it("gives an origin with no path its root slash", () => {
    expect(normalizeCanonical("https://acme.example")).toBe("https://acme.example/")
  })

  it("produces one clean address from everything at once", () => {
    expect(normalizeCanonical("https://user:pw@ACME.Example:443/a/b?x=1#frag")).toBe(
      "https://acme.example/a/b?x=1",
    )
  })

  it("is unchanged by a second pass", () => {
    const once = normalizeCanonical("https://user:pw@ACME.Example:443/a/b?x=1#frag")

    expect(normalizeCanonical(once)).toBe(once)
  })
})

describe("breadcrumbItems", () => {
  it("numbers the caller's crumbs from 1 and keeps their order", () => {
    expect(breadcrumbItems("https://acme.example/products/widgets", TRAIL)).toEqual([
      { "@type": "ListItem", position: 1, name: "Home", item: "https://acme.example/" },
      {
        "@type": "ListItem",
        position: 2,
        name: "Products",
        item: "https://acme.example/products",
      },
      {
        "@type": "ListItem",
        position: 3,
        name: "Widgets",
        item: "https://acme.example/products/widgets",
      },
    ])
  })

  it("uses the caller's name verbatim, never a name read out of the path", () => {
    const items = breadcrumbItems("https://acme.example/section/24/title", [
      { name: "Field reports", href: "/section" },
      { name: "August 2026", href: "/section/24" },
      { name: "How I work" },
    ])

    expect(items.map((item) => item.name)).toEqual(["Field reports", "August 2026", "How I work"])
  })

  it("resolves a root-relative crumb href against the canonical origin", () => {
    const items = breadcrumbItems("https://acme.example/a/b", [
      { name: "A", href: "/a" },
      { name: "B" },
    ])

    expect(items[0].item).toBe("https://acme.example/a")
  })

  it("resolves a crumb href relative to the page, not to the origin", () => {
    const items = breadcrumbItems("https://acme.example/a/b/c", [
      { name: "Sibling", href: "../sibling" },
      { name: "C" },
    ])

    expect(items[0].item).toBe("https://acme.example/a/sibling")
  })

  it("keeps an absolute crumb href on another host", () => {
    const items = breadcrumbItems("https://acme.example/a", [
      { name: "Docs", href: "https://docs.example/start" },
      { name: "A" },
    ])

    expect(items[0].item).toBe("https://docs.example/start")
  })

  it("gives the last crumb the page's own cleaned address when it states none", () => {
    const items = breadcrumbItems("https://user:pw@acme.example/a?x=1#frag", [
      { name: "Home", href: "/" },
      { name: "A" },
    ])

    expect(items.at(-1)?.item).toBe("https://acme.example/a?x=1")
  })

  it("keeps a last crumb's own address instead of the page's when it states one", () => {
    const items = breadcrumbItems("https://acme.example/a/b", [
      { name: "A", href: "/a" },
      { name: "B", href: "/a/b/exact" },
    ])

    expect(items.at(-1)?.item).toBe("https://acme.example/a/b/exact")
  })

  it("drops a fragment from a crumb href, exactly as it does from the canonical", () => {
    const items = breadcrumbItems("https://acme.example/a/b", [
      { name: "A", href: "/a#section" },
      { name: "B" },
    ])

    expect(items[0].item).toBe("https://acme.example/a")
  })

  it("refuses a javascript: crumb href", () => {
    expect(() =>
      breadcrumbItems("https://acme.example/a", [
        { name: "Trap", href: "javascript:alert(1)" },
        { name: "A" },
      ])
    ).toThrow("crumb href must be an http or https URL")
  })

  it("drops a user name and password from a crumb href", () => {
    const items = breadcrumbItems("https://acme.example/a", [
      { name: "Admin", href: "https://user:pw@acme.example/admin" },
      { name: "A" },
    ])

    expect(items[0].item).toBe("https://acme.example/admin")
  })

  it("returns nothing for an empty trail", () => {
    expect(breadcrumbItems("https://acme.example/a", [])).toEqual([])
  })
})

describe("breadcrumbListJsonLd", () => {
  it("anchors the node to the page it describes", () => {
    const node = breadcrumbListJsonLd("https://acme.example/blog", TRAIL)

    expect(node["@type"]).toBe("BreadcrumbList")
    expect(node["@id"]).toBe("https://acme.example/blog#breadcrumb")
    expect(node.itemListElement).toHaveLength(3)
  })

  it("anchors a canonical carrying a fragment with one fragment marker, not two", () => {
    const node = breadcrumbListJsonLd("https://acme.example/a/b?x=1#frag", TRAIL)

    expect(node["@id"]).toBe("https://acme.example/a/b?x=1#breadcrumb")
    expect(node["@id"].match(/#/g)).toHaveLength(1)
  })

  it("refuses a canonical that is not an http or https address", () => {
    expect(() => breadcrumbListJsonLd("javascript:alert(1)", TRAIL)).toThrow(
      "canonical must be an http or https URL",
    )
  })
})

describe("faqPageJsonLd", () => {
  it("lists every question with its answer, in page order", () => {
    const node = faqPageJsonLd([
      { question: "Is it free?", answerText: "Yes, MIT." },
      { question: "Can I self-host?", answerText: "On one server." },
    ])

    expect(node).toEqual({
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Is it free?",
          acceptedAnswer: { "@type": "Answer", text: "Yes, MIT." },
        },
        {
          "@type": "Question",
          name: "Can I self-host?",
          acceptedAnswer: { "@type": "Answer", text: "On one server." },
        },
      ],
    })
  })
})

describe("jsonLdText", () => {
  it("escapes < so a description cannot close the script element", () => {
    const text = jsonLdText({ description: "</script><script>alert(1)</script>" })

    expect(text).not.toContain("</script")
    expect(text).toContain("\\u003c/script")
  })

  it("emits none of <, >, &, U+2028 or U+2029 raw", () => {
    const text = jsonLdText({ description: "<!-- a > b && c \u2028 d \u2029 -->" })

    for (const char of ["<", ">", "&", "\u2028", "\u2029"]) expect(text).not.toContain(char)
    expect(text).toContain("\\u003c!-- a \\u003e b \\u0026\\u0026 c \\u2028 d \\u2029 --\\u003e")
  })

  it("still parses back to the original value", () => {
    const value = { name: "</script>", nested: { list: [1, "<b>&amp;\u2028\u2029"] } }

    expect(JSON.parse(jsonLdText(value))).toEqual(value)
  })
})

describe("sitemapXml", () => {
  it("lists every page with its loc and, when given, its lastmod", () => {
    const xml = sitemapXml([
      { url: "https://acme.example/", lastmod: new Date("2026-10-21T08:30:00Z") },
      { url: "https://acme.example/pricing" },
    ])

    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://acme.example/</loc>
    <lastmod>2026-10-21T08:30:00.000Z</lastmod>
  </url>
  <url>
    <loc>https://acme.example/pricing</loc>
  </url>
</urlset>
`,
    )
  })

  it("escapes & and ' in an address so the XML stays well-formed", () => {
    const xml = sitemapXml([{ url: "https://acme.example/it's?x=1&y=2" }])

    expect(xml).toContain("<loc>https://acme.example/it&apos;s?x=1&amp;y=2</loc>")
  })

  it("normalises an address the way a canonical one is", () => {
    const xml = sitemapXml([{ url: "https://user:pw@ACME.Example:443/a#frag" }])

    expect(xml).toContain("<loc>https://acme.example/a</loc>")
  })

  it("refuses a relative address", () => {
    expect(() => sitemapXml([{ url: "/pricing" }])).toThrow("sitemap url must be an absolute URL")
  })

  it("refuses an invalid lastmod", () => {
    expect(() => sitemapXml([{ url: "https://acme.example/", lastmod: new Date("soon") }]))
      .toThrow("sitemap lastmod must be a valid date")
  })

  it("writes an empty urlset for no pages", () => {
    expect(sitemapXml([])).toContain(
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n</urlset>\n`,
    )
  })
})

describe("llmsTxt", () => {
  it("writes the title, the summary and each section with its links", () => {
    const text = llmsTxt({
      title: "Acme",
      summary: "Widgets for teams.",
      sections: [
        {
          title: "Docs",
          links: [
            {
              title: "Pricing",
              url: "https://acme.example/pricing",
              description: "Plans and prices",
            },
            { title: "Features", url: "https://acme.example/features" },
          ],
        },
        { title: "Optional", links: [{ title: "Blog", url: "https://acme.example/blog" }] },
      ],
    })

    expect(text).toBe(
      `# Acme

> Widgets for teams.

## Docs
- [Pricing](https://acme.example/pricing): Plans and prices
- [Features](https://acme.example/features)

## Optional
- [Blog](https://acme.example/blog)
`,
    )
  })

  it("turns a line break inside a value into a space, so it cannot start a heading", () => {
    const text = llmsTxt({
      title: "Acme\n# Evil",
      summary: "Line one\r\n\n## Line two",
      sections: [{
        title: "Docs",
        links: [{
          title: "A",
          url: "https://acme.example/a",
          description: "x\n- [B](https://b.example)",
        }],
      }],
    })

    expect(text).toContain("# Acme # Evil\n")
    expect(text).toContain("> Line one ## Line two\n")
    expect(text).toContain("- [A](https://acme.example/a): x - [B](https://b.example)\n")
    expect(text.split("\n").filter((line) => line.startsWith("#"))).toHaveLength(2)
  })

  it("escapes brackets in a link text and parentheses in an address, so the link stays whole", () => {
    const text = llmsTxt({
      title: "Acme",
      summary: "S",
      sections: [{
        title: "Docs",
        links: [{ title: "a] [b\\", url: "https://acme.example/wiki/Foo_(bar)" }],
      }],
    })

    expect(text).toContain("- [a\\] \\[b\\\\](https://acme.example/wiki/Foo_%28bar%29)\n")
  })

  it("refuses a relative address", () => {
    expect(() =>
      llmsTxt({
        title: "Acme",
        summary: "S",
        sections: [{ title: "Docs", links: [{ title: "A", url: "/a" }] }],
      })
    ).toThrow("llms.txt url must be an absolute URL")
  })
})

/** A feed's channel as a blog states it. */
const CHANNEL = {
  title: "Acme blog",
  link: "https://acme.example/blog",
  description: "Notes from Acme.",
  feedUrl: "https://acme.example/rss.xml",
}

/** A post published on 22 October 2026. */
const ITEM = {
  title: "Launch",
  link: "https://acme.example/blog/launch",
  description: "We launched.",
  pubDate: new Date("2026-10-22T10:00:00Z"),
}

/** The first `name` element under `element`, depth first. */
function find(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (typeof child === "string") continue
    if (child.name === name) return child
    const found = find(child, name)
    if (found !== undefined) return found
  }
  return undefined
}

/** The text of the first `name` element under `element`. */
function textOf(element: XmlElement, name: string): string | undefined {
  return find(element, name)?.children.filter((c) => typeof c === "string").join("")
}

/** `xml` parsed by a strict XML reader; fails the test when it is not well-formed. */
function parseFeed(xml: string): XmlElement {
  const result = parseXml(xml)
  if (!result.success) throw new Error(`feed is not well-formed: ${result.error.message}`)
  return result.output
}

describe("rssXml", () => {
  it("writes an RSS 2.0 channel with a self link, a permalink guid and an RFC 822 date", () => {
    const xml = rssXml({ ...CHANNEL, language: "en" }, [ITEM])
    expect(xml).toContain(`<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"`)
    expect(xml).toContain(
      `<atom:link href="https://acme.example/rss.xml" rel="self" type="application/rss+xml"/>`,
    )
    expect(xml).toContain(
      `<guid isPermaLink="true">https://acme.example/blog/launch</guid>`,
    )
    expect(xml).toContain(`<pubDate>Thu, 22 Oct 2026 10:00:00 GMT</pubDate>`)
    expect(xml).toContain(`<language>en</language>`)
    expect(parseFeed(xml).name).toBe("rss")
  })

  it("dates the channel by its newest item unless lastBuildDate is given", () => {
    const older = {
      ...ITEM,
      link: "https://acme.example/blog/old",
      pubDate: new Date("2026-01-01"),
    }
    expect(rssXml(CHANNEL, [older, ITEM])).toContain(
      `<lastBuildDate>Thu, 22 Oct 2026 10:00:00 GMT</lastBuildDate>`,
    )
    expect(rssXml({ ...CHANNEL, lastBuildDate: new Date("2026-10-23T00:00:00Z") }, [ITEM]))
      .toContain(`<lastBuildDate>Fri, 23 Oct 2026 00:00:00 GMT</lastBuildDate>`)
    expect(rssXml(CHANNEL, [])).not.toContain("lastBuildDate")
  })

  it("escapes markup in titles and descriptions so they read back unchanged", () => {
    const title = `Tom & Jerry <script>alert("x")</script>`
    const feed = parseFeed(rssXml(CHANNEL, [{ ...ITEM, title, description: "a < b & c > d" }]))
    const item = find(feed, "item")!
    expect(textOf(item, "title")).toBe(title)
    expect(textOf(item, "description")).toBe("a < b & c > d")
  })

  it("puts contentHtml in CDATA and splits a ]]> inside it", () => {
    const contentHtml = `<p>Code: <code>a[b[0]]>c</code></p>`
    const xml = rssXml(CHANNEL, [{ ...ITEM, contentHtml }])
    expect(xml).toContain(`xmlns:content="http://purl.org/rss/1.0/modules/content/"`)
    expect(xml).toContain(`<content:encoded><![CDATA[<p>Code: <code>a[b[0]]]]><![CDATA[>c`)
    expect(textOf(parseFeed(xml), "encoded")).toBe(contentHtml)
  })

  it("removes characters XML cannot hold, so one stray control character keeps the feed valid", () => {
    const xml = rssXml(CHANNEL, [{
      ...ITEM,
      title: "Bell\u0007 here",
      contentHtml: "<p>form\u000Cfeed</p>",
    }])
    expect(xml).toContain("<title>Bell here</title>")
    expect(xml).toContain("<p>formfeed</p>")
    expect(parseFeed(xml).name).toBe("rss")
  })

  it("refuses a relative link, a non-web feed address and an invalid date", () => {
    expect(() => rssXml(CHANNEL, [{ ...ITEM, link: "/blog/launch" }])).toThrow(
      "rss item link must be an absolute URL",
    )
    expect(() => rssXml({ ...CHANNEL, feedUrl: "javascript:alert(1)" }, [])).toThrow(
      "rss feedUrl must be an http or https URL",
    )
    expect(() => rssXml(CHANNEL, [{ ...ITEM, pubDate: new Date("soon") }])).toThrow(
      "must be a valid date",
    )
  })
})

/** A post with only the required fields. */
const POST = {
  url: "https://acme.example/blog/launch#top",
  headline: "Launch",
  description: "We launched.",
  datePublished: new Date("2026-10-22T10:00:00Z"),
  author: { name: "Jane Doe" },
}

describe("blogPostingJsonLd", () => {
  it("writes Google's article fields and defaults dateModified to datePublished", () => {
    expect(blogPostingJsonLd(POST)).toEqual({
      "@type": "BlogPosting",
      "@id": "https://acme.example/blog/launch#article",
      headline: "Launch",
      description: "We launched.",
      datePublished: "2026-10-22T10:00:00.000Z",
      dateModified: "2026-10-22T10:00:00.000Z",
      author: { "@type": "Person", name: "Jane Doe" },
      mainEntityOfPage: { "@type": "WebPage", "@id": "https://acme.example/blog/launch" },
    })
  })

  it("writes every optional field, resolving the image against the post and keeping @id fragments", () => {
    const node = blogPostingJsonLd({
      ...POST,
      image: { url: "/og/launch.png", width: 1200, height: 630 },
      dateModified: new Date("2026-10-23T00:00:00Z"),
      author: {
        name: "Jane Doe",
        url: "https://acme.example/about",
        id: "https://acme.example/#jane",
      },
      publisher: { id: "https://acme.example/#org" },
      section: "News",
      inLanguage: "en-US",
      readingMinutes: 4,
      blog: {
        id: "https://acme.example/blog#blog",
        name: "Acme blog",
        url: "https://acme.example/blog",
      },
    })
    expect(node.image).toEqual({
      "@type": "ImageObject",
      url: "https://acme.example/og/launch.png",
      width: 1200,
      height: 630,
    })
    expect(node.dateModified).toBe("2026-10-23T00:00:00.000Z")
    expect(node.author).toEqual({
      "@type": "Person",
      "@id": "https://acme.example/#jane",
      name: "Jane Doe",
      url: "https://acme.example/about",
    })
    expect(node.publisher).toEqual({ "@id": "https://acme.example/#org" })
    expect(node.articleSection).toBe("News")
    expect(node.inLanguage).toBe("en-US")
    expect(node.timeRequired).toBe("PT4M")
    expect(node.isPartOf).toEqual({
      "@type": "Blog",
      "@id": "https://acme.example/blog#blog",
      name: "Acme blog",
      url: "https://acme.example/blog",
    })
  })

  it("writes a full publisher node when one is given", () => {
    const node = blogPostingJsonLd({
      ...POST,
      image: "https://cdn.acme.example/a.png",
      publisher: { type: "Organization", name: "Acme", url: "https://acme.example" },
    })
    expect(node.image).toBe("https://cdn.acme.example/a.png")
    expect(node.publisher).toEqual({
      "@type": "Organization",
      name: "Acme",
      url: "https://acme.example/",
    })
  })

  it("refuses a javascript image, an invalid date and a fractional reading time", () => {
    expect(() => blogPostingJsonLd({ ...POST, image: "javascript:alert(1)" })).toThrow(
      "image must be an http or https URL",
    )
    expect(() => blogPostingJsonLd({ ...POST, datePublished: new Date("soon") })).toThrow(
      "datePublished must be a valid date",
    )
    expect(() => blogPostingJsonLd({ ...POST, readingMinutes: 2.5 })).toThrow(
      "readingMinutes must be a positive whole number",
    )
  })

  it("prints safely inside a script element through jsonLdText", () => {
    const text = jsonLdText(blogPostingJsonLd({ ...POST, headline: "</script><script>x()" }))
    expect(text).not.toContain("</script>")
  })
})

describe("sitemapXml images", () => {
  it("writes each image as image:image and declares the image namespace", () => {
    const xml = sitemapXml([
      { url: "https://shop.example/shirt", images: ["https://cdn.shop.example/a.jpg?w=1&h=2"] },
    ])

    expect(xml).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url>
    <loc>https://shop.example/shirt</loc>
    <image:image>
      <image:loc>https://cdn.shop.example/a.jpg?w=1&amp;h=2</image:loc>
    </image:image>
  </url>
</urlset>
`,
    )
  })

  it("parses as XML with the image extension's namespace bound", () => {
    const xml = sitemapXml([
      { url: "https://shop.example/a", images: ["https://cdn.shop.example/it's.jpg"] },
    ])
    const image = find(parseFeed(xml), "image")

    expect(image?.namespace).toBe("http://www.google.com/schemas/sitemap-image/1.1")
    expect(image === undefined ? undefined : textOf(image, "loc")).toBe(
      "https://cdn.shop.example/it's.jpg",
    )
  })

  it("leaves the namespace out when no entry has an image", () => {
    expect(sitemapXml([{ url: "https://shop.example/a", images: [] }])).not.toContain("xmlns:image")
  })

  it("refuses a relative image address", () => {
    expect(() => sitemapXml([{ url: "https://shop.example/a", images: ["/a.jpg"] }])).toThrow(
      "sitemap image must be an absolute URL",
    )
  })
})

/** A shirt page in Vietnamese dong, with no variants. */
const SHIRT: ProductPage = {
  url: "https://shop.example/shirts/linen#top",
  name: "Linen shirt",
  description: "Loose linen shirt.",
  images: ["/img/linen-1.jpg", "https://cdn.shop.example/linen-2.jpg"],
  sku: "LIN-01",
  brand: "Vi",
  category: "Clothing > Shirts",
  price: 250000,
  currency: "VND",
  inStock: true,
  seller: { name: "Vi shop", url: "https://shop.example" },
}

describe("productJsonLd", () => {
  it("describes an item with no variants as a Product with one new offer", () => {
    expect(productJsonLd(SHIRT)).toEqual({
      "@type": "Product",
      "@id": "https://shop.example/shirts/linen#product",
      name: "Linen shirt",
      description: "Loose linen shirt.",
      brand: { "@type": "Brand", name: "Vi" },
      category: "Clothing > Shirts",
      image: ["https://shop.example/img/linen-1.jpg", "https://cdn.shop.example/linen-2.jpg"],
      sku: "LIN-01",
      offers: {
        "@type": "Offer",
        url: "https://shop.example/shirts/linen",
        price: 250000,
        priceCurrency: "VND",
        availability: "https://schema.org/InStock",
        itemCondition: "https://schema.org/NewCondition",
        seller: { "@type": "Organization", name: "Vi shop", url: "https://shop.example/" },
      },
    })
  })

  it("writes a VND price with no decimals and a USD price with two", () => {
    const vnd = productJsonLd({ ...SHIRT, price: 199000 }) as { offers: { price: number } }
    const usd = productJsonLd({ ...SHIRT, price: 1999, currency: "usd" }) as {
      offers: { price: number; priceCurrency: string }
    }

    expect(jsonLdText(vnd.offers.price)).toBe("199000")
    expect(jsonLdText(usd.offers.price)).toBe("19.99")
    expect(usd.offers.priceCurrency).toBe("USD")
  })

  it("refuses a fractional, negative or unprintable price", () => {
    expect(() => productJsonLd({ ...SHIRT, price: 19.99, currency: "USD" })).toThrow(
      "product price must be a whole, non-negative number",
    )
    expect(() => productJsonLd({ ...SHIRT, price: -1 })).toThrow(
      "product price must be a whole, non-negative number",
    )
    expect(() => productJsonLd({ ...SHIRT, price: Number.MAX_SAFE_INTEGER, currency: "USD" }))
      .toThrow("cannot be written exactly as a JSON number")
  })

  it("marks a sold-out item OutOfStock", () => {
    const node = productJsonLd({ ...SHIRT, inStock: false }) as { offers: { availability: string } }
    expect(node.offers.availability).toBe("https://schema.org/OutOfStock")
  })

  it("refuses an item with no image or a javascript image", () => {
    expect(() => productJsonLd({ ...SHIRT, images: [] })).toThrow(
      "product needs at least one image",
    )
    expect(() => productJsonLd({ ...SHIRT, images: ["javascript:alert(1)"] })).toThrow(
      "product image must be an http or https URL",
    )
  })

  it("references a seller by @id when given one", () => {
    const node = productJsonLd({ ...SHIRT, seller: { id: "https://shop.example/#org" } }) as {
      offers: { seller: unknown }
    }
    expect(node.offers.seller).toEqual({ "@id": "https://shop.example/#org" })
  })

  it("describes colour × size variants as a ProductGroup listing sold-out ones too", () => {
    const node = productJsonLd({
      ...SHIRT,
      variants: [
        { sku: "LIN-01-RED-M", url: "?color=red&size=m", color: "Red", size: "M" },
        {
          sku: "LIN-01-RED-L",
          url: "?color=red&size=l",
          color: "Red",
          size: "L",
          inStock: false,
        },
        {
          sku: "LIN-01-BLU-M",
          url: "?color=blue&size=m",
          color: "Blue",
          size: "M",
          images: ["/img/linen-blue.jpg"],
        },
      ],
    })

    expect(node).toEqual({
      "@type": "ProductGroup",
      "@id": "https://shop.example/shirts/linen#product",
      name: "Linen shirt",
      description: "Loose linen shirt.",
      brand: { "@type": "Brand", name: "Vi" },
      category: "Clothing > Shirts",
      url: "https://shop.example/shirts/linen",
      productGroupID: "LIN-01",
      variesBy: ["https://schema.org/color", "https://schema.org/size"],
      hasVariant: [
        variantNode("Linen shirt (Red, M)", "LIN-01-RED-M", "Red", "M", "?color=red&size=m"),
        variantNode("Linen shirt (Red, L)", "LIN-01-RED-L", "Red", "L", "?color=red&size=l", {
          availability: "https://schema.org/OutOfStock",
        }),
        {
          ...variantNode(
            "Linen shirt (Blue, M)",
            "LIN-01-BLU-M",
            "Blue",
            "M",
            "?color=blue&size=m",
          ),
          image: ["https://shop.example/img/linen-blue.jpg"],
        },
      ],
    })
  })

  it("names only the traits the variants vary by", () => {
    const node = productJsonLd({
      ...SHIRT,
      variants: [{ sku: "A", url: "?size=s", size: "S" }, { sku: "B", url: "?size=m", size: "M" }],
    }) as { variesBy: string[] }
    expect(node.variesBy).toEqual(["https://schema.org/size"])
  })

  it("refuses variants without a sku, which Google requires as the productGroupID", () => {
    const variants = [{ sku: "A", url: "?size=s", size: "S" }]
    expect(() => productJsonLd({ ...SHIRT, sku: undefined, variants })).toThrow(
      "product with variants needs a sku for its productGroupID",
    )
    expect(() => productJsonLd({ ...SHIRT, sku: " ", variants })).toThrow(
      "product with variants needs a sku for its productGroupID",
    )
  })

  it("leaves variesBy out when no variant sets a colour or a size", () => {
    const node = productJsonLd({
      ...SHIRT,
      variants: [{ sku: "A", url: "?v=a" }, { sku: "B", url: "?v=b", inStock: false }],
    })
    expect("variesBy" in node).toBe(false)
  })

  it("prints safely inside a script element through jsonLdText", () => {
    const text = jsonLdText(productJsonLd({ ...SHIRT, name: "</script><script>x()" }))
    expect(text).not.toContain("</script>")
  })
})

/** The `Product` node `productJsonLd` writes for one variant of `SHIRT`. */
function variantNode(
  name: string,
  sku: string,
  color: string,
  size: string,
  query: string,
  offer: Record<string, unknown> = {},
) {
  return {
    "@type": "Product",
    name,
    image: ["https://shop.example/img/linen-1.jpg", "https://cdn.shop.example/linen-2.jpg"],
    sku,
    color,
    size,
    offers: {
      "@type": "Offer",
      url: `https://shop.example/shirts/linen${query}`,
      price: 250000,
      priceCurrency: "VND",
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: "Vi shop", url: "https://shop.example/" },
      ...offer,
    },
  }
}

describe("itemListJsonLd", () => {
  it("lists each item's page with its 1-based position, resolved against the list page", () => {
    expect(
      itemListJsonLd("https://shop.example/shirts?page=2#grid", [
        "/shirts/linen",
        "https://shop.example/shirts/cotton",
      ]),
    ).toEqual({
      "@type": "ItemList",
      "@id": "https://shop.example/shirts?page=2#itemlist",
      itemListElement: [
        { "@type": "ListItem", position: 1, url: "https://shop.example/shirts/linen" },
        { "@type": "ListItem", position: 2, url: "https://shop.example/shirts/cotton" },
      ],
    })
  })

  it("refuses a javascript item address", () => {
    expect(() => itemListJsonLd("https://shop.example/", ["javascript:alert(1)"])).toThrow(
      "item list url must be an http or https URL",
    )
  })
})
