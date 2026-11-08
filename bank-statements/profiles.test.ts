import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  builtInProfiles,
  guessProfile,
  matchProfile,
  parseMt940,
  parseWithProfile,
  readStatement,
  type StatementProfile,
  verifyStatement,
} from "./mod.ts"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const text = (name: string) => Deno.readTextFile(new URL(name, FIXTURES))
const [signed, debitCredit, preamble] = builtInProfiles

describe("built-in profiles", () => {
  it("read the signed-amount fixture into rows in minor units that verify", async () => {
    const statement = parseWithProfile(await text("signed.csv"), signed)
    expect(statement.rowErrors).toEqual([])
    expect(statement.rows.map(({ line, date, amount, currency, memo, balance }) => ({
      line,
      date,
      amount,
      currency,
      memo,
      balance,
    }))).toEqual([
      {
        line: 2,
        date: "2026-01-02",
        amount: 250000,
        currency: "EUR",
        memo: "Salary",
        balance: 350000,
      },
      {
        line: 3,
        date: "2026-01-03",
        amount: -8437,
        currency: "EUR",
        memo: "Groceries, weekly",
        balance: 341563,
      },
      {
        line: 4,
        date: "2026-01-05",
        amount: -120000,
        currency: "EUR",
        memo: "Rent",
        balance: 221563,
      },
      {
        line: 5,
        date: "2026-01-07",
        amount: -350,
        currency: "EUR",
        memo: "Coffee",
        balance: 221213,
      },
    ])
    expect(verifyStatement(statement)).toEqual({ status: "verified" })
  })

  it("read debit and credit columns newest first, a negative debit included, and verify", async () => {
    const file = await Deno.readFile(new URL("debit-credit.csv", FIXTURES))
    const statement = readStatement(file, { profile: debitCredit })
    expect(statement.rows.map(({ date, amount, balance }) => ({ date, amount, balance }))).toEqual([
      { date: "2026-01-07", amount: -104520, balance: 95000 },
      { date: "2026-01-05", amount: -480, balance: 199520 },
      { date: "2026-01-03", amount: 200000, balance: 200000 },
    ])
    expect(verifyStatement(statement)).toEqual({ status: "verified" })
  })

  it("skip preamble lines and read parenthesised and original amounts", async () => {
    const statement = parseWithProfile(await text("preamble.csv"), preamble)
    expect(statement.rowErrors).toEqual([])
    expect(statement.rows).toEqual([
      {
        line: 5,
        date: "2026-01-02",
        amount: -123456,
        currency: "USD",
        payee: "Online Shop",
        reference: "REF-001",
      },
      {
        line: 6,
        date: "2026-01-10",
        amount: -11000,
        currency: "USD",
        payee: "Hotel Example",
        reference: "REF-002",
        originalAmount: -10000,
        originalCurrency: "EUR",
      },
      {
        line: 7,
        date: "2026-01-15",
        amount: 2500,
        currency: "USD",
        payee: "Refund Example",
        reference: "REF-003",
      },
    ])
  })
})

describe("verifyStatement", () => {
  it("fails a statement with one amount changed and names that row's line", async () => {
    const source = (await text("signed.csv")).replace("-1200.00", "-1210.00")
    expect(verifyStatement(parseWithProfile(source, signed))).toEqual({
      status: "failed",
      failures: [{ type: "running", line: 4, expected: 220563, found: 221563 }],
    })
  })

  it("fails a closing balance one cent off with the expected and the found closing", async () => {
    const source = (await text("mt940.sta")).replace(
      ":62F:C260131EUR1469,50",
      ":62F:C260131EUR1469,51",
    )
    expect(verifyStatement(parseMt940(source))).toEqual({
      status: "failed",
      failures: [{ type: "closing", line: 13, expected: 146950, found: 146951 }],
    })
  })

  it("fails a closing balance that does not follow the last running balance", async () => {
    const statement = parseWithProfile(await text("signed.csv"), signed)
    statement.closingBalance = { amount: 221214, line: 6 }
    expect(verifyStatement(statement)).toEqual({
      status: "failed",
      failures: [{ type: "closing", line: 6, expected: 221213, found: 221214 }],
    })
  })

  it("returns unverifiable for one row whose balance nothing else states", async () => {
    const source = (await text("signed.csv")).split("\n").slice(0, 2).join("\n")
    const statement = parseWithProfile(source, signed)
    expect(statement.rows).toHaveLength(1)
    expect(verifyStatement(statement)).toEqual({ status: "unverifiable" })
  })

  it("returns unverifiable for a file without balances", async () => {
    expect(verifyStatement(parseWithProfile(await text("preamble.csv"), preamble))).toEqual({
      status: "unverifiable",
    })
  })

  it("never verifies a statement with a row error, even when the balances add up", async () => {
    const source = `${await text("signed.csv")}2026-02-30,Bad date,0.00,EUR,2212.13\n`
    const statement = parseWithProfile(source, signed)
    expect(statement.rows).toHaveLength(4)
    expect(verifyStatement(statement)).toEqual({
      status: "failed",
      failures: [{ type: "row-error", line: 6, reason: `date "2026-02-30" is not YYYY-MM-DD` }],
    })
  })
})

describe("parseWithProfile", () => {
  it("turns a row with an unclosed quote into a row error and keeps the rows before it", async () => {
    const statement = parseWithProfile(
      `${await text("signed.csv")}2026-01-08,"Broken,-1.00,EUR,2211.13\n`,
      signed,
    )
    expect(statement.rows).toHaveLength(4)
    expect(statement.rowErrors).toEqual([{ line: 6, reason: "csv: unclosed-quote" }])
  })

  it("refuses a profile that does not match the schema", () => {
    const broken = { ...signed, date: { column: -1, pattern: "YYYY-MM-DD" } } as StatementProfile
    expect(() => parseWithProfile("", broken)).toThrow(TypeError)
  })

  it("refuses a file with more rows than maxRows before reading one", async () => {
    const source = await text("signed.csv")
    expect(() => parseWithProfile(source, signed, { maxRows: 3 })).toThrow(
      "4 rows, over the limit of 3",
    )
  })
})

describe("matchProfile", () => {
  it("ranks the profile whose fingerprint the file has first", async () => {
    const decode = new TextDecoder("windows-1252")
    const samples = [
      await text("signed.csv"),
      decode.decode(await Deno.readFile(new URL("debit-credit.csv", FIXTURES))),
      await text("preamble.csv"),
    ]
    expect(samples.map((sample) => matchProfile(sample, builtInProfiles)[0]?.profile.id)).toEqual(
      builtInProfiles.map((profile) => profile.id),
    )
    expect(matchProfile(await text("signed.csv"), builtInProfiles)[0].score).toBe(1)
  })

  it("leaves out a profile whose column count differs", () => {
    expect(matchProfile("Date,Description,Amount\n2026-01-01,x,1.00\n", [signed])).toEqual([])
  })
})

describe("guessProfile", () => {
  it("guesses a profile for the signed fixture that reads the same rows", async () => {
    const source = await text("signed.csv")
    const guess = guessProfile(source, "USD")
    expect(guess).not.toBeNull()
    const { id: _id, name: _name, ...shape } = guess!
    expect(shape).toEqual({
      encoding: "utf-8",
      delimiter: ",",
      headerLine: 1,
      date: { column: 0, pattern: "YYYY-MM-DD" },
      amount: { column: 2 },
      numberFormat: { decimal: ".", group: "" },
      negatives: ["minus", "parentheses", "trailing-minus"],
      currency: { column: 3 },
      description: 1,
      balance: 4,
      fingerprint: {
        headers: ["date", "description", "amount", "currency", "balance"],
        columns: 5,
        delimiter: ",",
      },
    })
    expect(parseWithProfile(source, guess!).rows).toEqual(parseWithProfile(source, signed).rows)
  })

  it("finds a debit and credit pair, the number format and a preamble", () => {
    const source = [
      "Statement of account",
      "",
      "Datum;Empfänger;Soll;Haben;Saldo",
      "03.01.2026;Arbeitgeber;;2.000,00;2.000,00",
      "05.01.2026;Bäckerei;4,80;;1.995,20",
      "07.01.2026;Stadtwerke;1.045,20;;950,00",
    ].join("\n")
    const guess = guessProfile(source, "EUR")!
    expect(guess.headerLine).toBe(3)
    expect(guess.amount).toEqual({ debit: 2, credit: 3 })
    expect(guess.numberFormat).toEqual({ decimal: ",", group: "." })
    expect(guess.currency).toEqual({ code: "EUR" })
    expect(guess.payee).toBe(1)
    expect(verifyStatement(parseWithProfile(source, guess))).toEqual({ status: "verified" })
  })

  it("returns null for text with no date column", () => {
    expect(guessProfile("Name,Age\nAnna,30\nBen,41\n", "EUR")).toBeNull()
  })
})
