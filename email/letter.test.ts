// Behaviour tests for the brand-free letter shell: escaping of every slot, refused schemes,
// the unsubscribe placeholder round trip, the plain-text rendering and absent optional slots.

import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert"
import {
  bulletList,
  button,
  fillUnsubscribe,
  heading,
  linkedImage,
  paragraph,
  renderLetter,
  UNSUBSCRIBE_PLACEHOLDER,
} from "./letter.ts"

const EVIL = `<script>alert("x")</script>&'`
const ESCAPED = `&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;`

Deno.test("escapes paragraph, heading and list text", () => {
  assertStringIncludes(paragraph(EVIL).html, ESCAPED)
  assertStringIncludes(heading(EVIL).html, ESCAPED)
  assertStringIncludes(bulletList([EVIL]).html, ESCAPED)
  for (const html of [paragraph(EVIL).html, heading(EVIL).html, bulletList([EVIL]).html]) {
    assertFalse(html.includes("<script>"))
  }
})

Deno.test("escapes button label and href", () => {
  const { html } = button(`https://example.com/?a=1&b="2"`, EVIL)
  assertStringIncludes(html, ESCAPED)
  assertStringIncludes(html, `https://example.com/?a=1&amp;b=&quot;2&quot;`)
})

Deno.test("escapes image src, alt and href", () => {
  const { html } = linkedImage({
    src: `https://example.com/a.png?x="1"&y=2`,
    alt: EVIL,
    href: `https://example.com/?q="1"&r=2`,
  })
  assertStringIncludes(html, `alt="${ESCAPED}"`)
  assertStringIncludes(html, `src="https://example.com/a.png?x=&quot;1&quot;&amp;y=2"`)
  assertStringIncludes(html, `href="https://example.com/?q=&quot;1&quot;&amp;r=2"`)
})

Deno.test("escapes footer reason, link labels, links and preheader", () => {
  const { html } = renderLetter({
    blocks: [],
    preheader: EVIL,
    footer: {
      reason: EVIL,
      unsubscribeLink: `https://example.com/u?a=1&b="2"`,
      links: [{ href: `https://example.com/?a=1&b="2"`, label: EVIL }],
    },
  })
  assertFalse(html.includes("<script>"))
  assertEquals(html.split(ESCAPED).length - 1, 3)
  assertStringIncludes(html, `href="https://example.com/u?a=1&amp;b=&quot;2&quot;"`)
  assertStringIncludes(html, `href="https://example.com/?a=1&amp;b=&quot;2&quot;"`)
})

Deno.test("refuses a button, image or footer link with an unsafe scheme", () => {
  for (
    const bad of ["javascript:alert(1)", " JaVaScript:alert(1)", "data:text/html,x", "/relative"]
  ) {
    assertThrows(() => button(bad, "Go"), TypeError)
    assertThrows(
      () => linkedImage({ src: "https://example.com/a.png", alt: "", href: bad }),
      TypeError,
    )
    assertThrows(() => linkedImage({ src: bad, alt: "", href: "https://example.com" }), TypeError)
    assertThrows(
      () =>
        renderLetter({ blocks: [], footer: { reason: "r", links: [{ href: bad, label: "x" }] } }),
      TypeError,
    )
    assertThrows(
      () => renderLetter({ blocks: [], footer: { reason: "r", unsubscribeLink: bad } }),
      TypeError,
    )
    assertThrows(() => fillUnsubscribe({ html: "", text: "" }, bad), TypeError)
  }
})

Deno.test("accepts https, http and mailto links", () => {
  for (const ok of ["https://example.com", "http://example.com", "mailto:a@example.com"]) {
    assertStringIncludes(button(ok, "Go").html, ok)
  }
})

Deno.test("rejects an image width that is not a finite positive number", () => {
  const o = { src: "https://example.com/a.png", alt: "", href: "https://example.com" }
  for (const width of [0, -1, NaN, Infinity]) {
    assertThrows(() => linkedImage({ ...o, width }), TypeError)
  }
  assertStringIncludes(linkedImage({ ...o, width: 300 }).html, `width="300"`)
})

Deno.test("uses a neutral button colour by default and honours custom colours", () => {
  assertStringIncludes(button("https://example.com", "Go").html, "#2563eb")
  const custom = button("https://example.com", "Go", { background: "#f97316", color: "#0b0d10" })
  assertStringIncludes(custom.html, "#f97316")
  assertThrows(
    () => button("https://example.com", "Go", { background: `red"`, color: "#fff" }),
    TypeError,
  )
})

Deno.test("renders the text part as readable plain text", () => {
  const { text } = renderLetter({
    header: paragraph("From Ada"),
    blocks: [
      heading("In short"),
      paragraph("Hello there."),
      bulletList(["one", "two"]),
      button("https://example.com/go", "Read it"),
      linkedImage({ src: "https://example.com/a.png", alt: "pic", href: "https://example.com" }),
    ],
    afterword: [paragraph("P.S. Reply any time.")],
    footer: {
      reason: "You get this because you subscribed.",
      unsubscribeLink: "https://example.com/u",
      links: [{ href: "https://example.com", label: "Site" }],
    },
  })
  assertEquals(
    text,
    [
      "From Ada",
      "IN SHORT",
      "Hello there.",
      "- one\n- two",
      "Read it:\nhttps://example.com/go",
      "P.S. Reply any time.",
      "-- \nYou get this because you subscribed.\nUnsubscribe: https://example.com/u\nSite: https://example.com",
    ].join("\n\n") + "\n",
  )
})

Deno.test("places header, blocks, afterword and footer in that order", () => {
  const { html } = renderLetter({
    header: paragraph("HEAD"),
    blocks: [paragraph("BODY")],
    afterword: [paragraph("AFTER")],
    footer: { reason: "FOOT" },
  })
  const at = ["HEAD", "BODY", "AFTER", "FOOT"].map((s) => html.indexOf(s))
  assert(at.every((i) => i >= 0))
  assertEquals([...at].sort((a, b) => a - b), at)
})

Deno.test("omits the header, afterword, unsubscribe, links and preheader when absent", () => {
  const { html, text } = renderLetter({ blocks: [paragraph("Hi")], footer: { reason: "Because." } })
  assertFalse(html.includes("Unsubscribe"))
  assertFalse(html.includes("display:none"))
  assertFalse(html.includes(" · "))
  assertEquals(text, "Hi\n\n-- \nBecause.\n")
})

Deno.test("renders a preheader as a hidden span when given", () => {
  const { html } = renderLetter({
    blocks: [],
    preheader: "Preview line",
    footer: { reason: "r" },
  })
  assertStringIncludes(html, "display:none")
  assertStringIncludes(html, "Preview line")
})

Deno.test("applies a custom theme and column width", () => {
  const { html } = renderLetter({
    blocks: [],
    footer: { reason: "r" },
    theme: { background: "#101010" },
    maxWidth: 520,
  })
  assertStringIncludes(html, "background:#101010")
  assertStringIncludes(html, "max-width:520px")
  assertThrows(
    () => renderLetter({ blocks: [], footer: { reason: "r" }, theme: { background: `x"` } }),
    TypeError,
  )
})

Deno.test("fills the unsubscribe placeholder in both parts, escaped in HTML only", () => {
  const letter = renderLetter({
    blocks: [],
    footer: { reason: "r", unsubscribeLink: UNSUBSCRIBE_PLACEHOLDER },
  })
  assertStringIncludes(letter.html, UNSUBSCRIBE_PLACEHOLDER)
  assertStringIncludes(letter.text, UNSUBSCRIBE_PLACEHOLDER)
  const link = `https://example.com/u?a=1&b=2`
  const filled = fillUnsubscribe(letter, link)
  assertFalse(filled.html.includes(UNSUBSCRIBE_PLACEHOLDER))
  assertFalse(filled.text.includes(UNSUBSCRIBE_PLACEHOLDER))
  assertStringIncludes(filled.html, `href="https://example.com/u?a=1&amp;b=2"`)
  assertStringIncludes(filled.text, `Unsubscribe: ${link}`)
})

Deno.test("a letter rendered once and filled equals one rendered with the link directly", () => {
  const base = { blocks: [paragraph("Hi")], preheader: "p" }
  // `$&` and `$1` must reach the output as written, not as replacement patterns.
  for (const link of ["https://example.com/u?t=abc&x=1", "https://example.com/u?t=$&$1$$"]) {
    const once = renderLetter({
      ...base,
      footer: { reason: "r", unsubscribeLink: UNSUBSCRIBE_PLACEHOLDER },
    })
    const direct = renderLetter({ ...base, footer: { reason: "r", unsubscribeLink: link } })
    assertEquals(fillUnsubscribe(once, link), direct)
  }
})

Deno.test("fillUnsubscribe leaves a letter without the placeholder unchanged", () => {
  const letter = renderLetter({ blocks: [], footer: { reason: "r" } })
  assertEquals(fillUnsubscribe(letter, "https://example.com/u"), letter)
})

Deno.test("separates the footer reason, unsubscribe link and extra links with a middle dot", () => {
  const { html } = renderLetter({
    blocks: [],
    footer: {
      reason: "Because.",
      unsubscribeLink: "https://example.com/u",
      links: [{ href: "https://example.com", label: "Site" }],
    },
  })
  assertEquals(html.split(" · ").length, 3)
})

const SMUGGLED = [
  "https://example.com/u\nUnsubscribe: https://evil.example",
  "https://example.com/u\r\nX",
  "https://example.com/\tx",
  "https://example.com/ x",
  "\u0001https://example.com/u",
  "https://example.com/\u007fx",
  "https://example.com/u\u2028Unsubscribe: https://evil.example",
  "https://example.com/u\u2029x",
  "https://example.com/u\u0085x",
  "https://example.com/u\u00a0x",
  "https://example.com/u\u200bx",
  "https://example.com/u\n",
]

Deno.test("refuses a button link with a character outside printable ASCII", () => {
  for (const bad of SMUGGLED) assertThrows(() => button(bad, "Go"), TypeError)
})

Deno.test("refuses an image link or src with a character outside printable ASCII", () => {
  for (const bad of SMUGGLED) {
    assertThrows(
      () => linkedImage({ src: "https://example.com/a.png", alt: "", href: bad }),
      TypeError,
    )
    assertThrows(
      () => linkedImage({ src: bad, alt: "", href: "https://example.com" }),
      TypeError,
    )
  }
})

Deno.test("refuses a footer link with a character outside printable ASCII", () => {
  for (const bad of SMUGGLED) {
    assertThrows(
      () =>
        renderLetter({ blocks: [], footer: { reason: "r", links: [{ href: bad, label: "x" }] } }),
      TypeError,
    )
  }
})

Deno.test("refuses an unsubscribe link with a character outside printable ASCII", () => {
  for (const bad of SMUGGLED) {
    assertThrows(
      () => renderLetter({ blocks: [], footer: { reason: "r", unsubscribeLink: bad } }),
      TypeError,
    )
  }
})

Deno.test("refuses a fillUnsubscribe link with a character outside printable ASCII", () => {
  const letter = renderLetter({
    blocks: [],
    footer: { reason: "r", unsubscribeLink: UNSUBSCRIBE_PLACEHOLDER },
  })
  for (const bad of SMUGGLED) assertThrows(() => fillUnsubscribe(letter, bad), TypeError)
})

Deno.test("refuses a mailto: image src", () => {
  assertThrows(
    () => linkedImage({ src: "mailto:a@example.com", alt: "", href: "https://example.com" }),
    TypeError,
  )
})

Deno.test("uses the caller's unsubscribe label in both parts, escaped in HTML", () => {
  const { html, text } = renderLetter({
    blocks: [],
    footer: {
      reason: "r",
      unsubscribeLink: "https://example.com/u",
      unsubscribeLabel: `Abmelden <b>`,
    },
  })
  assertStringIncludes(html, `>Abmelden &lt;b&gt;</a>`)
  assertStringIncludes(text, `Abmelden <b>: https://example.com/u`)
  assertFalse(html.includes(">Unsubscribe<"))
})

Deno.test("colours the footer text and links from the theme", () => {
  const { html } = renderLetter({
    blocks: [],
    footer: {
      reason: "r",
      unsubscribeLink: "https://example.com/u",
      links: [{ href: "https://example.com", label: "Site" }],
    },
    theme: { mutedColor: "#ff0000", linkColor: "#00ff00" },
  })
  assertStringIncludes(html, "color:#ff0000")
  assertEquals(html.split("color:#00ff00").length, 3)
})
