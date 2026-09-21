// Behaviour tests for HTML escaping and the shared shell.
//
// The escaping half is asserted on the five characters that matter; the shell
// half is asserted on the composition rule — a value is escaped exactly once, by
// `escapeHtml` at the interpolation, and the shell never escapes its body.

import { assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert"
import { escapeHtml, htmlWrap } from "./html.ts"

Deno.test("escapes the five HTML metacharacters", () => {
  assertEquals(escapeHtml("<"), "&lt;")
  assertEquals(escapeHtml(">"), "&gt;")
  assertEquals(escapeHtml("&"), "&amp;")
  assertEquals(escapeHtml('"'), "&quot;")
  assertEquals(escapeHtml("'"), "&#39;")
})

Deno.test("escapes a script tag as text", () => {
  assertEquals(
    escapeHtml('<script>alert("x")</script>'),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
  )
})

Deno.test("escapes the ampersand before the rest, so an escaped value stays readable", () => {
  // Already-escaped input is data, not markup: it must come out as the literal
  // text the caller passed, never as a second escape of the entity.
  assertEquals(escapeHtml("&lt;"), "&amp;lt;")
  assertEquals(escapeHtml("&amp;"), "&amp;amp;")
})

Deno.test("escapes an apostrophe, which terminates a single-quoted attribute", () => {
  assertEquals(escapeHtml("it's"), "it&#39;s")
  assertFalse(escapeHtml("it's").includes("'"))
})

Deno.test("leaves non-HTML text alone", () => {
  assertEquals(escapeHtml("Café — 10:00 (Europe/Berlin)"), "Café — 10:00 (Europe/Berlin)")
})

Deno.test("escapes a value exactly once when composed with the shell", () => {
  const name = "Ben & Jerry's <b>parlour</b>"
  const html = htmlWrap({ body: `<p>${escapeHtml(name)}</p>` })

  assertStringIncludes(html, "<p>Ben &amp; Jerry&#39;s &lt;b&gt;parlour&lt;/b&gt;</p>")
  // The markup the caller wrote survives; only the interpolated value is escaped.
  assertFalse(html.includes("&lt;p&gt;"))
  assertFalse(html.includes("&amp;lt;"))
})

Deno.test("does not escape the body the shell is handed", () => {
  const html = htmlWrap({ body: "<p>already <strong>escaped</strong></p>" })
  assertStringIncludes(html, "<p>already <strong>escaped</strong></p>")
})

Deno.test("renders a body inside a doctype and a utf-8 charset", () => {
  const html = htmlWrap({ body: "<p>hi</p>" })
  assertEquals(html.startsWith("<!doctype html>"), true)
  assertStringIncludes(html, '<meta charset="utf-8">')
  assertStringIncludes(html, '<html lang="en">')
})

Deno.test("escapes the brand label and its link", () => {
  const html = htmlWrap({
    body: "<p>hi</p>",
    brand: "Ben & Co",
    brandUrl: 'https://example.com/?q=a&b="c"',
  })

  assertStringIncludes(html, ">Ben &amp; Co</a>")
  assertStringIncludes(html, "https://example.com/?q=a&amp;b=&quot;c&quot;")
  assertFalse(html.includes(">Ben & Co<"))
})

Deno.test("renders the brand as plain text when no link is given", () => {
  const html = htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co" })
  assertStringIncludes(html, "— Sent by Ben &amp; Co</p>")
  assertStringIncludes(html, '<div style="margin-bottom:16px">Ben &amp; Co</div>')
  assertFalse(html.includes("<a href"))
})

Deno.test("omits the brand block and the signature when no brand is given", () => {
  const html = htmlWrap({ body: "<p>hi</p>" })
  assertFalse(html.includes("Sent by"))
  assertFalse(html.includes("<a href"))
  assertStringIncludes(html, "<p>hi</p>")
})

Deno.test("appends a footer without escaping it", () => {
  const html = htmlWrap({ body: "<p>hi</p>", footer: '<p><a href="https://x.example">x</a></p>' })
  assertStringIncludes(html, '<p><a href="https://x.example">x</a></p>')
})

Deno.test("refuses a brand link a mail client should not follow", () => {
  // Escaping leaves `javascript:alert(1)` a perfectly well-formed link: the
  // characters that need escaping are not the ones that make the scheme
  // dangerous. Each spelling below is one a string comparison against
  // "javascript:" would miss, and every one parses to the same scheme.
  for (
    const brandUrl of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
    ]
  ) {
    assertThrows(
      () => htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", brandUrl }),
      TypeError,
      "brandUrl must use",
      `brandUrl ${JSON.stringify(brandUrl)} must be refused`,
    )
  }
})

Deno.test("refuses a brand link that is not an absolute URL", () => {
  // A message is read outside any page, so a relative link resolves against
  // nothing and is a configuration mistake rather than a working link.
  assertThrows(
    () => htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", brandUrl: "/pricing" }),
    TypeError,
    "brandUrl must be an absolute URL",
  )
})

Deno.test("links a brand to the schemes a mail client does follow", () => {
  for (const brandUrl of ["https://example.com/", "http://example.com/", "mailto:hi@example.com"]) {
    const html = htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", brandUrl })
    assertStringIncludes(html, `<a href="${brandUrl}"`)
  }
})
