import { assertEquals, assertRejects } from "@std/assert"
import { parseYnab } from "./app-exports.ts"
import { StatementError } from "./statement.ts"

/** YNAB's register header, as its export writes it. */
const HEADER = [
  "Account",
  "Flag",
  "Date",
  "Payee",
  "Category Group/Category",
  "Category Group",
  "Category",
  "Memo",
  "Outflow",
  "Inflow",
  "Cleared",
]

type Row = Record<string, string>

/** A register CSV with every cell quoted, as YNAB writes it. */
function register(rows: Row[], header = HEADER): string {
  const line = (cells: string[]) => cells.map((cell) => `"${cell.replaceAll(`"`, `""`)}"`).join(",")
  return [line(header), ...rows.map((row) => line(header.map((name) => row[name] ?? "")))]
    .join("\r\n")
}

/** A row on `account`, with the categories YNAB writes for `group` and `category`. */
function row(account: string, date: string, payee: string, fields: Row = {}): Row {
  const { group = "", category = "", ...rest } = fields
  return {
    Account: account,
    Date: date,
    Payee: payee,
    "Category Group/Category": group && category ? `${group}: ${category}` : "",
    "Category Group": group,
    Category: category,
    Outflow: "$0.00",
    Inflow: "$0.00",
    Cleared: "Cleared",
    ...rest,
  }
}

const encoder = new TextEncoder()

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes.slice()]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** One file to put in a test zip: its data as written, and what its headers claim. */
interface ZipFile {
  name: string
  data: Uint8Array
  method: number
  uncompressedSize: number
  flags?: number
}

/** `text` as a deflated zip file, claiming `declaredSize` (the true size by default). */
async function deflated(name: string, text: string, declaredSize?: number): Promise<ZipFile> {
  const bytes = encoder.encode(text)
  return {
    name,
    data: await deflate(bytes),
    method: 8,
    uncompressedSize: declaredSize ?? bytes.length,
  }
}

function stored(name: string, text: string): ZipFile {
  const data = encoder.encode(text)
  return { name, data, method: 0, uncompressedSize: data.length }
}

/** A zip of `files`, CRC-32 left 0 since the reader does not check it. */
function zip(files: ZipFile[], entryCount = files.length): Uint8Array {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const name = encoder.encode(file.name)
    const local = new Uint8Array(30 + name.length)
    const view = new DataView(local.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, file.flags ?? 0, true)
    view.setUint16(8, file.method, true)
    view.setUint32(18, file.data.length, true)
    view.setUint32(22, file.uncompressedSize, true)
    view.setUint16(26, name.length, true)
    local.set(name, 30)

    const header = new Uint8Array(46 + name.length)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x02014b50, true)
    headerView.setUint16(4, 20, true)
    headerView.setUint16(6, 20, true)
    headerView.setUint16(8, file.flags ?? 0, true)
    headerView.setUint16(10, file.method, true)
    headerView.setUint32(20, file.data.length, true)
    headerView.setUint32(24, file.uncompressedSize, true)
    headerView.setUint16(28, name.length, true)
    headerView.setUint32(42, offset, true)
    header.set(name, 46)

    parts.push(local, file.data)
    central.push(header)
    offset += local.length + file.data.length
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entryCount, true)
  endView.setUint16(10, entryCount, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const REGISTER = "My Budget as of 2026-01-31 10-00 - Register.csv"
const PLAN = "My Budget as of 2026-01-31 10-00 - Plan.csv"

async function refused(input: Uint8Array | string, code: string, options = {}) {
  const error = await assertRejects(
    () => parseYnab(input, { currency: "USD", ...options }),
    StatementError,
  )
  assertEquals(error.code, code)
  return error
}

Deno.test("a zip with two accounts, a transfer and a split reads into accounts, categories, entries and transfers", async () => {
  const csv = register([
    row("Checking", "01/05/2026", "Starting Balance", {
      group: "Inflow",
      category: "Ready to Assign",
      Inflow: "$1,000.00",
    }),
    row("Savings", "01/05/2026", "Starting Balance", {
      group: "Inflow",
      category: "Ready to Assign",
      Inflow: "$500.00",
    }),
    row("Checking", "01/10/2026", "Transfer : Savings", {
      Flag: "Red",
      Memo: "Rainy day",
      Outflow: "$200.00",
    }),
    row("Checking", "01/12/2026", "Grocer", {
      group: "Everyday",
      category: "Food",
      Memo: "Split (1/2) Bread",
      Outflow: "$3.50",
    }),
    row("Checking", "01/12/2026", "Grocer", {
      group: "Everyday",
      category: "Home",
      Memo: "Split (2/2) ",
      Outflow: "$10.00",
    }),
    row("Savings", "01/10/2026", "Transfer : Checking", { Memo: "Rainy day", Inflow: "$200.00" }),
    row("Checking", "01/20/2026", "Employer", {
      group: "Inflow",
      category: "Ready to Assign",
      Inflow: "$2,500.00",
    }),
  ])
  const file = zip([
    await deflated(PLAN, `"Month","Category Group/Category"\n"Jan 2026","Everyday: Food"`),
    await deflated(REGISTER, csv),
  ])
  const history = await parseYnab(file, { currency: "USD" })
  assertEquals(history, {
    accounts: [
      { name: "Checking", kind: "asset", currency: "USD" },
      { name: "Savings", kind: "asset", currency: "USD" },
    ],
    categories: [{ name: "Everyday: Food" }, { name: "Everyday: Home" }],
    entries: [
      {
        line: 2,
        date: "2026-01-05",
        description: "Starting Balance",
        tags: [],
        account: "Checking",
        amount: 100000,
        currency: "USD",
      },
      {
        line: 3,
        date: "2026-01-05",
        description: "Starting Balance",
        tags: [],
        account: "Savings",
        amount: 50000,
        currency: "USD",
      },
      {
        line: 5,
        date: "2026-01-12",
        description: "Grocer",
        tags: [],
        category: "Everyday: Food",
        notes: "Bread",
        groupId: "split:5",
        account: "Checking",
        amount: -350,
        currency: "USD",
        payee: "Grocer",
      },
      {
        line: 6,
        date: "2026-01-12",
        description: "Grocer",
        tags: [],
        category: "Everyday: Home",
        groupId: "split:5",
        account: "Checking",
        amount: -1000,
        currency: "USD",
        payee: "Grocer",
      },
      {
        line: 8,
        date: "2026-01-20",
        description: "Employer",
        tags: [],
        account: "Checking",
        amount: 250000,
        currency: "USD",
        payee: "Employer",
      },
    ],
    transfers: [{
      line: 4,
      date: "2026-01-10",
      description: "Transfer : Savings",
      tags: ["flag:red"],
      notes: "Rainy day",
      from: "Checking",
      to: "Savings",
      amount: 20000,
      currency: "USD",
    }],
    rowErrors: [],
  })
})

Deno.test("the transfer half where money arrives first still pairs, from the account it left", async () => {
  const csv = register([
    row("Savings", "2026-01-10", "Transfer : Checking", { Inflow: "$200.00" }),
    row("Checking", "2026-01-10", "Transfer : Savings", { Outflow: "$200.00" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(
    history.transfers.map(({ line, from, to, amount }) => ({ line, from, to, amount })),
    [{ line: 3, from: "Checking", to: "Savings", amount: 20000 }],
  )
})

Deno.test("transfer rows pair only with the same date and amount, and opposite sides", async () => {
  const csv = register([
    row("Checking", "2026-01-10", "Transfer : Savings", { Outflow: "$200.00" }),
    row("Savings", "2026-01-11", "Transfer : Checking", { Inflow: "$200.00" }),
    row("Savings", "2026-01-10", "Transfer : Checking", { Inflow: "$300.00" }),
    row("Savings", "2026-01-10", "Transfer : Checking", { Outflow: "$200.00" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(
    history.transfers.map(({ line, from, to, amount }) => ({ line, from, to, amount })),
    [
      { line: 2, from: "Checking", to: "Savings", amount: 20000 },
      { line: 3, from: "Checking", to: "Savings", amount: 20000 },
      { line: 4, from: "Checking", to: "Savings", amount: 30000 },
      { line: 5, from: "Savings", to: "Checking", amount: 20000 },
    ],
  )
})

Deno.test("a split part that is a transfer pairs with its other half and keeps the group id", async () => {
  const csv = register([
    row("Checking", "2026-01-12", "Grocer", {
      group: "Everyday",
      category: "Food",
      Memo: "Split (1/2) Bread",
      Outflow: "$3.50",
    }),
    row("Checking", "2026-01-12", "Transfer : Savings", {
      Memo: "Split (2/2) Change",
      Outflow: "$1.50",
    }),
    row("Savings", "2026-01-12", "Transfer : Checking", { Inflow: "$1.50" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.entries.map((entry) => entry.groupId), ["split:2"])
  assertEquals(history.transfers, [{
    line: 3,
    date: "2026-01-12",
    description: "Transfer : Savings",
    tags: [],
    notes: "Change",
    groupId: "split:2",
    from: "Checking",
    to: "Savings",
    amount: 150,
    currency: "USD",
  }])
})

Deno.test("split parts out of sequence or on another account or date share no group", async () => {
  const csv = register([
    row("Checking", "2026-01-12", "A", { Memo: "Split (2/2) starts at two" }),
    row("Checking", "2026-01-12", "A", { Memo: "Split (1/2) one" }),
    row("Savings", "2026-01-12", "A", { Memo: "Split (2/2) other account" }),
    row("Checking", "2026-01-12", "A", { Memo: "Split (1/2) one" }),
    row("Checking", "2026-01-13", "A", { Memo: "Split (2/2) other date" }),
    row("Checking", "2026-01-12", "A", { Memo: "Split (1/2) one" }),
    row("Checking", "2026-01-12", "A", { Memo: "Not a split" }),
    row("Checking", "2026-01-12", "A", { Memo: "Split (2/2) after a break" }),
    row("Checking", "2026-01-12", "A", { Memo: "Split (3/2) not a split" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(
    history.entries.map((entry) => [entry.groupId, entry.notes]),
    [
      [undefined, "starts at two"],
      ["split:3", "one"],
      [undefined, "other account"],
      ["split:5", "one"],
      [undefined, "other date"],
      ["split:7", "one"],
      [undefined, "Not a split"],
      [undefined, "after a break"],
      [undefined, "Split (3/2) not a split"],
    ],
  )
})

Deno.test("an unpaired transfer row stays a transfer, from or to the account it names", async () => {
  const csv = register([
    row("Checking", "2026-01-10", "Transfer : Closed card", { Outflow: "$40.00" }),
    row("Checking", "2026-01-11", "Transfer : Old savings", { Inflow: "$15.00" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(
    history.transfers.map(({ from, to, amount }) => ({ from, to, amount })),
    [
      { from: "Checking", to: "Closed card", amount: 4000 },
      { from: "Old savings", to: "Checking", amount: 1500 },
    ],
  )
  assertEquals(history.accounts.map((account) => account.name), [
    "Checking",
    "Closed card",
    "Old savings",
  ])
})

Deno.test("a starting balance has no payee and the inflow category is no category", async () => {
  const csv = register([
    row("Checking", "2026-01-05", "Starting Balance", {
      group: "Inflow",
      category: "Ready to Assign",
      Inflow: "$10.00",
    }),
    row("Checking", "2026-01-06", "Employer", {
      "Category Group/Category": "Inflow: To be Budgeted",
      Inflow: "$5.00",
    }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.categories, [])
  assertEquals(
    history.entries.map(({ payee, category, description }) => ({ payee, category, description })),
    [
      { payee: undefined, category: undefined, description: "Starting Balance" },
      { payee: "Employer", category: undefined, description: "Employer" },
    ],
  )
})

Deno.test("without the combined column the category is group and category, or category alone", async () => {
  const header = HEADER.filter((name) => name !== "Category Group/Category")
  const csv = register([
    { ...row("Checking", "2026-01-05", "A"), "Category Group": "Bills", Category: "Rent" },
    { ...row("Checking", "2026-01-06", "B"), Category: "Fun" },
  ], header)
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.entries.map((entry) => entry.category), ["Bills: Rent", "Fun"])
})

Deno.test("a row without a payee is described by its memo, and flags become tags", async () => {
  const csv = register([row("Checking", "2026-01-05", "", { Memo: "Cash", Flag: "Blue" })])
  const [entry] = (await parseYnab(csv, { currency: "USD" })).entries
  assertEquals([entry.description, entry.payee, entry.tags], ["Cash", undefined, ["flag:blue"]])
})

Deno.test("the register alone reads as a string or as bytes with a byte-order mark", async () => {
  const csv = register([row("Checking", "2026-01-05", "Café", { Outflow: "$1.00" })])
  for (
    const input of [csv, `﻿${csv}`, encoder.encode(`﻿${csv}`), encoder.encode(csv)]
  ) {
    const history = await parseYnab(input, { currency: "USD" })
    assertEquals(history.entries.map((entry) => [entry.payee, entry.amount]), [["Café", -100]])
  }
})

Deno.test("a stored register in a zip reads too", async () => {
  const csv = register([row("Checking", "2026-01-05", "A", { Outflow: "$1.00" })])
  const history = await parseYnab(zip([stored(REGISTER, csv)]), { currency: "USD" })
  assertEquals(history.entries.map((entry) => entry.amount), [-100])
})

Deno.test("amounts read in the budget's currency format, in minor units", async () => {
  const cases: [string, string, string, number][] = [
    ["EUR", "1.234,56€", "", -123456],
    ["EUR", "", "1.234.567,8 €", 123456780],
    ["EUR", "€0,05", "€0,00", -5],
    ["USD", "$1,234", "", -123400],
    ["USD", "-$5.00", "", 500],
    ["USD", "($5.00)", "", 500],
    ["USD", "", "1 234.56 $", 123456],
    ["DKK", "kr. 1.234,50", "", -123450],
    ["CHF", "CHF 1'234.50", "", -123450],
    ["JPY", "¥1,234", "", -1234],
    ["JPY", "", "1.234 ¥", 1234],
    ["KWD", "1,234.567 KD", "", -1234567],
    ["USD", "$10.00", "$10.00", 0],
    ["USD", "", "", 0],
  ]
  for (const [currency, outflow, inflow, amount] of cases) {
    const csv = register([row("A", "2026-01-05", "P", { Outflow: outflow, Inflow: inflow })])
    const history = await parseYnab(csv, { currency })
    assertEquals(history.rowErrors, [], `${outflow} / ${inflow}`)
    assertEquals(history.entries[0].amount, amount, `${currency} ${outflow} / ${inflow}`)
    assertEquals(Object.is(history.entries[0].amount, -0), false)
  }
})

Deno.test("an amount that does not read is a row error with its line", async () => {
  const csv = register([
    row("A", "2026-01-05", "P", { Outflow: "abc" }),
    row("A", "2026-01-05", "P", { Inflow: "$1.2.3" }),
    row("A", "2026-01-05", "P", { Outflow: "$12,34.00" }),
    row("A", "2026-01-05", "P", { Outflow: "$1.00" }),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.rowErrors, [
    { line: 2, reason: `outflow "abc" is not an amount` },
    { line: 3, reason: `inflow "$1.2.3" is not an amount` },
    { line: 4, reason: `outflow "$12,34.00" is not an amount` },
  ])
  assertEquals(history.entries.map((entry) => entry.line), [5])
})

Deno.test("the date order is read from the file: four digits first, a day over 12, a month second", async () => {
  const cases: [string[], string[]][] = [
    [["2026/12/30", "2026.01.02"], ["2026-12-30", "2026-01-02"]],
    [["30.12.2026", "01.02.2026"], ["2026-12-30", "2026-02-01"]],
    [["12/30/2026", "01/02/2026"], ["2026-12-30", "2026-01-02"]],
    [["30-12-2026", "1-2-2026"], ["2026-12-30", "2026-02-01"]],
  ]
  for (const [dates, expected] of cases) {
    const csv = register(dates.map((date) => row("A", date, "P")))
    const history = await parseYnab(csv, { currency: "USD" })
    assertEquals(history.entries.map((entry) => entry.date), expected, dates.join(" "))
  }
})

Deno.test("dates that never tell day from month are refused unless dateOrder is passed", async () => {
  const csv = register([row("A", "01/02/2026", "P"), row("A", "03/04/2026", "P")])
  const error = await refused(csv, "malformed")
  assertEquals(error.message, "no date tells day-first from month-first; pass dateOrder")
  for (const [dateOrder, date] of [["dmy", "2026-02-01"], ["mdy", "2026-01-02"]]) {
    const history = await parseYnab(csv, { currency: "USD", dateOrder: dateOrder as "dmy" })
    assertEquals(history.entries[0].date, date)
  }
})

Deno.test("dates that are both day-first and month-first are refused", async () => {
  const csv = register([row("A", "30/01/2026", "P"), row("A", "01/30/2026", "P")])
  const error = await refused(csv, "malformed")
  assertEquals(error.message, "dates are day-first and month-first; pass dateOrder")
})

Deno.test("a bad date or a row without an account is a row error with its line", async () => {
  const csv = register([
    row("A", "02/30/2026", "P"),
    row("A", "12/31/2026", "P"),
    row("A", "yesterday", "P"),
    row("A", "2026-12-31", "P"),
    row("", "12/31/2026", "P"),
  ])
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.rowErrors, [
    { line: 2, reason: `date "02/30/2026" is not mdy order` },
    { line: 4, reason: `date "yesterday" is not mdy order` },
    { line: 5, reason: `date "2026-12-31" is not mdy order` },
    { line: 6, reason: "no account" },
  ])
  assertEquals(history.entries.map((entry) => entry.date), ["2026-12-31"])
})

Deno.test("columns in another order, in another case, and extra ones, read the same", async () => {
  const header = ["extra", ...HEADER.map((name) => name.toUpperCase()).reverse()]
  const source = row("A", "2026-01-05", "P", { Outflow: "$1.00", group: "G", category: "C" })
  const upper = Object.fromEntries(
    Object.entries(source).map(([name, value]) => [name.toUpperCase(), value]),
  )
  const history = await parseYnab(register([{ ...upper, extra: "x" }], header), {
    currency: "USD",
  })
  assertEquals(history.entries.map((entry) => [entry.amount, entry.category]), [[-100, "G: C"]])
})

Deno.test("a register without a required column is refused whole, naming what is missing", async () => {
  const header = HEADER.filter((name) => name !== "Payee" && name !== "Inflow")
  const error = await refused(register([], header), "malformed")
  assertEquals(error.message, "not a YNAB register: no payee, inflow")
})

Deno.test("an empty file or a header that does not read is refused whole", async () => {
  await refused("", "malformed")
  await refused(`"Account,Date`, "malformed")
})

Deno.test("a row whose CSV does not read is a row error, and a cell over 10,000 characters too", async () => {
  const csv = register([row("A", "2026-01-05", "x".repeat(10_001))]) + `\r\n"A","x"y"`
  const history = await parseYnab(csv, { currency: "USD" })
  assertEquals(history.rowErrors.map((error) => error.line), [2, 3])
})

Deno.test("a currency that is not ISO 4217 is refused before reading", async () => {
  for (const currency of ["", "usd", "XYZ"]) {
    await assertRejects(() => parseYnab("", { currency }), RangeError, "ISO 4217")
  }
})

Deno.test("a file over maxBytes is refused whole, as text, as bytes and as a zip", async () => {
  const csv = register([row("A", "2026-01-05", "P")])
  await refused(csv, "too-large", { maxBytes: 100 })
  await refused(encoder.encode(csv), "too-large", { maxBytes: 100 })
  const file = zip([stored(REGISTER, csv)])
  await refused(file, "too-large", { maxBytes: file.length - 1 })
})

Deno.test("a file over maxRows is refused whole", async () => {
  const csv = register([row("A", "2026-01-05", "P"), row("A", "2026-01-05", "P")])
  await refused(csv, "too-large", { maxRows: 1 })
})

Deno.test("a register that declares more than maxBytes is refused before it is inflated", async () => {
  // Not deflate at all: inflating it would fail as malformed, so too-large shows it never ran.
  const file = zip([{
    name: REGISTER,
    data: new Uint8Array([0xff, 0xff, 0xff]),
    method: 8,
    uncompressedSize: 2_000,
  }])
  await refused(file, "too-large", { maxBytes: 1_000 })
})

Deno.test("a register that inflates past maxBytes is refused whole, though its header claims less", async () => {
  const rows = Array.from({ length: 2_000 }, () => row("A", "2026-01-05", "P"))
  const file = zip([await deflated(REGISTER, register(rows), 100)])
  const error = await refused(file, "too-large", { maxBytes: 10_000 })
  assertEquals(error.message, `zip entry "${REGISTER}" inflates past its declared 100 bytes`)
})

Deno.test("a zip without a register is refused whole", async () => {
  await refused(zip([await deflated(PLAN, "a,b")]), "malformed")
  await refused(zip([]), "malformed")
})

Deno.test("a zip entry in another compression method, or encrypted, is refused whole", async () => {
  const csv = register([row("A", "2026-01-05", "P")])
  const bzip = { ...stored(REGISTER, csv), method: 12 }
  const error = await refused(zip([bzip]), "malformed")
  assertEquals(error.message.includes("compression method 12"), true)
  const locked = { ...stored(REGISTER, csv), flags: 1 }
  assertEquals((await refused(zip([locked]), "malformed")).message.includes("encrypted"), true)
})

Deno.test("a zip listing more than 1,000 entries is refused whole", async () => {
  const files = Array.from({ length: 1_001 }, (_, index) => stored(`${index}.txt`, ""))
  await refused(zip(files), "too-large")
})

Deno.test("a broken zip is refused whole as malformed", async () => {
  const csv = register([row("A", "2026-01-05", "P")])
  const good = zip([stored(REGISTER, csv)])
  // Cut before the end record.
  await refused(good.subarray(0, good.length - 22), "malformed")
  // An end record that claims zip64.
  await refused(zip([stored(REGISTER, csv)], 0xffff), "malformed")
  // A central directory that lists one entry more than it holds.
  await refused(zip([stored(REGISTER, csv)], 2), "malformed")
  // Data that does not inflate.
  const garbage = {
    name: REGISTER,
    data: new Uint8Array([0xff, 0xff]),
    method: 8,
    uncompressedSize: 9,
  }
  await refused(zip([garbage]), "malformed")
})
