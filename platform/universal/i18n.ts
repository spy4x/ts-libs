/**
 * Translations from flat JSON catalogs, with `Intl` doing the language work: plural forms, number
 * format, text direction and language choice. No i18n library and no build step.
 *
 * A catalog is one JSON file per language, English as the source:
 *
 * ```json
 * {
 *   "notes.empty": "No notes yet",
 *   "notes.count": { "one": "{count} note", "other": "{count} notes" },
 *   "signup.terms": "I agree to the <terms>Terms</terms>."
 * }
 * ```
 *
 * `{name}` inserts a value. A plural message is an object keyed by CLDR plural category. `<tag>…</tag>`
 * marks a span the caller renders, such as a link; tags do not nest and never become HTML.
 *
 * The checks that keep translations complete and current (`checkCatalogs`, `findUnusedKeys`,
 * `stampLocks`) are exported from here too; they live in `i18n-checks.ts`.
 *
 * @module
 */

export {
  type CatalogProblem,
  type CatalogProblemKind,
  checkCatalogs,
  type CheckCatalogsOptions,
  findUnusedKeys,
  type FindUnusedKeysOptions,
  stampLocks,
} from "./i18n-checks.ts"
export type {
  Catalog,
  CatalogPair,
  Message,
  MessagePart,
  MessageValues,
  PluralCategory,
  PluralMessage,
} from "./i18n-message.ts"
import {
  type Catalog,
  type CatalogPair,
  isMessage,
  type Message,
  type MessagePart,
  type MessageValues,
  PLACEHOLDER,
  TAG,
} from "./i18n-message.ts"

/** Text direction of a language. */
export type TextDirection = "ltr" | "rtl"

/** Options of {@link createTranslator}. */
export interface TranslatorOptions {
  /** The interface language, a BCP 47 tag such as `pt-BR`. It picks the plural rule. */
  readonly language: string
  /** Catalogs applied in order: a key in a later pair wins (the library's, then the app's). */
  readonly catalogs: readonly CatalogPair[]
  /** The region format for numbers in messages; defaults to `language`. */
  readonly numberLocale?: string
  /** Called when a key has no text in `language`. Tests make it throw. */
  readonly onMissing?: (key: string, language: string) => void
}

/** What {@link createTranslator} returns. */
export interface Translator<Key extends string> {
  /** The interface language the translator was made for. */
  readonly language: string
  /** The text direction of `language`, for `<html dir>`. */
  readonly dir: TextDirection
  /** The message as plain text, values inserted and tag markers removed. */
  t(key: Key, values?: MessageValues): string
  /** The message as text and tag spans, values inserted. Nothing in it is HTML. */
  parts(key: Key, values?: MessageValues): MessagePart[]
}

const pluralRulesCache = new Map<string, Intl.PluralRules>()
const numberFormatCache = new Map<string, Intl.NumberFormat>()

function pluralRules(language: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(language)
  if (!rules) {
    rules = new Intl.PluralRules(language)
    pluralRulesCache.set(language, rules)
  }
  return rules
}

function numberFormat(locale: string): Intl.NumberFormat {
  let format = numberFormatCache.get(locale)
  if (!format) {
    format = new Intl.NumberFormat(locale)
    numberFormatCache.set(locale, format)
  }
  return format
}

/**
 * Make a translator for one interface language.
 *
 * A key with no text in `language` (absent, or an empty string) falls back to the English source, then to the key itself, and
 * calls `onMissing` in both cases. A plural message picks its form with `Intl.PluralRules` and the
 * number in `values.count`; a form the catalog lacks falls back to `other`, because older locale
 * data can pick a category the catalog does not have.
 *
 * `Key` types the keys `t` and `parts` accept: `keyof typeof en`, or the union of every
 * namespace's English keys when there are several (`keyof typeof uiEn | keyof typeof appEn`).
 *
 * @example
 * ```ts
 * // In an app, `en` and `de` are JSON imports of `i18n/app/en.json` and `i18n/app/de.json`.
 * const en = { "notes.count": { one: "{count} note", other: "{count} notes" } }
 * const de = { "notes.count": { one: "{count} Notiz", other: "{count} Notizen" } }
 *
 * const { t } = createTranslator<keyof typeof en>({
 *   language: "de",
 *   catalogs: [{ source: en, translation: de }],
 * })
 * t("notes.count", { count: 3 }) // "3 Notizen"
 * ```
 */
export function createTranslator<Key extends string = string>(
  options: TranslatorOptions,
): Translator<Key> {
  const { language, catalogs, onMissing } = options
  const numberLocale = options.numberLocale ?? language

  function lookup(key: Key): Message {
    for (let index = catalogs.length - 1; index >= 0; index--) {
      const { source, translation } = catalogs[index]
      if (!Object.hasOwn(source, key)) continue
      if (!translation) return source[key]
      const translated = Object.hasOwn(translation, key) ? translation[key] : undefined
      if (isMessage(translated) && translated !== "") return translated
      onMissing?.(key, language)
      return source[key]
    }
    onMissing?.(key, language)
    return key
  }

  function template(key: Key, values: MessageValues | undefined): string {
    const message = lookup(key)
    if (typeof message === "string") return message
    const count = values?.count
    const category = typeof count === "number" ? pluralRules(language).select(count) : "other"
    return message[category] ?? message.other ?? key
  }

  function insert(text: string, values: MessageValues | undefined): string {
    if (!values) return text
    return text.replace(PLACEHOLDER, (whole, name: string) => {
      if (!Object.hasOwn(values, name)) return whole
      const value = values[name]
      return typeof value === "number" ? numberFormat(numberLocale).format(value) : value
    })
  }

  return {
    language,
    dir: textDirection(language),
    t(key, values) {
      return insert(template(key, values).replace(TAG, "$2"), values)
    },
    parts(key, values) {
      const parts: MessagePart[] = []
      const text = template(key, values)
      let last = 0
      for (const match of text.matchAll(TAG)) {
        if (match.index > last) parts.push(insert(text.slice(last, match.index), values))
        parts.push({ tag: match[1], text: insert(match[2], values) })
        last = match.index + match[0].length
      }
      if (last < text.length) parts.push(insert(text.slice(last), values))
      return parts
    },
  }
}

const RTL_SCRIPTS = new Set(["Arab", "Hebr", "Thaa", "Syrc", "Nkoo", "Adlm"])

/**
 * `rtl` for a language written right to left (Arabic, Hebrew, Thaana, Syriac, N'Ko or Adlam
 * script), `ltr` for any other, including a tag `Intl` cannot parse.
 */
export function textDirection(language: string): TextDirection {
  try {
    const script = new Intl.Locale(language).maximize().script
    return script && RTL_SCRIPTS.has(script) ? "rtl" : "ltr"
  } catch {
    return "ltr"
  }
}

/** The most characters of an `Accept-Language` header that {@link parseAcceptLanguage} reads. */
export const ACCEPT_LANGUAGE_MAX_LENGTH = 256

/** The most requested languages {@link negotiateLanguage} looks at. */
const MAX_REQUESTED = 32

const LANGUAGE_TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/

/**
 * The language tags of an `Accept-Language` header, most preferred first. Only the first
 * {@link ACCEPT_LANGUAGE_MAX_LENGTH} characters are read, cut back to the last whole entry; `*`,
 * `q=0` and malformed entries are dropped.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return []
  let text = header
  if (text.length > ACCEPT_LANGUAGE_MAX_LENGTH) {
    text = text.slice(0, ACCEPT_LANGUAGE_MAX_LENGTH)
    const lastComma = text.lastIndexOf(",")
    text = lastComma === -1 ? "" : text.slice(0, lastComma)
  }
  const entries: { tag: string; quality: number; order: number }[] = []
  for (const [order, entry] of text.split(",").entries()) {
    const [rawTag, ...params] = entry.trim().split(";")
    const tag = rawTag.trim()
    if (!LANGUAGE_TAG.test(tag)) continue
    let quality = 1
    for (const param of params) {
      const [name, value] = param.trim().split("=")
      if (name?.trim() === "q") quality = Number(value)
    }
    if (!(quality > 0 && quality <= 1)) continue
    entries.push({ tag, quality, order })
  }
  return entries
    .sort((a, b) => b.quality - a.quality || a.order - b.order)
    .map((entry) => entry.tag)
}

/**
 * Pick the supported language that best matches the requested ones, taken in order: for each, an
 * exact tag wins, then a supported tag of the same language (`pt-PT` → `pt-BR`, `en-US` → `en`).
 * When nothing matches, `fallback`.
 *
 * The result is always a member of `supported` (or `fallback`), never the caller's input, so it is
 * safe as a file or import key. Tags are compared case-insensitively.
 */
export function negotiateLanguage<Supported extends string>(
  requested: string | readonly string[] | null | undefined,
  supported: readonly Supported[],
  fallback: Supported,
): Supported {
  const list = typeof requested === "string" ? [requested] : requested ?? []
  for (const tag of list.slice(0, MAX_REQUESTED)) {
    if (typeof tag !== "string" || tag.length > 64) continue
    const wanted = tag.toLowerCase()
    const exact = supported.find((candidate) => candidate.toLowerCase() === wanted)
    if (exact) return exact
    const base = wanted.split("-")[0]
    const sameLanguage = supported.find((candidate) => candidate.toLowerCase() === base) ??
      supported.find((candidate) => candidate.toLowerCase().split("-")[0] === base)
    if (sameLanguage) return sameLanguage
  }
  return fallback
}

const PSEUDO_LETTERS: Record<string, string> = {
  a: "á",
  c: "ç",
  e: "é",
  i: "í",
  n: "ñ",
  o: "ó",
  u: "ú",
  y: "ý",
  A: "Á",
  C: "Ç",
  E: "É",
  I: "Í",
  N: "Ñ",
  O: "Ó",
  U: "Ú",
  Y: "Ý",
}

/** Placeholders and tag markers, which pseudo-localization keeps as they are. */
const MARKUP = /(\{[A-Za-z_][\w]*\}|<\/?[A-Za-z][\w-]*>)/

function pseudoText(text: string): string {
  let letters = 0
  const accented = text.split(MARKUP).map((piece, index) => {
    if (index % 2 === 1) return piece
    letters += piece.length
    return piece.replace(/[A-Za-z]/g, (letter) => PSEUDO_LETTERS[letter] ?? letter)
  }).join("")
  return `⟦${accented}${"~".repeat(Math.ceil(letters * 0.4))}⟧`
}

/**
 * The `en-XA` pseudo-language of a catalog: letters accented, every message wrapped in `⟦ ⟧` and
 * about 40 % longer, placeholders and tags kept. Rendering a screen with it shows text that skipped
 * the catalog (no brackets) and layouts that break when words get longer. Generate it; never store
 * it.
 */
export function pseudoLocalize<Key extends string>(catalog: Catalog<Key>): Catalog<Key> {
  const result: Record<string, Message> = {}
  for (const [key, message] of Object.entries<Message>(catalog)) {
    result[key] = typeof message === "string" ? pseudoText(message) : Object.fromEntries(
      Object.entries(message).map(([category, text]) => [category, pseudoText(text ?? "")]),
    )
  }
  return result as Catalog<Key>
}
