/**
 * A brand-free letter shell for mail an app sends to people who asked for it: a
 * newsletter, a confirmation, a welcome.
 *
 * The layout is a header slot, content blocks, an afterword slot and a small grey
 * footer holding the reason the reader gets the mail, an optional unsubscribe link
 * and optional extra links, under a hidden preheader. Nothing about a person, a
 * brand, a site or a campaign lives here, and no wording but the footer's
 * "Unsubscribe" default (see `footer.unsubscribeLabel`). An app supplies its own
 * `header` and `afterword`. The block helpers cover plain content (paragraph,
 * heading, list, button, linked image); a portrait beside a name, or a P.S. with a
 * link inside the prose, is a {@link LetterBlock} the app writes by hand, escaping
 * every value with `escapeHtml` from `@spy4x/email/html`:
 *
 * ```ts
 * const ps = (name: string, href: string): LetterBlock => ({
 *   html: `<p>P.S. <a href="${escapeHtml(href)}">${escapeHtml(name)}</a></p>`,
 *   text: `P.S. ${name}: ${href}`,
 * })
 * ```
 *
 * Every block is an HTML and a plain-text rendering of the same content. Every
 * caller value reaches the HTML through {@link escapeHtml}, links included. A link
 * whose scheme is not `https:`, `http:` or `mailto:`, or that contains whitespace or
 * a control character, throws a `TypeError` instead of rendering: escaping keeps
 * `javascript:alert(1)` a well-formed link, and `URL` ignores a newline that the
 * plain-text part would print as a second line.
 *
 * Inline styles on a light background, so a client that inverts the colours for
 * dark mode still shows the letter readably.
 * @module
 */
import { emailButton, escapeHtml, type HtmlShellTheme, htmlWrap } from "./html.ts"

/**
 * Stands where a reader's own unsubscribe link goes in a letter rendered once and sent many
 * times.
 */
export const UNSUBSCRIBE_PLACEHOLDER = "{{unsubscribe-link}}"

const HEADING_FONT = "Georgia,'Times New Roman',serif"
const BODY_FONT = "Arial,Helvetica,sans-serif"
const DEFAULT_THEME: HtmlShellTheme = {
  background: "#ffffff",
  color: "#1f2937",
  mutedColor: "#6b7280",
  linkColor: "#6b7280",
}

/** The default button: white text on a neutral blue. */
const DEFAULT_BUTTON_COLORS = { background: "#2563eb", color: "#ffffff" }

/** The letter's content: the same thing as HTML (already escaped) and as plain text. */
export interface LetterBlock {
  html: string
  text: string
}

/** A finished letter: the HTML part and the plain-text part. */
export interface Letter {
  html: string
  text: string
}

/** What {@link renderLetter} needs. */
export interface LetterInput {
  /** A block above the content, such as a sender's portrait and name. */
  header?: LetterBlock
  /** The content. */
  blocks: readonly LetterBlock[]
  /** Blocks after the content and before the footer, such as a P.S. or a reply line. */
  afterword?: readonly LetterBlock[]
  /** The small grey footer. */
  footer: {
    /** Why the reader gets this mail, one sentence. */
    reason: string
    /**
     * The reader's own unsubscribe link, or {@link UNSUBSCRIBE_PLACEHOLDER}. Omit it
     * when the mail goes to someone who has not subscribed yet.
     */
    unsubscribeLink?: string
    /** The word for the unsubscribe link, in both parts. Default `"Unsubscribe"`. */
    unsubscribeLabel?: string
    /** Extra links after the reason, such as the sender's site. */
    links?: readonly { href: string; label: string }[]
  }
  /** The hidden preview line the inbox shows next to the subject. */
  preheader?: string
  /**
   * Colours of the shell: `background` and `color` for the page and text, `mutedColor` for the
   * footer text, `linkColor` for the footer links. Defaults to a neutral light theme.
   */
  theme?: Partial<HtmlShellTheme>
  /** Width of the letter column in pixels. Default `600`. */
  maxWidth?: number
}

const LINKABLE_SCHEMES = ["https:", "http:", "mailto:"]
const IMAGE_SCHEMES = ["https:", "http:"]
/** Whitespace and control characters, which `URL` strips but the letter would print raw. */
function hasUnsafeLinkChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * Throw a `TypeError` unless `value` is an absolute `https:`, `http:` or `mailto:` URL.
 * The scheme is read with `URL`, so `JaVaScript:` and a leading newline do not slip past.
 */
function assertLink(value: string, name: string, schemes = LINKABLE_SCHEMES): void {
  if (hasUnsafeLinkChar(value)) {
    throw new TypeError(`${name} must not contain whitespace or control characters`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError(`${name} must be an absolute URL, got ${JSON.stringify(value)}`)
  }
  if (!schemes.includes(parsed.protocol)) {
    throw new TypeError(
      `${name} must use ${schemes.join(", ")}, got ${JSON.stringify(parsed.protocol)}`,
    )
  }
}

/** A paragraph of plain prose. */
export function paragraph(text: string): LetterBlock {
  return { html: `<p style="margin:0 0 16px">${escapeHtml(text)}</p>`, text }
}

/** A small heading, such as "In short". Upper case in the plain-text part. */
export function heading(text: string): LetterBlock {
  return {
    html:
      `<h2 style="margin:24px 0 8px;font-family:${HEADING_FONT};font-size:20px;line-height:1.3">${
        escapeHtml(text)
      }</h2>`,
    text: text.toUpperCase(),
  }
}

/** A bulleted list. Each line starts with `- ` in the plain-text part. */
export function bulletList(lines: readonly string[]): LetterBlock {
  const items = lines.map((line) => `<li style="margin:0 0 6px">${escapeHtml(line)}</li>`).join("")
  return {
    html: `<ul style="margin:0 0 16px;padding-left:20px">${items}</ul>`,
    text: lines.map((line) => `- ${line}`).join("\n"),
  }
}

/**
 * A filled button. The plain-text part is the label and the link on two lines.
 * `colors` default to white text on blue; both must be `#rgb` or `#rrggbb`.
 *
 * @throws {TypeError} when `href` is not an `https:`, `http:` or `mailto:` URL, or a colour is
 * not a hex colour.
 */
export function button(
  href: string,
  label: string,
  colors: { background: string; color: string } = DEFAULT_BUTTON_COLORS,
): LetterBlock {
  assertLink(href, "button href")
  return { html: emailButton({ href, label, ...colors }), text: `${label}:\n${href}` }
}

/**
 * A picture linked to `href`, `width` pixels wide at most (default 600) and as wide as the
 * column below that. It has no plain-text part, so `alt` is not repeated there.
 *
 * @throws {TypeError} when `src` is not an `https:` or `http:` URL, `href` is not an `https:`,
 * `http:` or `mailto:` URL, either contains whitespace or a control character, or `width` is not a finite positive number.
 */
export function linkedImage(
  { src, alt, href, width = 600 }: { src: string; alt: string; href: string; width?: number },
): LetterBlock {
  assertLink(src, "linkedImage src", IMAGE_SCHEMES)
  assertLink(href, "linkedImage href")
  if (!Number.isFinite(width) || width <= 0) {
    throw new TypeError(`linkedImage width must be a finite positive number, got ${width}`)
  }
  return {
    html: `<p style="margin:0 0 16px"><a href="${escapeHtml(href)}"><img src="${
      escapeHtml(src)
    }" alt="${
      escapeHtml(alt)
    }" width="${width}" style="display:block;width:100%;max-width:${width}px;height:auto;border:0;border-radius:6px"></a></p>`,
    text: "",
  }
}

/**
 * Wrap the blocks in the letter layout and return both parts.
 *
 * Block `html` is trusted as pre-escaped, exactly as `htmlWrap` treats its body: build blocks with
 * the helpers above. The footer's `reason`, link labels and links are escaped here.
 *
 * @throws {TypeError} when a footer link or `unsubscribeLink` is not an `https:`, `http:` or
 * `mailto:` URL (the placeholder is allowed for `unsubscribeLink`), or `theme` or `maxWidth`
 * is rejected by `htmlWrap`.
 */
export function renderLetter(input: LetterInput): Letter {
  const { footer } = input
  const unsubscribe = footer.unsubscribeLink
  if (unsubscribe !== undefined && unsubscribe !== UNSUBSCRIBE_PLACEHOLDER) {
    assertLink(unsubscribe, "footer.unsubscribeLink")
  }
  for (const link of footer.links ?? []) assertLink(link.href, "footer.links href")

  const theme = { ...DEFAULT_THEME, ...input.theme }
  const unsubscribeLabel = footer.unsubscribeLabel ?? "Unsubscribe"
  const htmlLinks = [
    ...(unsubscribe === undefined ? [] : [
      `<a href="${escapeHtml(unsubscribe)}" style="color:${theme.linkColor}">${
        escapeHtml(unsubscribeLabel)
      }</a>`,
    ]),
    ...(footer.links ?? []).map((link) =>
      `<a href="${escapeHtml(link.href)}" style="color:${theme.linkColor}">${
        escapeHtml(link.label)
      }</a>`
    ),
  ]
  const footerHtml =
    `<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.5;color:${theme.mutedColor}">${
      [escapeHtml(footer.reason), ...htmlLinks].join(" · ")
    }</p>`

  const blocksHtml = [
    ...(input.header ? [input.header.html] : []),
    ...input.blocks.map((b) => b.html),
    ...(input.afterword ?? []).map((b) => b.html),
    footerHtml,
  ].join("\n")

  const html = htmlWrap({
    body: `<div style="font-family:${BODY_FONT}">\n${blocksHtml}\n</div>`,
    maxWidth: input.maxWidth ?? 600,
    signaturePrefix: null,
    theme,
    ...(input.preheader ? { preheader: input.preheader } : {}),
  })

  const footerText = [
    footer.reason,
    ...(unsubscribe === undefined ? [] : [`${unsubscribeLabel}: ${unsubscribe}`]),
    ...(footer.links ?? []).map((link) => `${link.label}: ${link.href}`),
  ].join("\n")
  const textParts = [
    ...(input.header ? [input.header.text] : []),
    ...input.blocks.map((b) => b.text),
    ...(input.afterword ?? []).map((b) => b.text),
  ].filter((t) => t !== "")
  return { html, text: `${[...textParts, `-- \n${footerText}`].join("\n\n")}\n` }
}

/**
 * Put a reader's own link where {@link UNSUBSCRIBE_PLACEHOLDER} stands: escaped in the HTML part,
 * as it is in the plain-text part. A letter rendered once and filled here is byte-identical to one
 * rendered with `link` directly.
 *
 * @throws {TypeError} when `link` is not an `https:`, `http:` or `mailto:` URL.
 */
export function fillUnsubscribe(letter: Letter, link: string): Letter {
  assertLink(link, "unsubscribe link")
  const escaped = escapeHtml(link)
  // A function replacer: a string one would read `$&` and `$1` in a URL as patterns.
  return {
    html: letter.html.replaceAll(UNSUBSCRIBE_PLACEHOLDER, () => escaped),
    text: letter.text.replaceAll(UNSUBSCRIBE_PLACEHOLDER, () => link),
  }
}
