import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { renderMarkdown, renderMarkdownSegments } from "./markdown.ts"

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

describe("renderMarkdownSegments: component tags", () => {
  it("splits a post with two tags into five segments with parsed props and lines", () => {
    const md = [
      "Intro paragraph.",
      "",
      `<Gauge level={10} label="first" marks={[10, 32]} opts={{"a b": "}"}} />`,
      "",
      "## Middle",
      "",
      "Between.",
      "<Gauge/>",
      "After.",
    ].join("\n")
    const { segments, headings, problems } = renderMarkdownSegments(md)
    expect(problems).toEqual([])
    expect(segments).toEqual([
      { kind: "html", html: "<p>Intro paragraph.</p>\n" },
      {
        kind: "component",
        tag: "Gauge",
        props: { level: 10, label: "first", marks: [10, 32], opts: { "a b": "}" } },
        line: 3,
      },
      { kind: "html", html: `<h2 id="middle">Middle</h2>\n<p>Between.</p>\n` },
      { kind: "component", tag: "Gauge", props: {}, line: 8 },
      { kind: "html", html: "<p>After.</p>\n" },
    ])
    expect(headings).toEqual([{ depth: 2, id: "middle", text: "Middle" }])
  })

  it("gives the same HTML and headings as renderMarkdown for a post without tags", () => {
    const md = "# A\n\n## A\n\nText [ref][r] with <kbd>Ctrl</kbd>.\n\n- one\n- two\n\n[r]: /x\n"
    const { segments, headings, problems } = renderMarkdownSegments(md)
    expect(segments).toEqual([{ kind: "html", html: renderMarkdown(md).html }])
    expect(headings).toEqual(renderMarkdown(md).headings)
    expect(problems).toEqual([])
  })

  it("keeps heading ids unique across the chunks around a tag", () => {
    const { headings } = renderMarkdownSegments("## Intro\n\n<Gauge />\n\n## Intro\n")
    expect(headings.map((h) => h.id)).toEqual(["intro", "intro-2"])
  })

  it("resolves a reference link whose definition sits in another chunk", () => {
    const { segments } = renderMarkdownSegments("See [docs][d].\n\n<Gauge />\n\n[d]: /docs\n")
    expect(segments[0]).toEqual({ kind: "html", html: `<p>See <a href="/docs">docs</a>.</p>\n` })
  })

  it("leaves a tag in a fenced code block, inline code or mid-line as escaped text", () => {
    const md = "```tsx\n<Gauge level={500} />\n```\n\n`<Gauge />` is it.\n\nA <Gauge /> here.\n"
    const { segments, problems } = renderMarkdownSegments(md)
    expect(problems).toEqual([])
    expect(segments).toEqual([{ kind: "html", html: renderMarkdown(md).html }])
    expect(segments[0]).toMatchObject({
      html: expect.stringContaining("&lt;Gauge level={500} /&gt;"),
    })
  })

  it("keeps raw HTML escaped in the chunks around a tag", () => {
    const { segments } = renderMarkdownSegments(
      "<script>alert(1)</script>\n\n<Gauge />\n\n<img src=x onerror=alert(1)>\n",
    )
    const html = segments.flatMap((s) => s.kind === "html" ? [s.html] : []).join("")
    expect(html).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>\n<p>&lt;img src=x onerror=alert(1)&gt;</p>\n",
    )
  })

  it("returns markup in a string prop as raw data and never puts it in the HTML", () => {
    const { segments } = renderMarkdownSegments(
      `<Gauge label="</div><script>alert(1)</script>" data={{"x":"<img src=x onerror=alert(1)>"}} />\n`,
    )
    expect(segments).toEqual([{
      kind: "component",
      tag: "Gauge",
      props: {
        label: "</div><script>alert(1)</script>",
        data: { x: "<img src=x onerror=alert(1)>" },
      },
      line: 1,
    }])
  })

  it("counts lines after Windows line breaks", () => {
    const md = "a\r\n\r\n<Gauge />\r\n" + "x\r\n".repeat(10)
    expect(renderMarkdownSegments(md).segments[1]).toMatchObject({ kind: "component", line: 3 })
  })
})

describe("renderMarkdownSegments: problems", () => {
  for (
    const [line, reason] of [
      ["<Gauge level={15}>", "close itself"],
      ["<Gauge level={15} /> trailing", "alone on its line"],
      ["<Gauge level=15 />", "needs a value"],
      ["<Gauge level />", "needs a value"],
      ["<Gauge level={fifteen} />", "not a JSON literal"],
      ["<Gauge level={15 />", "unclosed {"],
      ['<Gauge label="x />', "unclosed string"],
      ["<Gauge level={1} level={2} />", "given twice"],
      ["<Gauge level={1}label={2} />", "unexpected"],
      ["<Gauge __proto__={{}} />", `"__proto__" is not allowed`],
    ]
  ) {
    it(`reports ${JSON.stringify(line)} on its line and renders nothing for it`, () => {
      const { segments, problems } = renderMarkdownSegments(`Intro.\n\n${line}\n\nAfter.\n`)
      expect(problems).toHaveLength(1)
      expect(problems[0].line).toBe(3)
      expect(problems[0].message).toContain("<Gauge>: ")
      expect(problems[0].message).toContain(reason)
      expect(segments).toEqual([{ kind: "html", html: "<p>Intro.</p>\n<p>After.</p>\n" }])
    })
  }

  it("reports a tag inside a list or a quote with its line and renders nothing for it", () => {
    const md = "Intro.\n\n- item\n\n  <Gauge level={1} />\n\n> quote\n> <Gauge />\n"
    const { segments, problems } = renderMarkdownSegments(md)
    expect(problems.map((p) => p.line)).toEqual([5, 8])
    for (const p of problems) expect(p.message).toContain("top level")
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: "html" })
    expect(JSON.stringify(segments)).not.toContain("Gauge")
  })

  it("reports every bad tag in page order and still returns the good ones", () => {
    const { segments, problems } = renderMarkdownSegments(
      "<Bad x />\n\n<Good />\n\n<Bad y={,} />\n",
    )
    expect(problems.map((p) => p.line)).toEqual([1, 5])
    expect(segments).toEqual([{ kind: "component", tag: "Good", props: {}, line: 3 }])
  })
})
