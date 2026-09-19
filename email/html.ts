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
  /** Link target for the header brand label, escaped by the shell. Plain text when absent. */
  brandUrl?: string
  /**
   * Extra HTML appended after the body, before the footer signature. Not escaped;
   * same contract as `body`.
   */
  footer?: string
}

/**
 * Wrap a body in the shared letter-shaped shell.
 *
 * Ported from `mig`'s `htmlWrap`, with the app-specific config removed: the brand
 * label and link are options now instead of a hard-coded product name and
 * `githubUrl`. The dark palette is kept, because a mail client that drops the
 * background colour then renders light text on white — the reason `mig` chose a
 * dark body with light text rather than the reverse.
 *
 * The body is constrained to 480px so a letter reads as a letter instead of
 * stretching across a desktop pane; the background still reaches the viewport
 * edges. No inline `<style>` block: Gmail strips `<head>` styles, so every rule
 * that matters is an attribute.
 */
export function htmlWrap(options: HtmlShellOptions): string {
  const brand = options.brand === undefined ? "" : escapeHtml(options.brand)
  const header = brand === ""
    ? ""
    : `<div style="margin-bottom:16px">${brandAnchor(options, brand)}</div>`
  const signature = brand === ""
    ? ""
    : `<p style="color:#64748b;font-size:14px;margin-top:24px">— Sent by ${
      brandAnchor(options, brand)
    }</p>`

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#0f172a;color:#e2e8f0;
             font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;
             font-size:16px;line-height:1.6">
<div style="max-width:480px;margin:0 auto">
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
function brandAnchor(options: HtmlShellOptions, escapedBrand: string): string {
  if (options.brandUrl === undefined) return escapedBrand
  return `<a href="${
    escapeHtml(options.brandUrl)
  }" style="color:#f97316;font-weight:600;text-decoration:none">${escapedBrand}</a>`
}
