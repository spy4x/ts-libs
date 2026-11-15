import { assertEquals, assertThrows } from "@std/assert"
import { parseFireflyIii } from "./app-exports.ts"
import { StatementError } from "./statement.ts"

/** Firefly III's transactions header, as its export writes it, with two of its meta columns. */
const HEADER = [
  "user_id",
  "group_id",
  "journal_id",
  "created_at",
  "updated_at",
  "group_title",
  "type",
  "currency_code",
  "amount",
  "foreign_currency_code",
  "foreign_amount",
  "primary_currency_code",
  "pc_amount",
  "pc_foreign_amount",
  "description",
  "date",
  "source_name",
  "source_iban",
  "source_type",
  "destination_name",
  "destination_iban",
  "destination_type",
  "reconciled",
  "category",
  "budget",
  "bill",
  "tags",
  "notes",
  "sepa_cc",
  "external_id",
]

type Row = Record<string, string>

/** A synthetic export: the header, then one line per row, cells quoted only when they need it. */
function exportOf(rows: Row[], header = HEADER): string {
  const field = (value: string) =>
    value.includes(",") || value.includes('"') || value.includes("\n")
      ? `"${value.replaceAll('"', '""')}"`
      : value
  const lines = [header.join(",")]
  for (const row of rows) lines.push(header.map((name) => field(row[name] ?? "")).join(","))
  return lines.join("\n") + "\n"
}

const checking = {
  source_name: "Checking",
  source_iban: "DE00123456780000000001",
  source_type: "Asset account",
}

const withdrawal: Row = {
  user_id: "1",
  group_id: "10",
  journal_id: "11",
  type: "Withdrawal",
  currency_code: "EUR",
  amount: "'-12.34",
  description: "Lunch",
  date: "2024-03-01T00:30:00+01:00",
  ...checking,
  destination_name: "Cafe",
  destination_type: "Expense account",
  category: "Food",
  tags: "work,lunch",
  notes: "with the team",
}

Deno.test("a withdrawal becomes a negative entry on its asset account, paid to the expense", () => {
  const history = parseFireflyIii(exportOf([withdrawal]))
  assertEquals(history.rowErrors, [])
  assertEquals(history.entries, [{
    line: 2,
    date: "2024-03-01",
    description: "Lunch",
    category: "Food",
    tags: ["work", "lunch"],
    notes: "with the team",
    sourceId: "11",
    groupId: "10",
    account: "Checking",
    amount: -1234,
    currency: "EUR",
    payee: "Cafe",
  }])
  assertEquals(history.accounts, [
    { name: "Checking", kind: "asset", iban: "DE00123456780000000001", currency: "EUR" },
    { name: "Cafe", kind: "expense" },
  ])
  assertEquals(history.categories, [{ name: "Food" }])
  assertEquals(history.transfers, [])
})

Deno.test("a date keeps its local day and is never shifted by the offset", () => {
  const history = parseFireflyIii(exportOf([{ ...withdrawal, date: "2024-03-01T23:30:00-11:00" }]))
  assertEquals(history.entries[0].date, "2024-03-01")
})

Deno.test("a deposit becomes a positive entry on its asset account, paid by the revenue", () => {
  const history = parseFireflyIii(exportOf([{
    group_id: "20",
    journal_id: "21",
    type: "Deposit",
    currency_code: "EUR",
    amount: "2500.00",
    description: "Salary",
    date: "2024-03-25T00:00:00+01:00",
    source_name: "Employer",
    source_type: "Revenue account",
    destination_name: "Checking",
    destination_type: "Asset account",
  }]))
  assertEquals(history.rowErrors, [])
  assertEquals(
    history.entries.map(({ account, amount, payee, tags }) => ({ account, amount, payee, tags })),
    [
      { account: "Checking", amount: 250000, payee: "Employer", tags: [] },
    ],
  )
  assertEquals(history.accounts.map(({ name, kind }) => ({ name, kind })), [
    { name: "Employer", kind: "revenue" },
    { name: "Checking", kind: "asset" },
  ])
})

Deno.test("a transfer between two currencies keeps the received amount on the receiving side", () => {
  const history = parseFireflyIii(exportOf([{
    group_id: "30",
    journal_id: "31",
    type: "Transfer",
    currency_code: "EUR",
    amount: "100.00",
    foreign_currency_code: "USD",
    foreign_amount: "108.50",
    description: "To savings",
    date: "2024-04-02T00:00:00+02:00",
    ...checking,
    destination_name: "Savings USD",
    destination_type: "Asset account",
    tags: "move",
  }]))
  assertEquals(history.rowErrors, [])
  assertEquals(history.entries, [])
  assertEquals(history.transfers, [{
    line: 2,
    date: "2024-04-02",
    description: "To savings",
    tags: ["move"],
    sourceId: "31",
    groupId: "30",
    from: "Checking",
    to: "Savings USD",
    amount: 10000,
    currency: "EUR",
    foreignAmount: 10850,
    foreignCurrency: "USD",
  }])
  assertEquals(history.accounts.map(({ name, currency }) => ({ name, currency })), [
    { name: "Checking", currency: "EUR" },
    { name: "Savings USD", currency: "USD" },
  ])
})

Deno.test("each split of a group is its own entry, and the splits share the group id", () => {
  const history = parseFireflyIii(exportOf([
    { ...withdrawal, journal_id: "41", group_id: "40", amount: "'-30.00", category: "Food" },
    {
      ...withdrawal,
      journal_id: "42",
      group_id: "40",
      amount: "'-20.00",
      category: "Home",
      tags: "",
    },
  ]))
  assertEquals(history.rowErrors, [])
  assertEquals(
    history.entries.map(({ groupId, sourceId, amount, category }) => ({
      groupId,
      sourceId,
      amount,
      category,
    })),
    [
      { groupId: "40", sourceId: "41", amount: -3000, category: "Food" },
      { groupId: "40", sourceId: "42", amount: -2000, category: "Home" },
    ],
  )
  assertEquals(history.categories, [{ name: "Food" }, { name: "Home" }])
  assertEquals(history.accounts.length, 2)
})

Deno.test("an opening balance is an entry on the asset account, signed as the asset sees it", () => {
  const opening = {
    type: "Opening balance",
    currency_code: "EUR",
    description: "Initial balance",
    date: "2024-01-01T00:00:00+01:00",
  }
  const history = parseFireflyIii(exportOf([
    {
      ...opening,
      amount: "500.00",
      source_name: "Checking initial balance",
      source_type: "Initial balance account",
      destination_name: "Checking",
      destination_type: "Asset account",
    },
    {
      ...opening,
      amount: "'-75.00",
      source_name: "Wallet",
      source_type: "Asset account",
      destination_name: "Wallet initial balance",
      destination_type: "Initial balance account",
    },
  ]))
  assertEquals(history.rowErrors, [])
  assertEquals(history.entries.map(({ account, amount, payee }) => ({ account, amount, payee })), [
    { account: "Checking", amount: 50000, payee: undefined },
    { account: "Wallet", amount: -7500, payee: undefined },
  ])
  assertEquals(history.accounts.map(({ name }) => name), ["Checking", "Wallet"])
})

Deno.test("a reconciliation is signed by which side the asset is on, though the file writes it positive", () => {
  const reconciliation = {
    type: "Reconciliation",
    currency_code: "EUR",
    amount: "3.10",
    description: "Reconciliation",
    date: "2024-05-31T00:00:00+02:00",
  }
  const history = parseFireflyIii(exportOf([
    {
      ...reconciliation,
      ...checking,
      destination_name: "Checking reconciliation",
      destination_type: "Reconciliation account",
    },
    {
      ...reconciliation,
      source_name: "Checking reconciliation",
      source_type: "Reconciliation account",
      destination_name: "Checking",
      destination_type: "Asset account",
    },
  ]))
  assertEquals(history.rowErrors, [])
  assertEquals(history.entries.map(({ account, amount }) => ({ account, amount })), [
    { account: "Checking", amount: -310 },
    { account: "Checking", amount: 310 },
  ])
  assertEquals(history.accounts.map(({ name }) => name), ["Checking"])
})

Deno.test("a liability credit is an entry on the liability, and liabilities keep their kind", () => {
  const history = parseFireflyIii(exportOf([{
    type: "Liability credit",
    currency_code: "EUR",
    amount: "1000.00",
    description: "Car loan",
    date: "2024-02-01T00:00:00+01:00",
    source_name: "Car loan credit",
    source_type: "Liability credit account",
    destination_name: "Car loan",
    destination_type: "Loan",
  }]))
  assertEquals(history.rowErrors, [])
  assertEquals(history.entries[0].amount, 100000)
  assertEquals(history.accounts, [{ name: "Car loan", kind: "liability", currency: "EUR" }])
})

Deno.test("accounts and categories are listed once, first seen first, an account per kind and name", () => {
  const history = parseFireflyIii(exportOf([
    withdrawal,
    withdrawal,
    {
      type: "Deposit",
      currency_code: "EUR",
      amount: "5.00",
      description: "Refund",
      date: "2024-03-02T00:00:00+01:00",
      source_name: "Cafe",
      source_type: "Revenue account",
      destination_name: "Checking",
      destination_type: "Asset account",
      category: "Food",
    },
  ]))
  assertEquals(history.accounts.map(({ name, kind }) => ({ name, kind })), [
    { name: "Checking", kind: "asset" },
    { name: "Cafe", kind: "expense" },
    { name: "Cafe", kind: "revenue" },
  ])
  assertEquals(history.categories, [{ name: "Food" }])
})

Deno.test("a zero withdrawal is 0, not -0", () => {
  const history = parseFireflyIii(exportOf([{
    ...withdrawal,
    amount: "0.00",
    foreign_amount: "0",
    foreign_currency_code: "JPY",
  }]))
  assertEquals(Object.is(history.entries[0].amount, 0), true)
  assertEquals(Object.is(history.entries[0].foreignAmount, 0), true)
})

Deno.test("an account in two currencies keeps no currency", () => {
  const history = parseFireflyIii(exportOf([
    withdrawal,
    { ...withdrawal, currency_code: "USD" },
  ]))
  assertEquals(history.accounts[0], {
    name: "Checking",
    kind: "asset",
    iban: "DE00123456780000000001",
  })
})

Deno.test("an account type named like an object property is other", () => {
  const history = parseFireflyIii(exportOf([
    { ...withdrawal, source_type: "constructor", destination_type: "__proto__" },
  ]))
  assertEquals(history.accounts.map((account) => account.kind), [`other`, `other`])
})

Deno.test("a withdrawal paid in another currency keeps the foreign amount, negative", () => {
  const history = parseFireflyIii(exportOf([{
    ...withdrawal,
    foreign_currency_code: "JPY",
    foreign_amount: "'-2000",
  }]))
  assertEquals(history.entries[0].foreignAmount, -2000)
  assertEquals(history.entries[0].foreignCurrency, "JPY")
})

Deno.test("formula-escaped cells lose only the escape quote", () => {
  const history = parseFireflyIii(exportOf([{
    ...withdrawal,
    description: "'=SUM(A1)",
    notes: "'@home",
    category: "'+plus",
    tags: "'it's",
  }]))
  assertEquals(history.rowErrors, [])
  const [entry] = history.entries
  assertEquals(entry.description, "=SUM(A1)")
  assertEquals(entry.notes, "@home")
  assertEquals(entry.category, "+plus")
  assertEquals(entry.tags, ["'it's"])
  assertEquals(entry.amount, -1234)
})

Deno.test("columns in another order, in another case, and extra ones, read the same", () => {
  const reordered = [...HEADER].reverse()
  reordered.push("internal_reference")
  const text = exportOf([withdrawal], reordered).replace(",type,", ", Type ,")
  const history = parseFireflyIii(text)
  assertEquals(history, parseFireflyIii(exportOf([withdrawal])))
})

Deno.test("a file without a required column is refused whole", () => {
  for (const column of ["type", "amount", "currency_code", "date", "source_name"]) {
    const error = assertThrows(
      () => parseFireflyIii(exportOf([withdrawal], HEADER.filter((name) => name !== column))),
      StatementError,
      column,
    )
    assertEquals(error.code, "malformed")
  }
  for (const column of ["destination_name", "description"]) {
    assertThrows(
      () => parseFireflyIii(exportOf([withdrawal], HEADER.filter((name) => name !== column))),
      StatementError,
      column,
    )
  }
})

Deno.test("an empty file is refused whole", () => {
  const error = assertThrows(() => parseFireflyIii("\n\n"), StatementError, "no header")
  assertEquals(error.code, "malformed")
})

Deno.test("a header that does not read as CSV is refused whole", () => {
  const error = assertThrows(() => parseFireflyIii('type,"amount\n'), StatementError, "header")
  assertEquals(error.code, "malformed")
})

Deno.test("a bad row becomes a row error with its line, and the other rows still read", () => {
  const history = parseFireflyIii(exportOf([
    withdrawal,
    { ...withdrawal, type: "Refund" },
    { ...withdrawal, date: "01/03/2024" },
    { ...withdrawal, amount: "twelve" },
    { ...withdrawal, currency_code: "XXQ" },
    { ...withdrawal, amount: "-12.345" },
    { ...withdrawal, foreign_amount: "5.00", foreign_currency_code: "" },
    { ...withdrawal, source_name: "" },
    { ...withdrawal, destination_name: "" },
    { ...withdrawal, type: "Opening balance", destination_type: "Expense account" },
    withdrawal,
  ]))
  assertEquals(history.rowErrors, [
    { line: 3, reason: 'unknown type "Refund"' },
    { line: 4, reason: 'date "01/03/2024" is not ISO 8601' },
    { line: 5, reason: 'amount "twelve" is not a number' },
    { line: 6, reason: 'unknown currency "XXQ"' },
    { line: 7, reason: 'amount "-12.345" is not a number' },
    { line: 8, reason: 'foreign unknown currency ""' },
    { line: 9, reason: "no source account" },
    { line: 10, reason: "no destination account" },
    { line: 11, reason: "Opening balance has no initial balance or reconciliation account" },
  ])
  assertEquals(history.entries.map(({ line }) => line), [2, 12])
})

Deno.test("a row whose CSV does not read is a row error at its first line", () => {
  const text = exportOf([withdrawal]) + 'a,"b"c\n' + exportOf([withdrawal]).split("\n")[1] + "\n"
  const history = parseFireflyIii(text)
  assertEquals(history.rowErrors, [{ line: 3, reason: "csv: malformed" }])
  assertEquals(history.entries.map(({ line }) => line), [2, 4])
})

Deno.test("a cell over 10,000 characters is a row error", () => {
  const history = parseFireflyIii(exportOf([{ ...withdrawal, notes: "x".repeat(10_001) }]))
  assertEquals(history.rowErrors, [{ line: 2, reason: "csv: field-too-long" }])
})

Deno.test("a file over maxBytes is refused whole", () => {
  const text = exportOf([withdrawal])
  const error = assertThrows(
    () => parseFireflyIii(text, { maxBytes: text.length - 1 }),
    StatementError,
  )
  assertEquals(error.code, "too-large")
  assertEquals(parseFireflyIii(text, { maxBytes: text.length }).entries.length, 1)
})

Deno.test("a file over maxRows is refused whole", () => {
  const text = exportOf([withdrawal, withdrawal, withdrawal])
  const error = assertThrows(() => parseFireflyIii(text, { maxRows: 2 }), StatementError)
  assertEquals(error.code, "too-large")
  assertEquals(parseFireflyIii(text, { maxRows: 3 }).entries.length, 3)
})
