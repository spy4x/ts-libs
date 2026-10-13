/**
 * Escaping for text that goes into a log line. Not an export of the package: the request log and
 * the base middleware share it.
 */

/**
 * What can end or redraw a log line: the C0 block, `DEL`, the C1 block (which holds `NEL`), and
 * the Unicode line and paragraph separators.
 */
// deno-lint-ignore no-control-regex
const LINE_BREAKING = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g

const NAMED: Readonly<Record<string, string>> = {
  "\n": String.raw`\n`,
  "\r": String.raw`\r`,
  "\t": String.raw`\t`,
}

/**
 * Make `text` safe to place in one log line: a line break or any other control character is
 * written as visible text (`\n`, `\r`, `\t`, `\x1b`, `\u2028`), so a caller-chosen value such as a
 * decoded request path can neither start a second line nor send a terminal an escape sequence.
 * Every other character, a backslash included, is kept as it is.
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(LINE_BREAKING, (character) => {
    const named = NAMED[character]
    if (named !== undefined) return named
    const code = character.charCodeAt(0)
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, `0`)}`
      : `\\u${code.toString(16).padStart(4, `0`)}`
  })
}
