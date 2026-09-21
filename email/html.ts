/**
 * HTML escaping and the shared HTML email shell.
 *
 * Two rules, and mixing them up is the whole class of bug this module exists to
 * prevent:
 *
 * - {@link escapeHtml} escapes a **value** — anything that came from a user, a
 *   booking, a host name. Call it once per interpolated value, at the
 *   interpolation.
 * - {@link htmlWrap} takes **pre-escaped HTML** and does not touch it. It escapes
 *   only the fields it interpolates itself (the brand label and its link).
 *
 * So `htmlWrap({ body: \`<p>${escapeHtml(name)}</p>\` })` is correct and
 * `htmlWrap({ body: escapeHtml(\`<p>${name}</p>\`) })` is not: the second escapes
 * the markup too, and the recipient reads `<p>` instead of seeing a paragraph.
 * `'` is escaped as well as the four characters `mig` handled — an apostrophe is
 * harmless in element text and terminates a single-quoted attribute, and an
 * escaper that is safe only in one of the two positions is a trap.
 */

/**
 * Escape a value for interpolation into HTML element text or a double-quoted
 * attribute.
 *
 * `&` is replaced first, so a value that already reads `&amp;` comes out as
 * `&amp;amp;` and renders as the literal `&amp;` the caller passed. That is the
 * correct behaviour for an escaper and the reason it must be applied to raw
 * values only — see the module note on the shell.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/** Everything the shell interpolates around a body. */
export interface HtmlShellOptions {
  /**
   * The message body as HTML. **Not escaped** — the caller owns the markup and
   * must have escaped every value inside it already.
   */
  body: string
  /** Brand label in the header and the footer signature, escaped by the shell. */
  brand?: string
  /**
   * Link target for the header brand label, escaped by the shell. Plain text when
   * absent. It must be an absolute `http:`, `https:` or `mailto:` URL — see
   * {@link htmlWrap} on why anything else throws.
   */
  brandUrl?: string
  /**
   * Extra HTML appended after the body, before the footer signature. Not escaped;
   * same contract as `body`.
   */
  footer?: string
  /**
   * Colours for the shell. Defaults to {@link DEFAULT_HTML_SHELL_THEME}. Pass
   * {@link DARK_HTML_SHELL_THEME} for the look this function had before this
   * option existed. Every field must be a `#rgb` or `#rrggbb` hex colour — see
   * {@link htmlWrap} on why anything else throws.
   */
  theme?: Partial<HtmlShellTheme>
  /** Width, in pixels, of the letter column. Default `480`. */
  maxWidth?: number
  /**
   * Text before the linked or plain brand in the footer signature, shown only
   * when `brand` is set. Default `"— Sent by"`. Pass `null` to keep the header
   * brand block but drop the footer signature line entirely.
   */
  signaturePrefix?: string | null
}

/** The four colours {@link htmlWrap} draws the shell in. */
export interface HtmlShellTheme {
  /** Page and letter background. */
  background: string
  /** Body text. */
  color: string
  /** Footer signature text. */
  mutedColor: string
  /** The brand link, header and footer alike. */
  linkColor: string
}

/**
 * `htmlWrap`'s default look: a neutral light shell with no product association,
 * so a caller gets a plain, readable letter unless it asks for something else.
 */
export const DEFAULT_HTML_SHELL_THEME: HtmlShellTheme = Object.freeze({
  background: "#ffffff",
  color: "#1f2937",
  mutedColor: "#64748b",
  linkColor: "#2563eb",
})

/**
 * The look `htmlWrap` had before {@link HtmlShellOptions.theme} existed: a dark
 * navy body with light text and an orange brand link, ported as-is from `mig`.
 * Pass this as `theme` for a caller that already copied that appearance and
 * wants to keep it.
 */
export const DARK_HTML_SHELL_THEME: HtmlShellTheme = Object.freeze({
  background: "#0f172a",
  color: "#e2e8f0",
  mutedColor: "#64748b",
  linkColor: "#f97316",
})

/**
 * Wrap a body in the shared letter-shaped shell.
 *
 * Ported from `mig`'s `htmlWrap`, with the app-specific config removed: the
 * brand label and link were already options instead of a hard-coded product
 * name and `githubUrl`; the colours, the column width and the footer's
 * "Sent by" wording are options now too; a caller with no opinion gets a
 * neutral light shell ({@link DEFAULT_HTML_SHELL_THEME}) rather than one
 * `mig`'s own dark palette baked in as the only look. Nothing in this
 * repository imports `htmlWrap`, so nothing here needed the old default kept —
 * an outside caller that already copied `mig`'s look gets it back by passing
 * `theme: DARK_HTML_SHELL_THEME`.
 *
 * The letter column defaults to 480px so it reads as a letter instead of
 * stretching across a desktop pane; the background still reaches the viewport
 * edges. No inline `<style>` block: Gmail strips `<head>` styles, so every rule
 * that matters is an attribute.
 *
 * @throws {TypeError} when `brandUrl` is not an absolute `http:`, `https:` or
 * `mailto:` URL, or when a `theme` colour is not a `#rgb`/`#rrggbb` hex colour.
 * Escaping made `javascript:alert(1)` a perfectly well-formed link, and a shell
 * that quietly dropped it instead would hide the same mistake; a theme colour
 * that is not a plain hex value could close the `style` attribute early and
 * inject markup of its own. Both values come from a caller's configuration
 * rather than from a recipient, so a wrong one is a bug to surface, not input
 * to sanitise.
 */
export function htmlWrap(options: HtmlShellOptions): string {
  const theme: HtmlShellTheme = { ...DEFAULT_HTML_SHELL_THEME, ...options.theme }
  assertHexColor(theme.background, "theme.background")
  assertHexColor(theme.color, "theme.color")
  assertHexColor(theme.mutedColor, "theme.mutedColor")
  assertHexColor(theme.linkColor, "theme.linkColor")
  const maxWidth = options.maxWidth ?? 480

  const brand = options.brand === undefined ? "" : escapeHtml(options.brand)
  const header = brand === ""
    ? ""
    : `<div style="margin-bottom:16px">${brandAnchor(options, brand, theme)}</div>`
  const signaturePrefix = options.signaturePrefix === undefined
    ? "— Sent by"
    : options.signaturePrefix
  const signature = brand === "" || signaturePrefix === null
    ? ""
    : `<p style="color:${theme.mutedColor};font-size:14px;margin-top:24px">${
      escapeHtml(signaturePrefix)
    } ${brandAnchor(options, brand, theme)}</p>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:${theme.background};color:${theme.color};
             font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
             font-size:16px;line-height:1.6">
<div style="max-width:${maxWidth}px;margin:0 auto">
${header}
${options.body}
${options.footer ?? ""}
${signature}
</div>
</body></html>`
}

/**
 * The brand label, linked when a URL was supplied.
 *
 * `rel="noopener"` and `target="_blank"` are omitted on purpose: mail clients
 * open links in the system browser, so the opener-isolation concern is the mail
 * client's, and a `target` attribute is stripped by most of them anyway.
 */
function brandAnchor(
  options: HtmlShellOptions,
  escapedBrand: string,
  theme: HtmlShellTheme,
): string {
  if (options.brandUrl === undefined) return escapedBrand
  assertLinkableUrl(options.brandUrl)
  return `<a href="${
    escapeHtml(options.brandUrl)
  }" style="color:${theme.linkColor};font-weight:600;text-decoration:none">${escapedBrand}</a>`
}

/** A `#rgb` or `#rrggbb` hex colour, case-insensitive — nothing a browser reads as a CSS colour. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/

/**
 * Reject a theme colour that is not a plain hex value.
 *
 * Every colour here lands inside a double-quoted `style` attribute
 * (`background:${theme.background}`), so a value carrying a `"` could close
 * that attribute early and add markup of its own — a caller's configuration
 * mistake, not a recipient's, but one this shell should surface rather than
 * emit.
 */
function assertHexColor(value: string, fieldName: string): void {
  if (!HEX_COLOR_RE.test(value)) {
    throw new TypeError(
      `HtmlShellOptions.${fieldName} must be a #rgb or #rrggbb hex colour, got ${
        JSON.stringify(value)
      }`,
    )
  }
}

/** Schemes a mail client may follow from a link in a message. */
const LINKABLE_SCHEMES = ["http:", "https:", "mailto:"]

/**
 * Reject a URL whose scheme does not belong in a mail link.
 *
 * The scheme is read with `URL`, not with a prefix test: `\njavascript:alert(1)`,
 * `JaVaScript:alert(1)` and `java\0script:alert(1)` all parse to the same scheme
 * that a string comparison would miss. A relative URL has no meaning in a message
 * that is read outside any page, so it is rejected with everything else.
 */
function assertLinkableUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(
      `HtmlShellOptions.brandUrl must be an absolute URL, got ${JSON.stringify(value)}`,
    )
  }
  if (!LINKABLE_SCHEMES.includes(parsed.protocol)) {
    throw new TypeError(
      `HtmlShellOptions.brandUrl must use ${LINKABLE_SCHEMES.join(", ")}, got ` +
        JSON.stringify(parsed.protocol),
    )
  }
}
