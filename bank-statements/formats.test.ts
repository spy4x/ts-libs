import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  builtInProfiles,
  detectFormat,
  parseCamt053,
  parseMt940,
  parseOfx,
  parseQif,
  readStatement,
  StatementError,
  verifyStatement,
} from "./mod.ts"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const bytes = (name: string) => Deno.readFile(new URL(name, FIXTURES))
const text = (name: string) => Deno.readTextFile(new URL(name, FIXTURES))

describe("detectFormat", () => {
  it("names every fixture's format by content", async () => {
    const formats = await Promise.all(
      ["ofx1.ofx", "ofx2.qfx", "bank.qif", "camt053.xml", "mt940.sta", "signed.csv"].map(
        async (name) => detectFormat(await bytes(name)),
      ),
    )
    expect(formats).toEqual(["ofx", "ofx", "qif", "camt053", "mt940", "csv"])
  })

  it("names a PDF and refuses to guess at binary or other XML", () => {
    const encode = (value: string) => new TextEncoder().encode(value)
    expect(detectFormat(encode("%PDF-1.7\n"))).toBe("pdf")
    expect(detectFormat(encode("<html><body></body></html>"))).toBe("unknown")
    expect(detectFormat(Uint8Array.of(0, 1, 2, 3, 0, 0))).toBe("unknown")
  })
})

describe("parseOfx", () => {
  it("reads OFX 1 SGML into rows in minor units with its closing balance", async () => {
    const statement = parseOfx(await text("ofx1.ofx"))
    expect(statement.rowErrors).toEqual([])
    expect(statement.rows).toEqual([
      {
        line: 39,
        date: "2026-01-02",
        amount: 150000,
        currency: "USD",
        payee: "Example Employer",
        memo: "Payroll",
        reference: "OFX1-0001",
      },
      {
        line: 47,
        date: "2026-01-05",
        amount: -4210,
        currency: "USD",
        payee: "Corner Store & Deli",
        reference: "OFX1-0002",
      },
      {
        line: 55,
        date: "2026-01-10",
        amount: -9999,
        currency: "USD",
        payee: "Example Utility",
        reference: "OFX1-0003",
        originalCurrency: "EUR",
      },
    ])
    expect(statement.closingBalance).toEqual({ amount: 135791, line: 73 })
  })

  it("reads OFX 2 XML, a credit card statement, the same way", async () => {
    const statement = parseOfx(await text("ofx2.qfx"))
    expect(statement.rows.map(({ date, amount, currency, payee }) => ({
      date,
      amount,
      currency,
      payee,
    }))).toEqual([
      { date: "2026-01-04", amount: -1200, currency: "GBP", payee: "Example Cinema" },
      { date: "2026-01-20", amount: 20000, currency: "GBP", payee: "Payment received" },
    ])
    expect(statement.rows.map((row) => row.line)).toEqual([21, 29])
    expect(statement.closingBalance?.amount).toBe(18800)
  })

  it("refuses an OFX 2 file with a DTD before reading any row", async () => {
    const source = (await text("ofx2.qfx")).replace(
      "<OFX>",
      `<!DOCTYPE OFX [<!ENTITY x "y">]><OFX>`,
    )
    expect(() => parseOfx(source)).toThrow(StatementError)
    try {
      parseOfx(source)
    } catch (error) {
      expect((error as StatementError).code).toBe("forbidden")
    }
  })

  it("refuses a file holding two accounts instead of mixing them", async () => {
    const source = await text("ofx1.ofx")
    const statement = source.slice(source.indexOf("<STMTTRNRS>"), source.indexOf("</BANKMSGSRSV1>"))
    const doubled = source.replace("</BANKMSGSRSV1>", `${statement}</BANKMSGSRSV1>`)
    expect(() => parseOfx(doubled)).toThrow("2 statements")
  })

  it("turns a transaction with a broken amount into a row error with its line", async () => {
    const statement = parseOfx((await text("ofx1.ofx")).replace("-42.10", "-42.1O"))
    expect(statement.rowErrors).toEqual([{ line: 47, reason: `amount "-42.1O" is not a number` }])
    expect(statement.rows).toHaveLength(2)
  })

  it("reads hostile OFX 1 in linear time instead of hanging", () => {
    const deep = `OFXHEADER:100\n<OFX>${"<A>".repeat(200_000)}${"</A>".repeat(200_000)}`
    const unclosed = `OFXHEADER:100\n<OFX>${"</".repeat(2_000_000)}`
    const started = performance.now()
    expect(() => parseOfx(deep)).toThrow("nested too deep")
    expect(() => parseOfx(unclosed)).toThrow(StatementError)
    expect(performance.now() - started).toBeLessThan(2_000)
  })
})

describe("parseQif", () => {
  it("reads a QIF file with US dates, apostrophe years and grouped amounts", async () => {
    const statement = parseQif(await text("bank.qif"), { currency: "USD" })
    expect(statement.rowErrors).toEqual([])
    expect(statement.rows).toEqual([
      {
        line: 2,
        date: "2026-01-02",
        amount: 125000,
        currency: "USD",
        payee: "Example Employer",
        memo: "January salary",
        reference: "1001",
      },
      { line: 8, date: "2026-01-15", amount: -7525, currency: "USD", payee: "Example Pharmacy" },
      { line: 13, date: "2026-01-31", amount: -999, currency: "USD", payee: "Example Streaming" },
    ])
  })

  it("refuses an investment section", () => {
    expect(() => parseQif("!Type:Invst\nD1/2'26\n^\n", { currency: "USD" })).toThrow(
      "is not an account",
    )
  })
})

describe("parseCamt053", () => {
  it("reads booked entries with balances, payees and original amounts, and skips pending ones", async () => {
    const statement = parseCamt053(await text("camt053.xml"))
    expect(statement.rowErrors).toEqual([])
    expect(statement.openingBalance).toEqual({ amount: 100000, line: 16 })
    expect(statement.closingBalance).toEqual({ amount: 120010, line: 28 })
    expect(statement.rows).toEqual([
      {
        line: 40,
        date: "2026-01-05",
        amount: 25000,
        currency: "EUR",
        payee: "Example Client Ltd",
        memo: "Invoice 2026-001",
        reference: "BANK-REF-0001",
      },
      {
        line: 69,
        date: "2026-01-12",
        amount: -4990,
        currency: "EUR",
        payee: "Example Software Inc",
        memo: "Licence January",
        reference: "BANK-REF-0002",
        originalAmount: -5400,
        originalCurrency: "USD",
      },
    ])
    expect(verifyStatement(statement)).toEqual({ status: "verified" })
  })

  it("refuses a file with a DTD before reading any entry", async () => {
    const source = (await text("camt053.xml")).replace(
      "<Document",
      `<!DOCTYPE Document [<!ENTITY big "x">]><Document`,
    )
    try {
      parseCamt053(source)
      throw new Error("parsed a document with a DTD")
    } catch (error) {
      expect(error).toBeInstanceOf(StatementError)
      expect((error as StatementError).code).toBe("forbidden")
    }
  })
})

describe("parseMt940", () => {
  it("reads :61: rows with reversals and :86: details, and the :60F: and :62F: balances", async () => {
    const statement = parseMt940(await text("mt940.sta"))
    expect(statement.rowErrors).toEqual([])
    expect(statement.openingBalance).toEqual({ amount: 50000, line: 5 })
    expect(statement.closingBalance).toEqual({ amount: 146950, line: 13 })
    expect(statement.rows).toEqual([
      {
        line: 6,
        date: "2026-01-02",
        amount: 100000,
        currency: "EUR",
        reference: "BANK-0001",
        memo: "Salary January from Example Employer",
      },
      {
        line: 9,
        date: "2026-01-05",
        amount: -3550,
        currency: "EUR",
        reference: "CARD-0002",
        memo: "Example Supermarket",
      },
      {
        line: 11,
        date: "2026-01-31",
        amount: 500,
        currency: "EUR",
        reference: "BANK-0003",
        memo: "Fee refund",
      },
    ])
    expect(verifyStatement(statement)).toEqual({ status: "verified" })
  })

  it("dates an entry in December by the year before a January value date", () => {
    const source =
      ":20:X\n:25:A\n:60F:C260101EUR0,00\n:61:2601011231D1,00NTRFNONREF\n:62F:D260101EUR1,00\n"
    expect(parseMt940(source).rows[0].date).toBe("2025-12-31")
  })
})

describe("readStatement", () => {
  it("refuses a file past maxBytes before decoding it", () => {
    const file = new TextEncoder().encode("Date,Amount\n2026-01-01,1.00\n")
    try {
      readStatement(file, { maxBytes: 10, profile: builtInProfiles[0] })
      throw new Error("read a file past maxBytes")
    } catch (error) {
      expect(error).toBeInstanceOf(StatementError)
      expect((error as StatementError).code).toBe("too-large")
    }
  })

  it("refuses a file with more rows than maxRows before reading one", async () => {
    const file = await bytes("mt940.sta")
    expect(() => readStatement(file, { maxRows: 2 })).toThrow(
      "3 rows, over the limit of 2",
    )
  })

  it("reads a Windows-1252 CSV through its profile's encoding", async () => {
    const statement = readStatement(await bytes("debit-credit.csv"), {
      profile: builtInProfiles[1],
    })
    expect(statement.rows.map((row) => row.payee)).toEqual([
      "Stadtwerke",
      "Bäckerei Müller",
      "Arbeitgeber GmbH",
    ])
  })

  it("asks for a profile for CSV and refuses a PDF", () => {
    const encode = (value: string) => new TextEncoder().encode(value)
    expect(() => readStatement(encode("a,b\n1,2\n"))).toThrow("needs a profile")
    expect(() => readStatement(encode("%PDF-1.7\n"))).toThrow("cannot read a pdf file")
  })
})
