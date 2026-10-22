import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { renderMarkdown } from "./markdown.ts"

/** The rendered HTML of `markdown`. */
const html = (markdown: string) => renderMarkdown(markdown).html

describe("renderMarkdown: raw HTML", () => {
  it("shows a script block as text instead of running it", () => {
    expect(html("<script>alert(1)</script>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n",
    )
  })

  it("shows an inline img with an onerror handler as text", () => {
    const out = html("Hi <img src=x onerror=alert(1)> there")
    expect(out).toBe("<p>Hi &lt;img src=x onerror=alert(1)&gt; there</p>\n")
    expect(out).not.toContain("<img")
  })

  it("escapes the text inside an inline code tag, which marked would print raw", () => {
    // Printed raw, the unclosed `<img` would take the next real `>` (from `</p>`) as its end and
    // become a live element whose onerror runs.
    const out = html("a <code>x <img src=x onerror=alert(1)//\n\nnext</code>")
    expect(out).not.toContain("<img")
    expect(out).toContain("x &lt;img src=x onerror=alert(1)//</p>")
  })

  it("shows an HTML block as text in a paragraph", () => {
    expect(html("<div>\n<iframe src=//evil.example></iframe>\n</div>")).toBe(
      "<p>&lt;div&gt;\n&lt;iframe src=//evil.example&gt;&lt;/iframe&gt;\n&lt;/div&gt;</p>\n",
    )
  })

  it("keeps code blocks and code spans escaped", () => {
    expect(html("```html\n<script>x</script>\n```")).toContain("&lt;script&gt;x&lt;/script&gt;")
    expect(html("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>\n")
  })
})

describe("renderMarkdown: links", () => {
  for (
    const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "<java\tscript:alert(1)>",
      "<\u0001javascript:alert(1)>",
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
    ]
  ) {
    it(`drops the address ${JSON.stringify(href)} and keeps the link text`, () => {
      const out = html(`[click](${href})`)
      expect(out).not.toContain("<a")
      expect(out).toContain("click")
    })
  }

  it("drops a javascript autolink to plain text", () => {
    expect(html("<javascript:alert(1)>")).not.toContain("<a")
  })

  it("prints an entity-spelled scheme literally, so the browser reads a relative path", () => {
    // `&amp;colon;` in the attribute decodes to the text `&colon;`, never to `:`.
    expect(html("[x](javascript&colon;alert(1))")).toBe(
      `<p><a href="javascript&amp;colon;alert(1)">x</a></p>\n`,
    )
  })

  it("keeps http, https, mailto, relative, fragment and query links", () => {
    expect(html("[a](/docs?a=1&b=2) [b](#setup) [c](mailto:hi@example.com)")).toBe(
      `<p><a href="/docs?a=1&amp;b=2">a</a> <a href="#setup">b</a> ` +
        `<a href="mailto:hi@example.com">c</a></p>\n`,
    )
    expect(html("[d](http://example.com)")).toContain(`href="http://example.com"`)
  })

  it("adds rel noopener noreferrer to external links only", () => {
    expect(html("[a](https://example.com)")).toBe(
      `<p><a href="https://example.com" rel="noopener noreferrer">a</a></p>\n`,
    )
    expect(html("[a](//example.com)")).toContain(`rel="noopener noreferrer"`)
    expect(html("www.example.com")).toContain(`rel="noopener noreferrer"`)
    expect(html("[a](/about)")).not.toContain("rel=")
  })

  it("escapes a title that tries to open a second attribute", () => {
    const out = html(`[a](/x "t\\" onmouseover=\\"alert(1)")`)
    expect(out).toContain(`title="t&quot; onmouseover=&quot;alert(1)"`)
  })
})

describe("renderMarkdown: images", () => {
  it("renders an allowed image lazily with escaped alt text", () => {
    expect(html(`![a" onerror="alert(1)](https://example.com/a.png)`)).toBe(
      `<p><img src="https://example.com/a.png" alt="a&quot; onerror=&quot;alert(1)" ` +
        `loading="lazy" decoding="async"></p>\n`,
    )
  })

  it("escapes an image title that tries to open a second attribute", () => {
    const out = html(`![a](https://example.com/a.png "t\\" onload=\\"alert(1)")`)
    expect(out).toContain(`title="t&quot; onload=&quot;alert(1)"`)
    expect(out).not.toContain(`" onload="`)
  })

  it("turns a data: or javascript: image into its alt text", () => {
    expect(html("![pic](data:image/svg+xml;base64,PHN2Zz4=)")).toBe("<p>pic</p>\n")
    expect(html("![pic](javascript:alert(1))")).toBe("<p>pic</p>\n")
  })
})

describe("renderMarkdown: headings", () => {
  it("gives every heading a slug id and returns them in page order", () => {
    const { html: out, headings } = renderMarkdown(
      "# Getting started\n\n## Why Deno? (and not Node)",
    )
    expect(out).toContain(`<h1 id="getting-started">Getting started</h1>`)
    expect(out).toContain(`<h2 id="why-deno-and-not-node">Why Deno? (and not Node)</h2>`)
    expect(headings).toEqual([
      { depth: 1, id: "getting-started", text: "Getting started" },
      { depth: 2, id: "why-deno-and-not-node", text: "Why Deno? (and not Node)" },
    ])
  })

  it("dedupes repeated headings, skipping an id a literal heading already took", () => {
    const { headings } = renderMarkdown("## Intro\n## Intro-2\n## Intro\n## Intro")
    expect(headings.map((h) => h.id)).toEqual(["intro", "intro-2", "intro-3", "intro-4"])
  })

  it("keeps non-Latin headings and falls back to section for punctuation only", () => {
    const { headings } = renderMarkdown("## Привет, мир\n## !!!")
    expect(headings.map((h) => h.id)).toEqual(["привет-мир", "section"])
  })

  it("returns heading text unescaped and the heading HTML escaped", () => {
    const { html: out, headings } = renderMarkdown("## Tom & <b>Jerry</b>")
    expect(headings[0].text).toBe("Tom & <b>Jerry</b>")
    expect(out).toContain("Tom &amp; &lt;b&gt;Jerry&lt;/b&gt;</h2>")
  })

  it("decodes entities in the returned heading text", () => {
    expect(renderMarkdown("## Fish &amp; chips").headings[0].text).toBe("Fish & chips")
  })

  it("starts ids over on every call", () => {
    expect(renderMarkdown("## A").headings[0].id).toBe("a")
    expect(renderMarkdown("## A").headings[0].id).toBe("a")
  })
})
