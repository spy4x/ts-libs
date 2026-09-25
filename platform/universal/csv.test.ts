import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  CSV_BYTE_ORDER_MARK,
  type CsvColumn,
  csvField,
  csvHeaderRow,
  toCsvBytes,
  toCsvText,
} from "./csv.ts"

describe("csvField", () => {
  it("leaves a plain cell untouched", () => {
    expect(csvField("Ada")).toBe("Ada")
  })

  it("wraps a cell containing a comma in quotes", () => {
    expect(csvField("Doe, John")).toBe(`"Doe, John"`)
  })

  it("wraps a cell containing a double quote in quotes, doubling the quote", () => {
    expect(csvField(`She said "hi"`)).toBe(`"She said ""hi"""`)
  })

  it("wraps a cell containing a line break in quotes", () => {
    expect(csvField("line one\nline two")).toBe('"line one\nline two"')
    expect(csvField("line one\r\nline two")).toBe('"line one\r\nline two"')
  })

  it("prefixes a cell starting with = with a single quote", () => {
    expect(csvField("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)")
  })

  it("prefixes a cell starting with + with a single quote", () => {
    expect(csvField("+1 (555) 000-0000")).toBe("'+1 (555) 000-0000")
  })

  it("prefixes a cell starting with @ with a single quote", () => {
    expect(csvField("@mention")).toBe("'@mention")
  })

  it("prefixes a cell starting with a tab with a single quote", () => {
    expect(csvField("\tcmd")).toBe("'\tcmd")
  })

  it("prefixes and quotes a cell starting with a carriage return", () => {
    // The guard adds the leading `'`; the `\r` still forces RFC 4180 quoting on top of it.
    expect(csvField("\rcmd")).toBe('"\'\rcmd"')
  })

  it("guards a formula-shaped payload that starts like a negative number", () => {
    // No comma, double quote or line break in this payload, so only the guard applies — RFC 4180
    // quoting is a separate rule and does not trigger just because the cell is dangerous.
    expect(csvField("-2+3+cmd|' /C calc'!A1")).toBe("'-2+3+cmd|' /C calc'!A1")
  })

  it("guards a plain negative number given as a string, trading numeric formatting for safety", () => {
    // Decision recorded in csv.ts's guardFormulaInjection: there is no way to tell "-5" (a
    // caller-formatted amount) from the start of a formula payload by content alone, so a string
    // is always guarded. A caller who wants -5 to stay a live number hands back the number itself
    // (or a bigint) instead — see the "skips the guard entirely" tests below.
    expect(csvField("-5")).toBe("'-5")
  })

  it("guards = right after a comma, the separator this writer itself uses", () => {
    expect(csvField("x,=1+1")).toBe(`"x,'=1+1"`)
  })

  it("guards = right after a semicolon, a separator a different locale's reader uses", () => {
    expect(csvField("x;=1+1")).toBe("x;'=1+1")
  })

  it("guards = right after a tab, a separator a tab-delimited reader uses", () => {
    expect(csvField("x\t=1+1")).toBe("x\t'=1+1")
  })

  it("guards = right after a line feed inside the cell", () => {
    expect(csvField("x\n=1+1")).toBe('"x\n\'=1+1"')
  })

  it("guards = right after a carriage return inside the cell", () => {
    expect(csvField("x\r=1+1")).toBe('"x\r\'=1+1"')
  })

  it("guards a DDE payload that only becomes a formula after a semicolon split", () => {
    // The reviewed exploit: opened with ";" as the list separator, "x;=cmd|' /C calc'!A0" reads as
    // two cells, the second a live DDE formula, unless the character right after the ";" is
    // guarded too — not only the first character of the whole string.
    expect(csvField("x;=cmd|' /C calc'!A0")).toBe("x;'=cmd|' /C calc'!A0")
  })

  it("pays the documented cost: a plain negative number after a separator still gets the mark", () => {
    expect(csvField("a;-5")).toBe("a;'-5")
  })

  it("does not guard a comma, semicolon, tab, CR or LF itself, only what follows it", () => {
    expect(csvField("a;b,c\td\ne")).toBe('"a;b,c\td\ne"')
  })

  it("writes a number unguarded, even one that reads like a negative amount", () => {
    expect(csvField(-5)).toBe("-5")
  })

  it("writes a bigint unguarded", () => {
    expect(csvField(-5n)).toBe("-5")
  })

  it("writes NaN, -Infinity and scientific notation unguarded too", () => {
    // String() of a number can also produce Infinity, -Infinity, NaN or an e/E exponent marker.
    // All three are still written as-is. In LibreOffice 26.2, NaN and -Infinity open as text,
    // -1e+21 opens as a number, and none of them opens as a formula.
    expect(csvField(NaN)).toBe("NaN")
    expect(csvField(-Infinity)).toBe("-Infinity")
    expect(csvField(-1e21)).toBe("-1e+21")
  })
})

describe("toCsvText", () => {
  const columns: CsvColumn<{ id: number; name: string }>[] = [
    { key: "id", header: "ID" },
    { key: "name", header: "Name" },
  ]

  it("joins the header and every row with a trailing CRLF", () => {
    expect(toCsvText(columns, [{ id: 1, name: "Ada" }, { id: 2, name: "Bo" }])).toBe(
      "ID,Name\r\n1,Ada\r\n2,Bo\r\n",
    )
  })

  it("renders the header alone for zero rows", () => {
    expect(toCsvText(columns, [])).toBe("ID,Name\r\n")
  })

  it("renders null and undefined fields as an empty cell", () => {
    const nullable: CsvColumn<{ note: string | null | undefined }>[] = [
      { key: "note", header: "Note" },
    ]
    expect(toCsvText(nullable, [{ note: null }, { note: undefined }])).toBe(
      "Note\r\n\r\n\r\n",
    )
  })

  it("applies a column's format function to the raw value, not the stringified one", () => {
    const priced: CsvColumn<{ cents: number }>[] = [
      {
        key: "cents",
        header: "Amount",
        format: (value) => `$${((value as number) / 100).toFixed(2)}`,
      },
    ]
    expect(toCsvText(priced, [{ cents: 1050 }])).toBe("Amount\r\n$10.50\r\n")
  })

  it("escapes a formula-like value even when it goes through format", () => {
    const risky: CsvColumn<{ note: string }>[] = [
      { key: "note", header: "Note", format: (value) => String(value) },
    ]
    expect(toCsvText(risky, [{ note: "=cmd|' /C calc'!A1" }])).toBe(
      "Note\r\n'=cmd|' /C calc'!A1\r\n",
    )
  })

  it("both guards and quotes a formula-like value that also contains a comma", () => {
    const risky: CsvColumn<{ note: string }>[] = [{ key: "note", header: "Note" }]
    expect(toCsvText(risky, [{ note: "=cmd, calc" }])).toBe(
      `Note\r\n"'=cmd, calc"\r\n`,
    )
  })

  it("writes a raw numeric field unguarded, even a negative one", () => {
    const amounts: CsvColumn<{ balance: number }>[] = [{ key: "balance", header: "Balance" }]
    expect(toCsvText(amounts, [{ balance: -5 }])).toBe("Balance\r\n-5\r\n")
  })

  it("writes a raw bigint field unguarded", () => {
    const amounts: CsvColumn<{ balance: bigint }>[] = [{ key: "balance", header: "Balance" }]
    expect(toCsvText(amounts, [{ balance: -5n }])).toBe("Balance\r\n-5\r\n")
  })

  it("writes a number returned by format unguarded, keeping it a live number", () => {
    const amounts: CsvColumn<{ cents: number }>[] = [
      { key: "cents", header: "Amount", format: (value) => (value as number) / 100 },
    ]
    expect(toCsvText(amounts, [{ cents: -500 }])).toBe("Amount\r\n-5\r\n")
  })

  it("guards a string returned by format, even one that reads like the same number", () => {
    const amounts: CsvColumn<{ cents: number }>[] = [
      { key: "cents", header: "Amount", format: (value) => `${(value as number) / 100}` },
    ]
    expect(toCsvText(amounts, [{ cents: -500 }])).toBe("Amount\r\n'-5\r\n")
  })

  it("guards a formula-like header the same way a data cell is guarded", () => {
    const columns: CsvColumn<{ note: string }>[] = [{ key: "note", header: "=1+1" }]
    expect(csvHeaderRow(columns)).toBe("'=1+1")
    expect(toCsvText(columns, [])).toBe("'=1+1\r\n")
  })
})

describe("toCsvBytes", () => {
  const columns: CsvColumn<{ name: string }>[] = [{ key: "name", header: "Name" }]

  it("starts with the three UTF-8 byte-order-mark bytes", () => {
    const bytes = toCsvBytes(columns, [{ name: "Ada" }])
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  it("keeps non-English text intact after the byte-order mark", () => {
    const bytes = toCsvBytes(columns, [{ name: "日本語" }])
    // `ignoreBOM: true` is what makes the decoder hand the mark back as a character instead of
    // consuming it the way a decode with the default options would — this is the one assertion
    // that reads the mark and the text it precedes together, as the bytes a consumer receives.
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
    expect(text).toBe(`${CSV_BYTE_ORDER_MARK}Name\r\n日本語\r\n`)
  })

  it("guards a formula-like cell inside the byte-encoded output too", () => {
    const risky: CsvColumn<{ note: string }>[] = [{ key: "note", header: "Note" }]
    const bytes = toCsvBytes(risky, [{ note: "=cmd" }])
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
    expect(text).toBe(`${CSV_BYTE_ORDER_MARK}Note\r\n'=cmd\r\n`)
  })
})
