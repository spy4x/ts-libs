// Behaviour tests for HTML escaping and the shared shell.
//
// The escaping half is asserted on the five characters that matter; the shell
// half is asserted on the composition rule — a value is escaped exactly once, by
// `escapeHtml` at the interpolation, and the shell never escapes its body.

import { assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert"
import { DARK_HTML_SHELL_THEME, DEFAULT_HTML_SHELL_THEME, escapeHtml, htmlWrap } from "./html.ts"

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

// --- issue #88's fifth finding: the shell had one app's theme baked in ------

Deno.test("defaults to a neutral light shell, not the old dark theme", () => {
  const html = htmlWrap({ body: "<p>hi</p>" })
  assertStringIncludes(html, `background:${DEFAULT_HTML_SHELL_THEME.background}`)
  assertStringIncludes(html, `color:${DEFAULT_HTML_SHELL_THEME.color}`)
  // The dark navy background and the orange link colour this function used to
  // hard-code must be gone from the default output.
  assertFalse(html.includes("#0f172a"))
  assertFalse(html.includes("#f97316"))
})

Deno.test("restores the pre-theme look exactly via DARK_HTML_SHELL_THEME", () => {
  const html = htmlWrap({
    body: "<p>hi</p>",
    brand: "Ben & Co",
    brandUrl: "https://example.com",
    theme: DARK_HTML_SHELL_THEME,
  })
  assertStringIncludes(html, "background:#0f172a;color:#e2e8f0")
  assertStringIncludes(html, "color:#f97316;font-weight:600")
})

Deno.test("applies a partial theme over the defaults", () => {
  const html = htmlWrap({ body: "<p>hi</p>", theme: { background: "#000000" } })
  assertStringIncludes(html, `background:#000000;color:${DEFAULT_HTML_SHELL_THEME.color}`)
})

Deno.test("refuses a theme colour that is not a plain hex value", () => {
  // A value that could close the style attribute early and inject markup of
  // its own — a caller's configuration mistake, surfaced rather than emitted.
  assertThrows(
    () => htmlWrap({ body: "<p>hi</p>", theme: { background: '"onmouseover="alert(1)' } }),
    TypeError,
    "theme.background must be a #rgb or #rrggbb hex colour",
  )
  assertThrows(
    () => htmlWrap({ body: "<p>hi</p>", theme: { linkColor: "red" } }),
    TypeError,
    "theme.linkColor must be a #rgb or #rrggbb hex colour",
  )
})

// Every one of the four theme fields lands inside a double-quoted `style`
// attribute, and each has its own `assertHexColor` call in `htmlWrap` — a
// review round 1 finding was that deleting only the `mutedColor` (or, by the
// same reading, the `color`) call left the suite green, because no test asked
// for either. This loop asks for all four, plus three shapes that a narrower
// pattern (no `^`, no `$`) would let through: appended markup, a leading
// character before the `#`, and a trailing newline.
const THEME_FIELDS = ["background", "color", "mutedColor", "linkColor"] as const
const REFUSED_COLOURS = ['#fff"><script>', "x#fff", "#fff\n"]

for (const field of THEME_FIELDS) {
  for (const value of REFUSED_COLOURS) {
    Deno.test(`refuses theme.${field} = ${JSON.stringify(value)}`, () => {
      assertThrows(
        () => htmlWrap({ body: "<p>hi</p>", theme: { [field]: value } }),
        TypeError,
        `theme.${field} must be a #rgb or #rrggbb hex colour`,
      )
    })
  }
}

Deno.test("widens or narrows the letter column via maxWidth", () => {
  const html = htmlWrap({ body: "<p>hi</p>", maxWidth: 600 })
  assertStringIncludes(html, "max-width:600px")
  assertFalse(html.includes("max-width:480px"))
})

Deno.test("defaults the letter column to 480px", () => {
  assertStringIncludes(htmlWrap({ body: "<p>hi</p>" }), "max-width:480px")
})

// The type says `number`, but nothing stops an untyped caller (plain JS, or a
// `.ts` file that casts around the type) from reaching htmlWrap with
// something else, and maxWidth lands unquoted inside a style attribute with
// no escaping possible for a string value.
Deno.test("refuses a maxWidth that would break out of the style attribute or inject CSS", () => {
  for (
    const maxWidth of [
      '480px"><script>alert(1)</script><i x="',
      "480px;background:url(javascript:alert(1))",
    ] as const
  ) {
    assertThrows(
      // deno-lint-ignore no-explicit-any
      () => htmlWrap({ body: "<p>hi</p>", maxWidth: maxWidth as any }),
      TypeError,
      "maxWidth must be a finite positive number",
      `maxWidth ${JSON.stringify(maxWidth)} must be refused`,
    )
  }
})

Deno.test("refuses a non-finite or non-positive maxWidth", () => {
  for (const maxWidth of [NaN, Infinity, -Infinity, -5, 0]) {
    assertThrows(
      () => htmlWrap({ body: "<p>hi</p>", maxWidth }),
      TypeError,
      "maxWidth must be a finite positive number",
      `maxWidth ${maxWidth} must be refused`,
    )
  }
})

Deno.test("overrides the footer signature's wording via signaturePrefix", () => {
  const html = htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", signaturePrefix: "Courtesy of" })
  assertStringIncludes(html, "Courtesy of Ben &amp; Co</p>")
  assertFalse(html.includes("Sent by"))
})

Deno.test("escapes a caller-supplied signaturePrefix", () => {
  const html = htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", signaturePrefix: "<b>Sent</b> by" })
  assertStringIncludes(html, "&lt;b&gt;Sent&lt;/b&gt; by Ben &amp; Co</p>")
})

Deno.test("omits the signature line but keeps the header brand when signaturePrefix is null", () => {
  const html = htmlWrap({ body: "<p>hi</p>", brand: "Ben & Co", signaturePrefix: null })
  assertFalse(html.includes("Sent by"))
  assertStringIncludes(html, '<div style="margin-bottom:16px">Ben &amp; Co</div>')
})
