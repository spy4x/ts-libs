/**
 * The catalog format shared by the translator (`i18n.ts`) and the catalog checks (`i18n-checks.ts`).
 * Internal: the public types are re-exported from `i18n.ts`.
 *
 * @module
 */

/** A CLDR plural category, as `Intl.PluralRules` names it. */
export type PluralCategory = Intl.LDMLPluralRule

/** The CLDR plural categories in their canonical order. */
export const PLURAL_CATEGORIES: readonly PluralCategory[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]

/** A message with one text per plural category the language uses. `other` is the fallback. */
export type PluralMessage = { readonly [Category in PluralCategory]?: string }

/** One catalog entry: plain text, or text per plural category. */
export type Message = string | PluralMessage

/** A flat catalog: message key to message. `Key` is usually `keyof typeof en`. */
export type Catalog<Key extends string = string> = { readonly [K in Key]: Message }

/**
 * One namespace of messages: its English source and, for any other language, its translation.
 * Leave `translation` out when the interface language is the source language.
 */
export interface CatalogPair {
  /** The English catalog, the fallback. */
  readonly source: Catalog
  /** The catalog of the interface language. A key it lacks falls back to `source`. */
  readonly translation?: { readonly [key: string]: Message | undefined }
}

/** Values for a message's `{name}` placeholders. A number is formatted for the number locale. */
export type MessageValues = { readonly [name: string]: string | number }

/** A span of a rich message: plain text, or text the caller wraps in the element named `tag`. */
export type MessagePart = string | { readonly tag: string; readonly text: string }

/** A `{name}` placeholder; group 1 is the name. */
export const PLACEHOLDER = /\{([A-Za-z_][\w]*)\}/g

/** A `<tag>…</tag>` span; group 1 is the tag name, group 2 the text. Spans do not nest. */
export const TAG = /<([A-Za-z][\w-]*)>([\s\S]*?)<\/\1>/g

/** True when `value` is a string or an object of strings keyed by plural category. */
export function isMessage(value: unknown): value is Message {
  if (typeof value === "string") return true
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([category, text]) =>
    (PLURAL_CATEGORIES as readonly string[]).includes(category) && typeof text === "string"
  )
}

/** The `{name}` placeholders of a text, in order of appearance. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1])
}

/** The tag names of a text's `<tag>…</tag>` spans, in order of appearance. */
export function tagsOf(text: string): string[] {
  return [...text.matchAll(TAG)].map((match) => match[1])
}
