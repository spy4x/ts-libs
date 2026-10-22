/**
 * Catalog checks for `@spy4x/platform/universal/i18n`: pure functions an app calls from one test
 * file, so CI needs no step of its own. The problem list is the translator's work list: change the
 * English, run the test, translate what it lists, stamp the locks, run the test again.
 *
 * A lock (`<language>.lock`) holds one `key<TAB>hash` line per translated key, the hash of the
 * English the translation was made from. When the English changes, the hash no longer matches and
 * the check names every language that needs the key redone. One line per key keeps conflicts
 * between parallel changes to the lines they touched, and stamping again resolves them.
 *
 * @module
 */

import {
  type Catalog,
  isMessage,
  type Message,
  placeholdersOf,
  PLURAL_CATEGORIES,
  tagsOf,
} from "./i18n-message.ts"

/** What is wrong with one key in one language. */
export type CatalogProblemKind =
  | "missing"
  | "extra"
  | "empty"
  | "stale"
  | "placeholder"
  | "tag"
  | "plural"

/** One problem {@link checkCatalogs} found. */
export interface CatalogProblem {
  /** What is wrong. */
  readonly kind: CatalogProblemKind
  /** The language whose catalog has the problem. */
  readonly language: string
  /** The message key. */
  readonly key: string
  /** A sentence for a person or an agent, ending with the command that fixes it. */
  readonly message: string
}

/** Options of {@link checkCatalogs}. */
export interface CheckCatalogsOptions {
  /** The English catalog. */
  readonly source: Catalog
  /** The translated catalogs, by language tag. */
  readonly languages: { readonly [language: string]: Catalog }
  /** The lock text of each language, as {@link stampLocks} wrote it. A missing lock is empty. */
  readonly locks: { readonly [language: string]: string }
}

/** Hex characters of the SHA-256 kept per lock line: 64 bits, plenty to notice a change. */
const LOCK_HASH_LENGTH = 16

/**
 * Check translated catalogs against the English source and its locks. Reports, per language and
 * key, a missing, extra or empty message; a stale one, whose English changed after its lock line
 * was stamped; placeholders or tags that differ from the English; and plural categories that
 * differ from those `Intl.PluralRules` lists for the language. The source itself is checked for
 * empty messages and for its own plural categories.
 *
 * The source is English (`en`), and every problem ends with the command that fixes it, which is
 * `deno task i18n:stamp`, the task that writes {@link stampLocks}' output to the lock files.
 *
 * Problems come in a stable order (language, then key) so a test's failure output diffs cleanly.
 */
export async function checkCatalogs(options: CheckCatalogsOptions): Promise<CatalogProblem[]> {
  const { source, languages, locks } = options
  const sourceLanguage = "en"
  const stamp = "`deno task i18n:stamp`"
  const problems: CatalogProblem[] = []
  const hashes = await sourceHashes(source)

  for (const key of Object.keys(source).sort()) {
    const message = source[key]
    const fixSource = `Fix it in the ${sourceLanguage} catalog, then run ${stamp}.`
    if (isEmpty(message)) {
      problems.push({
        kind: "empty",
        language: sourceLanguage,
        key,
        message: `${sourceLanguage} "${key}" has no text. ${fixSource}`,
      })
    } else if (typeof message !== "string") {
      const wrong = pluralMismatch(message, sourceLanguage)
      if (wrong) {
        problems.push({
          kind: "plural",
          language: sourceLanguage,
          key,
          message: `${sourceLanguage} "${key}" ${wrong}. ${fixSource}`,
        })
      }
    }
  }

  for (const language of Object.keys(languages).sort()) {
    const catalog = languages[language]
    const lock = parseLock(locks[language] ?? "")
    const translate = `Translate it in the ${language} catalog, then run ${stamp}.`
    const add = (kind: CatalogProblemKind, key: string, text: string, fix = translate) =>
      problems.push({ kind, language, key, message: `${language} "${key}" ${text}. ${fix}` })

    const keys = [...new Set([...Object.keys(source), ...Object.keys(catalog)])].sort()
    for (const key of keys) {
      if (!Object.hasOwn(catalog, key)) {
        add("missing", key, "is missing")
        continue
      }
      if (!Object.hasOwn(source, key)) {
        add(
          "extra",
          key,
          "is not in the English catalog",
          `Delete it from the ${language} catalog, then run ${stamp}.`,
        )
        continue
      }
      const english = source[key]
      const translated = catalog[key]
      if (isEmpty(translated)) {
        add("empty", key, "has no text")
        continue
      }
      if (lock.get(key) !== hashes.get(key)) {
        add(
          "stale",
          key,
          lock.has(key) ? "was translated from older English" : "has no lock line",
          `Check the translation against the English, then run ${stamp}.`,
        )
      }
      if (typeof english === "string" !== (typeof translated === "string")) {
        add(
          "plural",
          key,
          typeof english === "string"
            ? "is a plural object, but the English is one text"
            : "is one text, but the English has plural forms",
        )
        continue
      }
      if (typeof translated !== "string") {
        const wrong = pluralMismatch(translated, language)
        if (wrong) add("plural", key, wrong)
      }
      const want = placeholdersOf(texts(english))
      const have = placeholdersOf(texts(translated))
      if (!sameSet(want, have)) {
        add("placeholder", key, `has placeholders ${list(have)}, the English has ${list(want)}`)
      }
      const wantTags = tagsOf(texts(english))
      const haveTags = tagsOf(texts(translated))
      if (!sameSet(wantTags, haveTags)) {
        add("tag", key, `has tags ${list(haveTags)}, the English has ${list(wantTags)}`)
      }
    }
  }
  return problems
}

/** Options of {@link findUnusedKeys}. */
export interface FindUnusedKeysOptions {
  /** Prefixes of key families built at run time (`errors.` for `errors.<code>`): never unused. */
  readonly allowedDynamicPrefixes?: readonly string[]
}

/**
 * The keys of `catalog` that appear in none of `sourceTexts` as a quoted literal (`"key"`,
 * `'key'` or a backtick string). Call sites name keys literally; a family built at run time is
 * declared in `allowedDynamicPrefixes`.
 */
export function findUnusedKeys(
  catalog: Catalog,
  sourceTexts: readonly string[],
  options: FindUnusedKeysOptions = {},
): string[] {
  const prefixes = options.allowedDynamicPrefixes ?? []
  return Object.keys(catalog).sort().filter((key) =>
    !prefixes.some((prefix) => key.startsWith(prefix)) &&
    !sourceTexts.some((text) =>
      text.includes(`"${key}"`) || text.includes(`'${key}'`) || text.includes(`\`${key}\``)
    )
  )
}

/**
 * The new lock text of every language: one `key<TAB>hash` line per key the language translates,
 * sorted by key, where the hash is a SHA-256 prefix of the English message. Write each value to
 * `<language>.lock` once the translations match the English.
 */
export async function stampLocks(
  source: Catalog,
  languages: { readonly [language: string]: Catalog },
): Promise<Record<string, string>> {
  const hashes = await sourceHashes(source)
  const locks: Record<string, string> = {}
  for (const language of Object.keys(languages).sort()) {
    const lines = Object.keys(languages[language])
      .filter((key) => hashes.has(key))
      .sort()
      .map((key) => `${key}\t${hashes.get(key)}\n`)
    locks[language] = lines.join("")
  }
  return locks
}

async function sourceHashes(source: Catalog): Promise<Map<string, string>> {
  const entries = await Promise.all(
    Object.entries<Message>(source).map(async ([key, message]) =>
      [key, await hashMessage(message)] as const
    ),
  )
  return new Map(entries)
}

/** A SHA-256 prefix of the message; plural forms in CLDR order, so key order does not matter. */
async function hashMessage(message: Message): Promise<string> {
  const canonical = typeof message === "string"
    ? message
    : JSON.stringify(PLURAL_CATEGORIES.map((category) => message[category] ?? null))
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, LOCK_HASH_LENGTH)
}

function parseLock(text: string): Map<string, string> {
  const lock = new Map<string, string>()
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab > 0) lock.set(line.slice(0, tab), line.slice(tab + 1).trim())
  }
  return lock
}

function isEmpty(message: unknown): boolean {
  if (!isMessage(message)) return true
  if (typeof message === "string") return message.trim() === ""
  const forms = Object.values(message)
  return forms.length === 0 || forms.some((text) => text.trim() === "")
}

/** Why the plural categories of `message` are wrong for `language`, or `undefined`. */
function pluralMismatch(message: Exclude<Message, string>, language: string): string | undefined {
  // CLDR order, so the message reads the same whatever order Intl and the catalog use.
  const needed: readonly string[] =
    new Intl.PluralRules(language).resolvedOptions().pluralCategories
  const want = PLURAL_CATEGORIES.filter((category) => needed.includes(category))
  const have = PLURAL_CATEGORIES.filter((category) => Object.hasOwn(message, category))
  if (sameSet(want, have)) return undefined
  return `has plural forms ${list(have)}, ${language} needs ${list(want)}`
}

/** Every text of a message joined, so placeholders and tags of all plural forms are compared. */
function texts(message: Message): string {
  return typeof message === "string" ? message : Object.values(message).join("\n")
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((item) => right.has(item))
}

function list(items: readonly string[]): string {
  const unique = [...new Set(items)]
  return unique.length === 0 ? "none" : unique.join(", ")
}
