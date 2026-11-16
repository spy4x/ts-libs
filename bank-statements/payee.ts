/** Words that only label a number, dropped when the number next to them is removed. */
const LABELS = new Set(["card", "id", "no", "nr", "ref"])

/** Punctuation trimmed off a word before it is compared with {@link LABELS}. */
const PUNCTUATION = "#:.,;/-"

/** A run with at least this many digits and mask characters is a card or reference number. */
const MIN_NUMBER_LENGTH = 6

/**
 * The most UTF-16 code units of a payee that are read. Real payees are far shorter, and NFKC takes
 * quadratic time on a long run of combining marks, so the rest of a longer one is ignored.
 */
const PAYEE_KEY_MAX_INPUT = 1_000

/** Whether `char` can be part of a card or reference number: a digit, a mask or a dash. */
function isNumberChar(char: string): boolean {
  return (char >= "0" && char <= "9") || char === "*" || char === "x" || char === "-"
}

/** The counts that decide whether a run of {@link isNumberChar} characters is a number. */
interface Weight {
  /** Digits, `*` and `x`. */
  length: number
  /** Whether it has a digit or `*`, so a word like `xxx` alone never counts. */
  marked: boolean
}

function weigh(text: string, weight: Weight): void {
  for (const char of text) {
    if (char === "-") continue
    weight.length++
    if (char !== "x") weight.marked = true
  }
}

function isNumber(weight: Weight): boolean {
  return weight.marked && weight.length >= MIN_NUMBER_LENGTH
}

/** `word` without leading and trailing {@link PUNCTUATION}. A loop, so it never backtracks. */
function bare(word: string): string {
  let start = 0
  let end = word.length
  while (start < end && PUNCTUATION.includes(word[start])) start++
  while (end > start && PUNCTUATION.includes(word[end - 1])) end--
  return word.slice(start, end)
}

function isLabel(word: string): boolean {
  const core = bare(word)
  return core === "" || LABELS.has(core)
}

/**
 * Builds the key word by word. A removed number also removes the labels right before it, so
 * `card 4111****1111` and `ref: 998123` leave nothing behind, while `Card Factory` keeps its name.
 */
class KeyBuilder {
  readonly words: string[] = []
  /** Whether each word of {@link words} is a label, judged once when it is added. */
  #labels: boolean[] = []
  /** Whole words made only of number characters, waiting to be judged together. */
  #pending: string[] = []
  #weight: Weight = { length: 0, marked: false }

  add(word: string): void {
    if (this.#isNumberWord(word)) {
      this.#pending.push(word)
      weigh(word, this.#weight)
      return
    }
    this.flush()
    this.#addMixed(word)
  }

  /** Judges the pending number words: one card number split by spaces, or short numbers to keep. */
  flush(): void {
    if (this.#pending.length === 0) return
    if (isNumber(this.#weight)) this.#cut()
    else for (const word of this.#pending) this.#push(word)
    this.#pending = []
    this.#weight = { length: 0, marked: false }
  }

  #isNumberWord(word: string): boolean {
    for (const char of word) if (!isNumberChar(char)) return false
    return true
  }

  /** Removes the numbers inside a word that also has other characters, like `ref:998123`. */
  #addMixed(word: string): void {
    let text = ""
    let cut = false
    let index = 0
    while (index < word.length) {
      if (!isNumberChar(word[index])) {
        text += word[index++]
        continue
      }
      let end = index
      while (end < word.length && isNumberChar(word[end])) end++
      // An `x` or `-` at the edge of a run belongs to the word next to it: `max123456`, `7-eleven`.
      let start = index
      let stop = end
      while (start < stop && (word[start] === "x" || word[start] === "-")) start++
      while (stop > start && (word[stop - 1] === "x" || word[stop - 1] === "-")) stop--
      const run = word.slice(start, stop)
      const weight: Weight = { length: 0, marked: false }
      weigh(run, weight)
      if (isNumber(weight)) {
        text += word.slice(index, start)
        this.#pushPiece(text, cut)
        this.#cut()
        cut = true
        text = word.slice(stop, end)
      } else {
        text += word.slice(index, end)
      }
      index = end
    }
    this.#pushPiece(text, cut)
  }

  /** Adds what is left of a word; after a cut, a piece of punctuation alone is dropped. */
  #pushPiece(text: string, cut: boolean): void {
    if (text === "" || (cut && bare(text) === "")) return
    this.#push(text)
  }

  #push(word: string): void {
    this.words.push(word)
    this.#labels.push(isLabel(word))
  }

  /** Drops the labels right before a removed number; each word is judged once, so this is linear. */
  #cut(): void {
    while (this.#labels.length > 0 && this.#labels[this.#labels.length - 1]) {
      this.words.pop()
      this.#labels.pop()
    }
  }
}

/**
 * Reduce the payee text of a statement row to a stable key, so rows from one payee on different
 * days get the same key. An app can then remember a choice per payee, such as the category last
 * used.
 *
 * The text is normalised with NFKC (full-width letters and spaces become plain ones) and
 * lower-cased with `toLowerCase`, which does not depend on the locale. Card numbers, masked or not
 * (`4111********1111`, `4111 xxxx xxxx 1111`, `****1234`), and runs of 6 or more digits
 * (references, transaction ids) are removed, with the labels right before them (`card`, `ref`,
 * `no`, `nr`, `id`, `#`). Shorter numbers stay, since they are part of names (`7-Eleven`,
 * `Shop 24`). Whitespace collapses to one space. A payee with nothing left gives `""`, which an app
 * should treat as "no key".
 *
 * The text comes from a stranger's file, so only its first 1,000 UTF-16 code units are read, and
 * the work is one linear pass with no regular expression that could backtrack.
 *
 * @example
 * ```ts
 * import { payeeKey } from "@spy4x/bank-statements"
 *
 * payeeKey("CARD 4111********1111 COFFEE BAR  REF 99812345") // "coffee bar"
 * payeeKey("card 4111********2222 Coffee Bar ref 11223344") // "coffee bar"
 * payeeKey("7-Eleven 4111 xxxx xxxx 1111") // "7-eleven"
 * payeeKey("99812345") // ""
 * ```
 */
export function payeeKey(payee: string): string {
  const builder = new KeyBuilder()
  let text = payee.slice(0, PAYEE_KEY_MAX_INPUT)
  // A cut through a surrogate pair would leave half a character.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
  for (const word of text.normalize("NFKC").toLowerCase().split(/\s+/)) {
    if (word !== "") builder.add(word)
  }
  builder.flush()
  return builder.words.join(" ")
}
