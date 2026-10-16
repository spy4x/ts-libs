/**
 * Quoting for a POSIX shell (`sh`, `bash`, `dash`, `zsh` in `sh` mode), for the one place a value
 * must pass through a shell: a remote command for `ssh`, a line in a generated script.
 *
 * Prefer passing arguments as an array to a process API (`Deno.Command`, `execFile`), which needs
 * no quoting at all. Quoting keeps a value one word with nothing expanded; it does not stop a
 * program from reading a word that starts with `-` as an option, so put `--` before such values.
 *
 * @module
 */

/**
 * Quotes `value` as one word for a POSIX shell: the shell reads it back as exactly `value`, with no
 * expansion, globbing or word splitting. The value goes inside single quotes, and each single quote
 * in it is closed, escaped and reopened (`'\''`). The empty string becomes `''`, an empty word.
 *
 * @throws {TypeError} When `value` holds a NUL character, which no shell word or process argument
 *   can carry: a shell or `exec` would cut the value there.
 *
 * @example
 * ```ts
 * const remote = `cd ${shellQuote(path)} && ls`
 * // path `it's here` → cd 'it'\''s here' && ls
 * ```
 */
export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new TypeError("A shell word cannot hold a NUL character")
  return `'${value.replaceAll("'", `'\\''`)}'`
}
