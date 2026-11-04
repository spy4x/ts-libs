import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { CSV_DEFAULT_LIMITS, decodeTextFile, parseCsv, sniffCsv } from "./csv.ts"

const RUSSIAN = "Дата;Сумма;Описание\n01.02.2026;-1 234,56;Ёлка\n"

/** `text` in Windows-1251: ASCII as is, `А`–`я` from 0xC0, `Ё` 0xA8, `ё` 0xB8. */
function windows1251(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => {
    const code = char.charCodeAt(0)
    if (code < 0x80) return code
    if (char === "Ё") return 0xa8
    if (char === "ё") return 0xb8
    if (code >= 0x410 && code <= 0x44f) return 0xc0 + code - 0x410
    throw new Error(`no Windows-1251 byte for ${char}`)
  })
}

/** `text` in UTF-16 with its byte-order mark, little- or big-endian. */
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(2 + text.length * 2)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0xfeff, littleEndian)
  for (let index = 0; index < text.length; index++) {
    view.setUint16(2 + index * 2, text.charCodeAt(index), littleEndian)
  }
  return bytes
}

describe("decodeTextFile", () => {
  it("reads a Windows-1251 file, a UTF-16 file with its mark and a UTF-8 file without one as the same text", () => {
    const cp1251 = decodeTextFile(windows1251(RUSSIAN), { fallback: "windows-1251" })
    const utf16le = decodeTextFile(utf16(RUSSIAN, true))
    const utf8 = decodeTextFile(new TextEncoder().encode(RUSSIAN))
    expect([cp1251.text, utf16le.text, utf8.text]).toEqual([RUSSIAN, RUSSIAN, RUSSIAN])
    expect([cp1251.encoding, utf16le.encoding, utf8.encoding])
      .toEqual(["windows-1251", "utf-16le", "utf-8"])
  })

  it("reads big-endian UTF-16 by its mark", () => {
    expect(decodeTextFile(utf16(RUSSIAN, false))).toEqual({
      text: RUSSIAN,
      encoding: "utf-16be",
      candidates: [],
    })
  })

  it("drops a UTF-8 byte-order mark", () => {
    const bytes = new TextEncoder().encode("\uFEFFa,b\n")
    expect(decodeTextFile(bytes)).toEqual({ text: "a,b\n", encoding: "utf-8", candidates: [] })
  })

  it("falls back to windows-1252 for bytes that are not UTF-8 and lists the other encodings", () => {
    const decoded = decodeTextFile(windows1251(RUSSIAN))
    expect(decoded.encoding).toBe("windows-1252")
    expect(decoded.text).not.toBe(RUSSIAN)
    expect(decoded.candidates).toContain("windows-1251")
    expect(decoded.candidates).not.toContain("windows-1252")
  })
})

describe("sniffCsv", () => {
  it("finds the semicolon and the header in a German sample whose amounts read 1.234,56", () => {
    const sample = [
      "Buchungstag;Empfänger;Verwendungszweck;Betrag",
      "01.02.2026;Stadtwerke;Abschlag Februar;-1.234,56",
      "03.02.2026;Arbeitgeber GmbH;Gehalt;3.100,00",
      "05.02.2026;Bäckerei;Brötchen, Kaffee;-7,40",
    ].join("\n")
    expect(sniffCsv(sample)).toEqual({ delimiter: ";", delimiters: [";"], header: true })
  })

  it("finds the comma and no header when the first row already holds data", () => {
    const sample = "2026-02-01,Coffee,-3.50\n2026-02-02,Salary,3100.00\n"
    expect(sniffCsv(sample)).toEqual({ delimiter: ",", delimiters: [","], header: false })
  })

  it("counts a delimiter inside quotes as part of its field", () => {
    const sample = 'Date;Payee;Amount\n2026-02-01;"Smith; John";-3.50\n2026-02-02;"A; B; C";10\n'
    expect(sniffCsv(sample).delimiters).toEqual([";"])
  })

  it("finds a tab", () => {
    expect(sniffCsv("Date\tAmount\n2026-02-01\t12.00\n").delimiter).toBe("\t")
  })

  it("lists every delimiter that splits the lines evenly, best first", () => {
    expect(sniffCsv("a;b|c;d\n1;2|3;4\n5;6|7;8\n").delimiters).toEqual([";", "|"])
  })

  it("falls back to a comma for a file with a single column", () => {
    expect(sniffCsv("Amount\n12.00\n13.00\n")).toEqual({
      delimiter: ",",
      delimiters: [","],
      header: true,
    })
  })

  it("picks the delimiter from the records before an endless quoted field", () => {
    expect(sniffCsv(`a;b\nc;d\n"${"x".repeat(1_000_000)}`).delimiter).toBe(";")
  })
})

describe("parseCsv", () => {
  it("parses quoted fields, CRLF line ends and blank lines with the given delimiter", () => {
    const text = '\uFEFFDate;Payee\r\n2026-02-01;"Smith; ""Jr"""\r\n\r\n2026-02-02;"two\nlines"\r\n'
    expect(parseCsv(text, { delimiter: ";" })).toEqual({
      ok: true,
      value: [["Date", "Payee"], ["2026-02-01", 'Smith; "Jr"'], ["2026-02-02", "two\nlines"]],
    })
  })

  it("drops a leading byte-order mark before it checks the limits", () => {
    expect(parseCsv('\uFEFF"a,b"\n', { maxColumns: 1 })).toEqual({ ok: true, value: [["a,b"]] })
  })

  it("refuses a file past maxRows with the line where the extra row starts", () => {
    expect(parseCsv("h\n\na\nb\nc\n", { maxRows: 3 })).toEqual({
      ok: false,
      error: { type: "too-many-rows", line: 5, maxRows: 3 },
    })
    expect(parseCsv("h\na\nb\n", { maxRows: 3 }).ok).toBe(true)
  })

  it("refuses a field past maxFieldLength with the line where the field starts", () => {
    expect(parseCsv(`a,b\nc,"x\n${"y".repeat(10)}"\n`, { maxFieldLength: 8 })).toEqual({
      ok: false,
      error: { type: "field-too-long", line: 2, maxFieldLength: 8 },
    })
    expect(parseCsv(`a,"${"y".repeat(8)}"\n`, { maxFieldLength: 8 }).ok).toBe(true)
  })

  it("refuses a record past maxColumns with its line", () => {
    expect(parseCsv("a,b\nc,d,e\n", { maxColumns: 2 })).toEqual({
      ok: false,
      error: { type: "too-many-columns", line: 2, maxColumns: 2 },
    })
  })

  it("refuses an unclosed quote with the line where it opened", () => {
    expect(parseCsv('a,b\nc,"d\ne\nf\n')).toEqual({
      ok: false,
      error: { type: "unclosed-quote", line: 2 },
    })
  })

  it("reads a file of only quotes without throwing", () => {
    expect(parseCsv('"""""')).toEqual({ ok: false, error: { type: "unclosed-quote", line: 1 } })
    expect(parseCsv('""""')).toEqual({ ok: true, value: [['"']] })
    expect(parseCsv('"'.repeat(1_000_001)).ok).toBe(false)
  })

  it("refuses a stray quote as malformed, with the line of its record", () => {
    const result = parseCsv('a,b\nc,d"e\n')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatchObject({ type: "malformed", line: 2 })
  })

  it("applies every limit by default", () => {
    expect(CSV_DEFAULT_LIMITS).toEqual({
      maxRows: 100_000,
      maxFieldLength: 10_000,
      maxColumns: 1_000,
    })
    expect(parseCsv("a\n".repeat(1_000_000))).toEqual({
      ok: false,
      error: { type: "too-many-rows", line: 100_001, maxRows: 100_000 },
    })
    expect(parseCsv(`a,${"x".repeat(10_001)}\n`)).toEqual({
      ok: false,
      error: { type: "field-too-long", line: 1, maxFieldLength: 10_000 },
    })
    expect(parseCsv(",".repeat(1_000))).toEqual({
      ok: false,
      error: { type: "too-many-columns", line: 1, maxColumns: 1_000 },
    })
  })

  it("takes a limit the caller raises", () => {
    const result = parseCsv("a\n".repeat(100_001), { maxRows: 200_000 })
    expect(result.ok && result.value.length).toBe(100_001)
  })

  it("throws for a delimiter or a limit a caller cannot mean", () => {
    expect(() => parseCsv("a", { delimiter: "" })).toThrow(RangeError)
    expect(() => parseCsv("a", { delimiter: '"' })).toThrow(RangeError)
    expect(() => parseCsv("a😀b", { delimiter: "😀" })).toThrow(RangeError)
    expect(() => parseCsv("a", { maxRows: 0 })).toThrow(RangeError)
    expect(() => parseCsv("a", { maxFieldLength: 1.5 })).toThrow(RangeError)
  })
})
