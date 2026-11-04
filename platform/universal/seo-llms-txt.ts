/**
 * The `llms.txt` a site publishes for AI assistants. Public through `./seo.ts`.
 *
 * @module
 */

import { webUrl } from "./seo-canonical.ts"

/** One link in an `llms.txt` section. */
export interface LlmsTxtLink {
  /** The link text. */
  title: string
  /** Absolute `http`/`https` address of the page. */
  url: string
  /** What a reader finds there, written after the link. */
  description?: string
}

/** One `## Section` of an `llms.txt` and its links. */
export interface LlmsTxtSection {
  title: string
  links: readonly LlmsTxtLink[]
}

/** What an `llms.txt` says: the site's name, a one-paragraph summary and its sections. */
export interface LlmsTxtDocument {
  title: string
  summary: string
  sections: readonly LlmsTxtSection[]
}

/**
 * The text of an `/llms.txt` in the format llmstxt.org describes: `# Title`, a `> summary` line,
 * then each section as a `## Section` heading followed by `- [Title](url): description` lines.
 *
 * Line breaks inside a title, summary or description become spaces, so a value cannot start a
 * heading or a list item of its own. `\`, `[` and `]` in a link text are backslash-escaped, and
 * every address is normalised like a canonical one with its parentheses percent-encoded, so neither
 * can end the link early.
 *
 * @throws When an address is not an absolute `http`/`https` URL.
 */
export function llmsTxt({ title, summary, sections }: LlmsTxtDocument): string {
  const blocks = [`# ${oneLine(title)}`, `> ${oneLine(summary)}`]

  for (const section of sections) {
    const links = section.links.map(({ title, url, description }) => {
      const href = webUrl(url, "llms.txt url").href.replace(
        /[()]/g,
        (paren) => paren === "(" ? "%28" : "%29",
      )
      const text = oneLine(title).replace(/[\\[\]]/g, "\\$&")
      const note = description === undefined ? "" : `: ${oneLine(description)}`
      return `- [${text}](${href})${note}`
    })
    blocks.push([`## ${oneLine(section.title)}`, ...links].join("\n"))
  }

  return `${blocks.join("\n\n")}\n`
}

/** `value` with every run of whitespace that holds a line break collapsed to one space. */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]\s*/g, " ").trim()
}
