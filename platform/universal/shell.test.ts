import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { shellQuote } from "./shell.ts"

/**
 * Reads `text` back the way a POSIX shell reads one word, and fails on anything a shell would
 * expand, split or treat as an operator outside quotes. The test task grants no `--allow-run`, so
 * this stands in for `sh -c 'printf %s "$1"'`: single quotes copy every character up to the next
 * `'`, a backslash outside quotes takes the next character literally, and every other character
 * outside quotes must be one that means nothing to the shell.
 */
function readShellWord(text: string): string {
  let word = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === "'") quoted = false
      else word += char
    } else if (char === "'") {
      quoted = true
    } else if (char === "\\" && i + 1 < text.length && text[i + 1] !== "\n") {
      word += text[++i]
    } else if (/[A-Za-z0-9_@%+=:,./-]/.test(char)) {
      word += char
    } else {
      throw new Error(`unquoted ${JSON.stringify(char)} at ${i} in ${text}`)
    }
  }
  if (quoted) throw new Error(`unterminated quote in ${text}`)
  return word
}

describe("shellQuote", () => {
  it("quotes the empty string as an empty word", () => {
    expect(shellQuote("")).toBe("''")
    expect(readShellWord(shellQuote(""))).toBe("")
  })

  it("wraps a plain value in single quotes", () => {
    expect(shellQuote("apps/my app")).toBe("'apps/my app'")
  })

  it("closes, escapes and reopens the quotes around a single quote", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("'")).toBe(`''\\'''`)
    expect(readShellWord(shellQuote("''x''"))).toBe("''x''")
  })

  it("keeps newlines, tabs and carriage returns inside the one word", () => {
    const value = "line one\nline two\r\n\tend\n"

    expect(shellQuote(value)).toBe(`'${value}'`)
    expect(readShellWord(shellQuote(value))).toBe(value)
  })

  it("keeps non-ASCII text as it is", () => {
    for (const value of ["Ünïcödé", "путь/к файлу", "日本語", "😀 emoji", "​‮"]) {
      expect(readShellWord(shellQuote(value))).toBe(value)
    }
  })

  it("reads back as the same single word for every shell metacharacter", () => {
    const hostile = [
      "$(rm -rf ~)",
      "`id`",
      "${HOME}",
      "$HOME",
      "a; rm -rf /",
      "a && b || c",
      "a | b",
      "> /etc/passwd",
      "< in",
      "*",
      "?",
      "[a-z]",
      "~",
      "#comment",
      "!event",
      "a\\b",
      "\\",
      '"double"',
      "' ; echo pwned ; '",
      "'\\''",
      "\\'",
      "a b\tc",
      "-rf",
      "x=1",
      "(sub)",
      "{a,b}",
      "&",
    ]
    for (const value of hostile) {
      expect(readShellWord(shellQuote(value))).toBe(value)
    }
  })

  it("never leaves a character outside the quotes except the escaped single quote", () => {
    // Every printable ASCII character and the C0 controls but NUL, one at a time and all at once.
    const chars = Array.from({ length: 127 }, (_, code) => String.fromCharCode(code + 1))
    for (const value of [...chars, chars.join("")]) {
      const quoted = shellQuote(value)
      expect(quoted.startsWith("'") && quoted.endsWith("'")).toBe(true)
      expect(quoted.slice(1, -1).replaceAll(`'\\''`, "")).not.toContain("'")
      expect(readShellWord(quoted)).toBe(value)
    }
  })

  it("refuses a NUL character, which a shell or exec would cut the value at", () => {
    expect(() => shellQuote("a\0b")).toThrow(TypeError)
    expect(() => shellQuote("\0")).toThrow("NUL")
  })
})
