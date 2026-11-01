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
 * {@link renderMarkdownSegments} renders the same HTML and also splits it around component tags,
 * lines such as `<Chart year={2026} />`, so a page can put an interactive component between the
 * chunks.
 *
 * Parsing is `marked` with GitHub-flavoured Markdown (tables, task lists, strikethrough, bare
 * `www.` and e-mail autolinks). Kept out of the `@spy4x/platform` root export so that importing
 * the package does not load `marked`.
 *
 * @module
 */

import { Marked, type Token, type Tokens } from "marked"
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
 * A `Marked` instance with the safe renderer, which pushes each heading it renders onto
 * `headings`. Heading ids are unique within one instance, so each render makes its own.
 */
function safeMarked(headings: MarkdownHeading[]): Marked {
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
  return marked
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
  const html = safeMarked(headings).parse(markdown, { async: false })
  return { html, headings }
}

/** A component tag as written in the Markdown: its name, its props and where it is. */
export interface MarkdownComponent {
  /** The tag's name, such as `Chart`: a capital, then letters and digits. */
  tag: string
  /**
   * The props as written, not checked against any schema: validate them before use. String
   * values are raw text, not escaped; render them as text or attributes (Preact escapes both),
   * never as HTML.
   */
  props: Record<string, unknown>
  /** The 1-based line of the tag in the Markdown. */
  line: number
}

/** A piece of a rendered document: a chunk of HTML, or a component tag between two chunks. */
export type MarkdownSegment =
  | { kind: "html"; html: string }
  | ({ kind: "component" } & MarkdownComponent)

/** A component tag line that could not be read. The line renders as nothing. */
export interface MarkdownProblem {
  /** The 1-based line in the Markdown. */
  line: number
  /** What is wrong, starting with the tag, such as `<Chart>: prop "year" is given twice`. */
  message: string
}

/** What {@link renderMarkdownSegments} returns. */
export interface RenderedMarkdownSegments {
  /** The document in page order: HTML chunks, with the component tags between them. */
  segments: MarkdownSegment[]
  /** Every heading in page order, with the `id` its element carries, as {@link renderMarkdown}. */
  headings: MarkdownHeading[]
  /** Every component tag line that could not be read, in page order. Empty when all are fine. */
  problems: MarkdownProblem[]
}

/** A line that opens a component tag: up to three spaces, `<` and a capital letter. */
const TAG_START = /^ {0,3}<[A-Z]/
const TAG_OPEN = /^ {0,3}<([A-Z][A-Za-z0-9]*)/
const PROP_NAME = /[A-Za-z_][A-Za-z0-9_]*/y
const SPACE = /\s*/y

/** The token a component tag line becomes: the tag when it reads, a problem when it does not. */
interface ComponentToken {
  type: "markdownComponent"
  raw: string
  component?: MarkdownComponent
  problem?: MarkdownProblem
}

/**
 * Reads one self-closing tag, `<Name prop={json} other="text" />`, from a single line. Throws
 * with the reason when the line is anything else: a tag that does not close itself, an unquoted
 * value, invalid JSON, a repeated prop or text after the tag.
 */
function parseComponentTag(line: string): Omit<MarkdownComponent, "line"> {
  const open = TAG_OPEN.exec(line)!
  const tag = open[1]
  const props: Record<string, unknown> = {}
  let i = open[0].length
  for (;;) {
    SPACE.lastIndex = i
    const spaced = SPACE.exec(line)![0].length > 0
    i = SPACE.lastIndex
    if (line.startsWith("/>", i)) {
      if (line.slice(i + 2).trim() !== "") throw new Error("the tag must be alone on its line")
      return { tag, props }
    }
    if (i >= line.length || line[i] === ">") {
      throw new Error("the tag must close itself with `/>` on the same line")
    }
    PROP_NAME.lastIndex = i
    const name = spaced ? PROP_NAME.exec(line)?.[0] : undefined
    if (!name) throw new Error(`unexpected "${line.slice(i, i + 12)}"`)
    // Assigned, `__proto__` would replace the object's prototype instead of adding a prop.
    if (name === "__proto__") throw new Error(`prop "__proto__" is not allowed`)
    i += name.length
    if (line[i] !== "=") throw new Error(`prop "${name}" needs a value: {json} or "text"`)
    i++
    let value: unknown
    if (line[i] === '"') {
      const end = line.indexOf('"', i + 1)
      if (end < 0) throw new Error(`prop "${name}": unclosed string`)
      value = line.slice(i + 1, end)
      i = end + 1
    } else if (line[i] === "{") {
      const end = closingBrace(line, i)
      if (end < 0) throw new Error(`prop "${name}": unclosed {`)
      try {
        value = JSON.parse(line.slice(i + 1, end))
      } catch {
        throw new Error(`prop "${name}": ${line.slice(i, end + 1)} is not a JSON literal`)
      }
      i = end + 1
    } else {
      throw new Error(`prop "${name}" needs a value: {json} or "text"`)
    }
    if (Object.hasOwn(props, name)) throw new Error(`prop "${name}" is given twice`)
    props[name] = value
  }
}

/** The index of the `}` that closes the `{` at `start`, skipping braces in JSON strings, or -1. */
function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let j = start; j < text.length; j++) {
    const c = text[j]
    if (inString) {
      if (c === "\\") j++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return j
  }
  return -1
}

/**
 * Render Markdown like {@link renderMarkdown}, split into HTML chunks around component tags.
 *
 * A component tag is a self-closing, JSX-like tag alone on a line at the top level of the
 * document, its name starting with a capital: `<Chart year={2026} label="Sales" />`. A prop is a
 * JSON literal in braces or text in double quotes. The library keeps no list of components and
 * checks no props: map `tag` to a component and validate `props` with its schema. A tag in a code
 * block stays code.
 *
 * A line that starts like a tag (`<` and a capital) but does not read as one, or a tag inside a
 * list or a quote, renders as nothing and comes back in `problems` with its line. Show them in an
 * editor, or throw on a non-empty list to fail a build. Each HTML chunk holds whole top-level
 * blocks, with the same escaping and heading ids {@link renderMarkdown} gives.
 *
 * ```ts
 * const { segments, problems } = renderMarkdownSegments("Intro.\n\n<Chart year={2026} />\n")
 * // segments: [
 * //   { kind: "html", html: "<p>Intro.</p>\n" },
 * //   { kind: "component", tag: "Chart", props: { year: 2026 }, line: 3 },
 * // ]
 * // problems: []
 * ```
 */
export function renderMarkdownSegments(markdown: string): RenderedMarkdownSegments {
  const headings: MarkdownHeading[] = []
  const marked = safeMarked(headings)
  // `marked` reads the source with its line breaks normalized; offsets below index this string.
  const source = markdown.replace(/\r\n|\r/g, "\n")
  /** Where the top-level block being read starts, for a tag found inside it. */
  let blockStart = 0
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length

  marked.use({
    extensions: [{
      name: "markdownComponent",
      level: "block",
      // `marked` passes the paragraph without its first character, so only a match after a line
      // break is a line start. This lets a tag line end the paragraph above it.
      start: (src: string) => /\n {0,3}<[A-Z]/.exec(src)?.index,
      tokenizer(src: string, tokens: unknown[]): ComponentToken | undefined {
        const topLevel = tokens === this.lexer.tokens
        if (topLevel) blockStart = source.length - src.length
        if (!TAG_START.test(src)) return undefined
        const raw = /^[^\n]*(?:\n|$)/.exec(src)![0]
        // A nested tag's `src` is its block's inner text (a quote's `> ` removed), so its offset is
        // found by its text, searched from where the enclosing top-level block starts.
        const found = topLevel ? blockStart : source.indexOf(raw.trim(), blockStart)
        const line = lineAt(found < 0 ? blockStart : found)
        const name = TAG_OPEN.exec(raw)![1]
        if (!topLevel) {
          const message =
            `<${name}>: a component tag must sit at the top level, not in a list or a quote`
          return { type: "markdownComponent", raw, problem: { line, message } }
        }
        try {
          return { type: "markdownComponent", raw, component: { ...parseComponentTag(raw), line } }
        } catch (error) {
          const message = `<${name}>: ${(error as Error).message}`
          return { type: "markdownComponent", raw, problem: { line, message } }
        }
      },
      // Reached only for a tag nested in a list or a quote, which is a problem: it shows nothing.
      renderer: () => "",
    }],
  })

  const tokens = marked.lexer(markdown)
  const segments: MarkdownSegment[] = []
  const problems: MarkdownProblem[] = []
  let run: Token[] = []
  const flush = () => {
    if (run.length === 0) return
    // The lexer already resolved reference-style links over the whole document, so a chunk's
    // links work wherever their definitions sit.
    const html = marked.parser(run)
    if (html.trim()) segments.push({ kind: "html", html })
    run = []
  }
  for (const token of tokens) {
    if (token.type !== "markdownComponent") {
      run.push(token)
      continue
    }
    const { component } = token as ComponentToken
    if (component) {
      flush()
      segments.push({ kind: "component", ...component })
    }
  }
  flush()
  // Collected in source order, nested tags included, since every problem token is in the tree.
  marked.walkTokens(tokens, (token) => {
    const { problem } = token as ComponentToken
    if (token.type === "markdownComponent" && problem) problems.push(problem)
  })
  return { segments, headings, problems }
}
