/**
 * A forgiving full-text search for site and app search boxes, on the server and in the browser.
 *
 * Built on MiniSearch: it ranks, tokenises and finds prefixes and typos. This module adds what a
 * person expects of a search box:
 *
 * - **One spelling for every word.** Index and query words are folded the same way: lower case,
 *   accents removed, `ё` read as `е`, Cyrillic spelled in Latin letters, and `kh` read as `h` and
 *   `y` and `j` as `i`. So `gosuslugi`, `gosuslugy` and `госуслуги` all find `ГосУслуги`.
 * - **Aliases.** An entry's other names weigh as much as its label, and a hit says which alias
 *   matched, so the UI can show why it was found. Field weights: aliases = label > keywords >
 *   detail > text.
 * - **Three passes**, stopping at the first that finds anything: every word as a word prefix; the
 *   same query read in the other keyboard layout (ЙЦУКЕН and QWERTY); then one typo allowed in
 *   words of four letters or more. `correction` says which pass answered.
 * - **Marked text without HTML.** `labelParts`, `detailParts` and a snippet of about 90 characters
 *   around the first body hit are runs of text, each marked as matched or not.
 * - **A prebuilt index.** A server calls `createIndex` and serves `JSON.stringify(index)`; the
 *   browser calls `loadIndex` on it, which is several times faster than indexing again.
 *
 * @example An entry with aliases
 * ```ts
 * import { createIndex, loadIndex } from "@spy4x/search"
 *
 * const index = createIndex([
 *   { label: "Тёмная тема", aliases: ["dark mode", "night theme"], href: "/settings/theme" },
 *   { label: "ГосУслуги", detail: "Public services portal", href: "/gosuslugi" },
 * ])
 *
 * index.search("dark").hits[0].alias // "dark mode"
 * index.search("gosuslugy").hits[0].entry.href // "/gosuslugi"
 * index.search("ujceckeub").correction // "layout": typed in the wrong layout
 *
 * // On the server: write the index to `/search.json`. In the browser: load it as it is.
 * const json = JSON.stringify(index)
 * loadIndex(json).search("темная").hits[0].labelParts
 * // [{ text: "Тёмная", match: true }, { text: " тема", match: false }]
 * ```
 *
 * @module
 */

import MiniSearch, { type AsPlainObject, type Options, type SearchResult } from "minisearch"
import { cyrillicToLatin, fold, swapLayout } from "@spy4x/platform/universal/text"

/** One thing a person can find: a page, a section, a setting, an action. */
export interface SearchEntry {
  /** The name the UI shows. */
  label: string
  /** Other names for the same thing; they weigh as much as the label. */
  aliases?: string[]
  /** Words a person may search for that the UI does not show. */
  keywords?: string[]
  /** A short line under the label. */
  detail?: string
  /** The body text, searched and used for the snippet. */
  text?: string
  /** The section the UI lists the entry under. */
  group?: string
  /** Where the entry leads. */
  href?: string
  /** The caller's own id of the entry. */
  id?: string
}

/** A run of text, marked when it is a word the query matched. */
export interface TextPart {
  text: string
  match: boolean
}

/** One entry the query found, with its text ready to draw. */
export interface SearchHit<E extends SearchEntry = SearchEntry> {
  /** The entry as it was passed to {@link createIndex}. */
  entry: E
  /** MiniSearch's relevance score; hits are sorted by it, highest first. */
  score: number
  /** The label in runs, the matched words marked. */
  labelParts: TextPart[]
  /** The detail in runs, the matched words marked; empty when the entry has no detail. */
  detailParts: TextPart[]
  /** About 90 characters of the body around its first matched word, when the body matched. */
  snippet?: TextPart[]
  /** The first alias that matched, when an alias matched. */
  alias?: string
}

/** What {@link SearchIndex.search} returns. */
export interface SearchResults<E extends SearchEntry = SearchEntry> {
  /** Best first; equal scores keep the order the entries were passed in. */
  hits: SearchHit<E>[]
  /**
   * Which pass answered: `"layout"` when the query was read in the other keyboard layout,
   * `"typo"` when one typo was allowed, absent when the query matched as typed.
   */
  correction?: "layout" | "typo"
}

/** The plain object {@link SearchIndex.toJSON} returns and {@link loadIndex} reads. */
export interface SearchIndexJSON<E extends SearchEntry = SearchEntry> {
  entries: E[]
  index: AsPlainObject
}

/** Options of {@link SearchIndex.search}. */
export interface SearchOptions {
  /**
   * The most hits to return, best first; all of them by default. Marking text costs more than
   * finding it, so a search box passes the number of rows it shows.
   */
  limit?: number
}

/** A built or loaded index. */
export interface SearchIndex<E extends SearchEntry = SearchEntry> {
  /** Finds the entries that match `query`; an empty query finds nothing. */
  search(query: string, options?: SearchOptions): SearchResults<E>
  /** The index as a plain object, for `JSON.stringify` and {@link loadIndex}. */
  toJSON(): SearchIndexJSON<E>
}

const FIELDS = ["label", "aliases", "keywords", "detail", "text"]
const BOOST = { label: 3, aliases: 3, keywords: 2, detail: 1.5, text: 1 }
/** The shortest folded word the typo pass lets differ by one edit. */
const MIN_TYPO_LENGTH = 4
const SNIPPET_LENGTH = 90
/** How much of the snippet comes before its first matched word. */
const SNIPPET_LEAD = 30
const WORD = /[\p{L}\p{N}]+/gu

/** What MiniSearch indexes: the entry and its position in the input, which is its id. */
interface Indexed {
  order: number
  entry: SearchEntry
}

/**
 * Folds one word so that every spelling of it meets in one form: {@link fold}, then
 * {@link cyrillicToLatin}, then `kh` as `h` and `y` and `j` as `i`.
 */
function foldWord(word: string): string {
  return cyrillicToLatin(fold(word)).replaceAll("kh", "h").replace(/[yj]/g, "i")
}

function wordsOf(text: string): string[] {
  return text.match(WORD) ?? []
}

const OPTIONS: Options<Indexed> = {
  idField: "order",
  fields: FIELDS,
  extractField: (doc, field) =>
    field === "order" ? doc.order : doc.entry[field as keyof SearchEntry],
  stringifyField: (value) => Array.isArray(value) ? value.join(" ") : String(value),
  tokenize: wordsOf,
  processTerm: (term) => foldWord(term) || null,
  searchOptions: { boost: BOOST, prefix: true, combineWith: "AND" },
}

const TYPO = {
  fuzzy: (term: string) => term.length >= MIN_TYPO_LENGTH ? 1 : false,
}

/**
 * Builds an index over `entries`. Each entry needs a `label`.
 *
 * @throws When an entry has no `label` string.
 */
export function createIndex<E extends SearchEntry>(entries: E[]): SearchIndex<E> {
  entries.forEach((entry, order) => {
    if (typeof entry?.label !== "string") throw new Error(`Search entry ${order} has no label`)
  })
  const mini = new MiniSearch<Indexed>(OPTIONS)
  mini.addAll(entries.map((entry, order) => ({ order, entry })))
  return new Index(entries, mini)
}

/**
 * Loads an index that {@link createIndex} built, from its JSON text or the parsed object.
 *
 * @throws When `json` is not a serialised index.
 */
export function loadIndex<E extends SearchEntry = SearchEntry>(
  json: string | SearchIndexJSON<E>,
): SearchIndex<E> {
  const data: SearchIndexJSON<E> = typeof json === "string" ? JSON.parse(json) : json
  if (!Array.isArray(data?.entries) || typeof data.index !== "object" || data.index === null) {
    throw new Error("Not a serialised search index: expected { entries, index }")
  }
  return new Index(data.entries, MiniSearch.loadJS<Indexed>(data.index, OPTIONS))
}

class Index<E extends SearchEntry> implements SearchIndex<E> {
  constructor(private readonly entries: E[], private readonly mini: MiniSearch<Indexed>) {}

  search(query: string, options?: SearchOptions): SearchResults<E> {
    const limit = options?.limit ?? Infinity
    let found = this.mini.search(query)
    if (found.length) return { hits: this.hits(found, limit) }
    found = this.mini.search(swapLayout(query))
    if (found.length) return { hits: this.hits(found, limit), correction: "layout" }
    found = this.mini.search(query, TYPO)
    if (found.length) return { hits: this.hits(found, limit), correction: "typo" }
    return { hits: [] }
  }

  toJSON(): SearchIndexJSON<E> {
    return { entries: this.entries, index: this.mini.toJSON() }
  }

  private hits(found: SearchResult[], limit: number): SearchHit<E>[] {
    return found
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, limit)
      .map((result) => {
        const entry = this.entries[result.id]
        const terms = new Set(result.terms)
        const hit: SearchHit<E> = {
          entry,
          score: result.score,
          labelParts: markWords(entry.label, terms),
          detailParts: entry.detail ? markWords(entry.detail, terms) : [],
        }
        const snippet = entry.text && snippetOf(entry.text, terms)
        if (snippet) hit.snippet = snippet
        const alias = entry.aliases?.find((alias) =>
          wordsOf(alias).some((word) => terms.has(foldWord(word)))
        )
        if (alias) hit.alias = alias
        return hit
      })
  }
}

/** `text` in runs, each word whose folded form is in `terms` marked. */
function markWords(text: string, terms: Set<string>): TextPart[] {
  const parts: TextPart[] = []
  let rest = 0
  for (const word of text.matchAll(WORD)) {
    if (!terms.has(foldWord(word[0]))) continue
    if (word.index > rest) parts.push({ text: text.slice(rest, word.index), match: false })
    parts.push({ text: word[0], match: true })
    rest = word.index + word[0].length
  }
  if (rest < text.length) parts.push({ text: text.slice(rest), match: false })
  return parts
}

/**
 * About {@link SNIPPET_LENGTH} characters of `text` around its first word in `terms`, cut at
 * spaces, with `…` where text was cut off, and the matched words marked.
 */
function snippetOf(text: string, terms: Set<string>): TextPart[] | undefined {
  text = text.replace(/\s+/g, " ").trim()
  const hit = [...text.matchAll(WORD)].find((word) => terms.has(foldWord(word[0])))
  if (!hit) return undefined
  let start = Math.max(0, Math.min(hit.index - SNIPPET_LEAD, text.length - SNIPPET_LENGTH))
  if (start > 0) {
    const space = text.indexOf(" ", start - 1)
    start = space >= 0 && space < hit.index ? space + 1 : hit.index
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH)
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end)
    end = Math.max(space, hit.index + hit[0].length)
  }
  const parts = markWords(text.slice(start, end), terms)
  if (start > 0) prepend(parts, "…")
  if (end < text.length) append(parts, "…")
  return parts
}

function prepend(parts: TextPart[], text: string): void {
  if (parts[0]?.match === false) parts[0] = { text: text + parts[0].text, match: false }
  else parts.unshift({ text, match: false })
}

function append(parts: TextPart[], text: string): void {
  const last = parts.at(-1)
  if (last?.match === false) parts[parts.length - 1] = { text: last.text + text, match: false }
  else parts.push({ text, match: false })
}
