import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { splitCsvLine } from "./csv.ts"

describe("splitCsvLine", () => {
  it("splits plain fields on the default delimiter", () => {
    expect(splitCsvLine("a,b,c")).toEqual(["a", "b", "c"])
  })

  it("keeps a delimiter that sits inside a quoted field", () => {
    expect(splitCsvLine(`"a,b",c`)).toEqual(["a,b", "c"])
  })

  it("un-doubles an escaped quote inside a quoted field", () => {
    expect(splitCsvLine(`"he said ""hi""",b`)).toEqual([`he said "hi"`, "b"])
  })

  it("trims every field, which is also how a line terminator is stripped", () => {
    // The source parser returned `out.map((s) => s.trim())`, and `\r\n` is the RFC 4180 terminator,
    // so a caller handing over a whole line must not get the terminator back in the last field.
    expect(splitCsvLine("a,b\r\n")).toEqual(["a", "b"])
    expect(splitCsvLine("a,b\n")).toEqual(["a", "b"])
    expect(splitCsvLine("a,b\r")).toEqual(["a", "b"])
    expect(splitCsvLine("  a  ,  b  ")).toEqual(["a", "b"])
  })

  it("trims inside the quotes of a quoted field", () => {
    expect(splitCsvLine(`" padded ",plain`)).toEqual(["padded", "plain"])
  })

  it("keeps whitespace inside a quoted field when it is not at the field edge", () => {
    expect(splitCsvLine(`"a  b",c`)).toEqual(["a  b", "c"])
  })

  it("yields a trailing empty field for a trailing delimiter", () => {
    expect(splitCsvLine("a,b,")).toEqual(["a", "b", ""])
    expect(splitCsvLine("")).toEqual([""])
    expect(splitCsvLine(",")).toEqual(["", ""])
  })

  const strayQuote = "rejects a quote that does not open a field instead of merging fields"
  it(strayQuote, () => {
    // `5" pipe,7` used to yield `["5 pipe,7"]`: the delimiter was swallowed AND the quote dropped.
    // The source threw (`warthunder-stats/libs/domain/stats/parser.ts:111-112`).
    expect(() => splitCsvLine(`5" pipe,7`)).toThrow("malformed CSV quoting")
    expect(() => splitCsvLine(`a,b"c`)).toThrow("malformed CSV quoting")
  })

  it("rejects text after a closing quote", () => {
    expect(() => splitCsvLine(`"a"b,c`)).toThrow("malformed CSV quoting")
    expect(() => splitCsvLine(`"a""b"c`)).toThrow("malformed CSV quoting")
  })

  it("rejects an unterminated quoted field", () => {
    expect(() => splitCsvLine(`a,"broken`)).toThrow("unterminated quoted cell")
    expect(() => splitCsvLine(`"broken`)).toThrow("unterminated quoted cell")
  })

  it("treats a single apostrophe as a literal character, not as a quote", () => {
    expect(splitCsvLine(`it's,a`)).toEqual(["it's", "a"])
  })

  it("supports an alternate delimiter", () => {
    expect(splitCsvLine("a\tb\tc", { delimiter: "\t" })).toEqual(["a", "b", "c"])
  })

  it("supports an alternate quote character", () => {
    expect(splitCsvLine("'a,b',c", { quote: "'" })).toEqual(["a,b", "c"])
    // The CSV double quote is then an ordinary character, and mid-field is legitimate.
    expect(splitCsvLine(`5" pipe,7`, { quote: "'" })).toEqual([`5" pipe`, "7"])
  })

  it("returns the raw quoted form when keepQuotes is set", () => {
    expect(splitCsvLine(`"a,b",c`, { keepQuotes: true })).toEqual([`"a,b"`, "c"])
    expect(splitCsvLine(`"he said ""hi""",b`, { keepQuotes: true })).toEqual([
      `"he said ""hi"""`,
      "b",
    ])
  })

  it("rejects a multi-character delimiter rather than guessing", () => {
    expect(() => splitCsvLine("a;;b", { delimiter: ";;" })).toThrow(
      "delimiter must be a single character",
    )
  })

  it("rejects a multi-character quote rather than guessing", () => {
    expect(() => splitCsvLine("a,b", { quote: "''" })).toThrow(
      "quote must be a single character",
    )
  })

  it("round-trips a quoted line through keepQuotes", () => {
    const fields = splitCsvLine(`"a,b",c`, { keepQuotes: true })
    expect(fields.join(",")).toBe(`"a,b",c`)
  })
})
