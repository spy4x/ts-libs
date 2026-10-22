/**
 * Markdown to HTML that is safe to put on a public page, even when the Markdown came from someone
 * the page's visitors should not have to trust (an operator in an admin panel, a user's note).
 *
 * - **Raw HTML is shown, never run.** An HTML block or inline tag in the source (`<script>`,
 *   `<img onerror>`, `<iframe>`) is escaped and appears as text.
 * - **Link and image addresses are allowed only for `http`, `https`, `mailto` and relative
 *   paths.** Anything else (`javascript:`, `data:`, `vbscript:`) is dropped: a link keeps its text
 *   without the link, an image becomes its alt text. The scheme is read the way a browser reads it,
 *   after removing the tabs, line breaks and outer control characters a browser ignores.
 * - **Every attribute value is escaped** for the double-quoted attribute it goes into.
 * - **An external link** (`http`, `https` or protocol-relative `//host`) gets
 *   `rel="noopener noreferrer"`, and every image `loading="lazy" decoding="async"`.
 * - **Every heading gets a stable `id`** from its text ({@link slugify}); a repeat gets `-2`,
 *   `-3`. The headings come back in page order for an "On this page" list.
 *
 * Parsing is `marked` with GitHub-flavoured Markdown (tables, task lists, strikethrough, bare
 * `www.` and e-mail autolinks). Kept out of the `@spy4x/platform` root export so that importing
 * the package does not load `marked`.
 *
 * @module
 */

import { Marked, type Tokens } from "marked"
import { slugify } from "./text.ts"

/** One heading of a rendered document, for its table of contents. */
export interface MarkdownHeading {
  /** 1 for `#`, 2 for `##`, and so on. */
  depth: number
  /** The heading's `id` in the HTML, without `#`. */
  id: string
  /** The heading's plain text, not escaped: escape it once where you print it. */
  text: string
}

/** What {@link renderMarkdown} returns. */
export interface RenderedMarkdown {
  /** The document as HTML, with no raw HTML and no unsafe address in it. */
  html: string
  /** Every heading in page order, with the `id` its element carries. */
  headings: MarkdownHeading[]
}

/** The schemes a link or image may use; any other scheme drops the address. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"])
/** A URL scheme as the URL parser reads it: a letter, then letters, digits, `+`, `-` or `.`. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i
/** Characters the URL parser removes anywhere in an address. */
const URL_REMOVED = /[\t\n\r]/g
/** C0 controls and spaces the URL parser trims from both ends of an address. */
// deno-lint-ignore no-control-regex
const URL_TRIMMED = /^[\u0000- ]+|[\u0000- ]+$/g

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

/** `value` with every `&<>"'` escaped, so it shows literally in text or an attribute. */
function escapeAll(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char])
}

/**
 * `value` with `<>"'` escaped, and `&` too unless it starts an entity reference, so text the
 * author wrote as `&copy;` still shows `©`. Safe in element text and a quoted attribute.
 */
function escapeText(value: string): string {
  return value.replace(
    /[<>"']|&(?!#\d{1,7};|#[Xx][a-fA-F0-9]{1,6};|\w+;)/g,
    (char) => HTML_ENTITIES[char],
  )
}

/** Turns the few entities `marked`'s plain-text renderer leaves back into characters. */
function decodeText(value: string): string {
  return value.replace(
    /&(lt|gt|quot|#39|amp);/g,
    (_, name: string) => ({ lt: "<", gt: ">", quot: '"', "#39": "'", amp: "&" })[name]!,
  )
}

/** A link or image address that passed the scheme check, ready for an attribute. */
interface SafeUrl {
  /** Escaped for a double-quoted attribute. */
  attribute: string
  /** Points to another site: `http`, `https` or protocol-relative. */
  external: boolean
}

/**
 * The address a browser would follow for `href`, or `null` when its scheme is not allowed.
 *
 * The check runs on the address a browser would see — tabs and line breaks removed, control
 * characters and spaces trimmed — and that same address is what gets printed, fully escaped, so
 * no entity in the source can turn into a scheme after the check.
 */
function safeUrl(href: string): SafeUrl | null {
  const cleaned = href.replace(URL_REMOVED, "").replace(URL_TRIMMED, "")
  const scheme = SCHEME.exec(cleaned)?.[1].toLowerCase()
  if (scheme !== undefined && !ALLOWED_SCHEMES.has(scheme)) return null
  let encoded: string
  try {
    // Percent-encodes spaces and non-ASCII like `marked` does, keeping existing `%XX` escapes.
    encoded = encodeURI(cleaned).replace(/%25([0-9a-fA-F]{2})/g, "%$1")
  } catch {
    return null // A lone surrogate: not an address anything can follow.
  }
  return {
    attribute: escapeAll(encoded),
    external: scheme === "http" || scheme === "https" || cleaned.startsWith("//"),
  }
}

/**
 * Render Markdown to HTML that is safe to put on a public page, plus its headings.
 *
 * See the module documentation for what is escaped, dropped and added. Each call is independent:
 * heading ids start over, so the same Markdown always gives the same HTML.
 *
 * ```ts
 * const { html, headings } = renderMarkdown("## Setup\n\nRun it.")
 * // html: '<h2 id="setup">Setup</h2>\n<p>Run it.</p>\n'
 * // headings: [{ depth: 2, id: "setup", text: "Setup" }]
 * ```
 */
export function renderMarkdown(markdown: string): RenderedMarkdown {
  const headings: MarkdownHeading[] = []
  const usedIds = new Set<string>()

  /** `base`, or the first of `base-2`, `base-3`, … no earlier heading took. */
  const uniqueId = (base: string): string => {
    let id = base
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`
    usedIds.add(id)
    return id
  }

  const marked = new Marked({ gfm: true, async: false })
  marked.use({
    renderer: {
      html({ text, block }: Tokens.HTML | Tokens.Tag) {
        return block ? `<p>${escapeAll(text.trimEnd())}</p>\n` : escapeAll(text)
      },
      text(token: Tokens.Text | Tokens.Escape) {
        // After an inline tag such as `<code>`, `marked` flags the following text as already
        // escaped and would print it raw. The tag itself is escaped above, so that text is plain
        // text and is escaped like any other.
        if ("escaped" in token && token.escaped && !token.tokens) return escapeText(token.text)
        return false
      },
      link({ href, title, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens)
        const url = safeUrl(href)
        if (url === null) return inner
        const titleAttr = title ? ` title="${escapeText(title)}"` : ""
        const rel = url.external ? ` rel="noopener noreferrer"` : ""
        return `<a href="${url.attribute}"${titleAttr}${rel}>${inner}</a>`
      },
      image({ href, title, text, tokens }: Tokens.Image) {
        const alt = escapeText(
          tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text,
        )
        const url = safeUrl(href)
        if (url === null) return alt
        const titleAttr = title ? ` title="${escapeText(title)}"` : ""
        return `<img src="${url.attribute}" alt="${alt}"${titleAttr} loading="lazy" decoding="async">`
      },
      heading({ tokens, depth }: Tokens.Heading) {
        const text = decodeText(this.parser.parseInline(tokens, this.parser.textRenderer))
          .replace(/\s+/g, " ").trim()
        const id = uniqueId(slugify(text) || "section")
        headings.push({ depth, id, text })
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`
      },
    },
  })

  const html = marked.parse(markdown, { async: false })
  return { html, headings }
}
