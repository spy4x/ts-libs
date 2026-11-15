import { assertEquals, assertRejects } from "@std/assert"
import initSqlJs from "sql.js/dist/sql-wasm-inline.js"
import { parseActualBudget } from "./app-exports.ts"
import { StatementError } from "./statement.ts"

/** Actual Budget's tables, cut to the columns the reader uses and a few it does not. */
const SCHEMA = `
  CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT, offbudget INTEGER DEFAULT 0,
    closed INTEGER DEFAULT 0, sort_order REAL, tombstone INTEGER DEFAULT 0);
  CREATE TABLE payees (id TEXT PRIMARY KEY, name TEXT, category TEXT,
    tombstone INTEGER DEFAULT 0, transfer_acct TEXT);
  CREATE TABLE payee_mapping (id TEXT PRIMARY KEY, targetId TEXT);
  CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, is_income INTEGER DEFAULT 0,
    cat_group TEXT, sort_order REAL, tombstone INTEGER DEFAULT 0);
  CREATE TABLE category_groups (id TEXT PRIMARY KEY, name TEXT, is_income INTEGER DEFAULT 0,
    sort_order REAL, tombstone INTEGER DEFAULT 0);
  CREATE TABLE category_mapping (id TEXT PRIMARY KEY, transferId TEXT);
  CREATE TABLE transactions (id TEXT PRIMARY KEY, isParent INTEGER DEFAULT 0,
    isChild INTEGER DEFAULT 0, acct TEXT, category TEXT, amount INTEGER, description TEXT,
    notes TEXT, date INTEGER, starting_balance_flag INTEGER DEFAULT 0, transferred_id TEXT,
    sort_order REAL, tombstone INTEGER DEFAULT 0, parent_id TEXT);
  CREATE TABLE preferences (id TEXT PRIMARY KEY, value TEXT);
`

/**
 * A synthetic budget in EUR: Checking and an off-budget Savings, a deleted account, a rent
 * payment, a split shop whose second part uses a merged payee and a merged category, a transfer
 * from Checking to Savings, and a deleted transaction.
 */
const BUDGET = `
  INSERT INTO preferences VALUES ('defaultCurrencyCode', 'EUR');
  INSERT INTO accounts (id, name, offbudget, sort_order, tombstone) VALUES
    ('a1', 'Checking', 0, 1, 0), ('a2', 'Savings', 1, 2, 0), ('a3', 'Old card', 0, 3, 1);
  INSERT INTO category_groups (id, name, sort_order) VALUES ('g1', 'Food', 1), ('g2', 'Home', 2);
  INSERT INTO categories (id, name, cat_group, sort_order, tombstone) VALUES
    ('c1', 'Groceries', 'g1', 1, 0), ('c2', 'Restaurants', 'g1', 2, 0), ('c3', 'Rent', 'g2', 3, 0),
    ('c4', 'Dining', 'g1', 4, 1);
  INSERT INTO category_mapping VALUES ('c1', 'c1'), ('c2', 'c2'), ('c3', 'c3'), ('c4', 'c2');
  INSERT INTO payees (id, name, transfer_acct, tombstone) VALUES
    ('p1', 'Market', NULL, 0), ('p2', 'Landlord', NULL, 0), ('p3', 'Old Market', NULL, 1),
    ('pt1', '', 'a2', 0), ('pt2', '', 'a1', 0);
  INSERT INTO payee_mapping VALUES ('p1', 'p1'), ('p2', 'p2'), ('p3', 'p1'), ('pt1', 'pt1'),
    ('pt2', 'pt2');
  INSERT INTO transactions
    (id, isParent, isChild, acct, category, amount, description, notes, date, parent_id,
     transferred_id, tombstone) VALUES
    ('t1', 0, 0, 'a1', 'c3', -150000, 'p2', 'March', 20240301, NULL, NULL, 0),
    ('t2', 1, 0, 'a1', NULL, -5000, 'p1', NULL, 20240302, NULL, NULL, 0),
    ('t2/1', 0, 1, 'a1', 'c1', -3000, 'p1', NULL, 20240302, 't2', NULL, 0),
    ('t2/2', 0, 1, 'a1', 'c4', -2000, 'p3', 'lunch', 20240302, 't2', NULL, 0),
    ('t3', 0, 0, 'a1', NULL, -10000, 'pt1', 'monthly saving', 20240303, NULL, 't4', 0),
    ('t4', 0, 0, 'a2', NULL, 10000, 'pt2', NULL, 20240303, NULL, 't3', 0),
    ('t5', 0, 0, 'a1', 'c1', -999, 'p1', NULL, 20240304, NULL, NULL, 1);
`

const SQL = await initSqlJs()

/** The bytes of a SQLite database built from `sql`, after the schema unless `schema` replaces it. */
function database(sql: string, schema = SCHEMA): Uint8Array {
  const db = new SQL.Database()
  try {
    db.run(schema + sql)
    return db.export()
  } finally {
    db.close()
  }
}

/** One file in a test zip, with what its records may claim about it. */
interface ZipFile {
  name: string
  data: Uint8Array
  /** 8 deflates the data, anything else stores it under that method number. Default 8. */
  method?: number
  flags?: number
  /** The uncompressed size the records claim. Default the real size. */
  declaredSize?: number
}

/** A zip archive of `files`, as Actual's exporter writes one. The checksums are left 0. */
async function zipOf(files: ZipFile[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const file of files) {
    const method = file.method ?? 8
    const data = method === 8
      ? new Uint8Array(
        await new Response(
          new Blob([file.data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(
            new CompressionStream("deflate-raw"),
          ),
        ).arrayBuffer(),
      )
      : file.data
    const name = new TextEncoder().encode(file.name)
    const size = file.declaredSize ?? file.data.length
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(6, file.flags ?? 0, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(8, file.flags ?? 0, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)
    parts.push(local, data)
    directory.push(central)
    offset += local.length + data.length
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...directory, end]
  const zip = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    zip.set(part, at)
    at += part.length
  }
  return zip
}

/** An Actual export of the database built from `sql`, with its metadata. */
function exportOf(sql: string, method = 8, schema = SCHEMA): Promise<Uint8Array> {
  return zipOf([
    { name: "metadata.json", data: new TextEncoder().encode(`{"budgetName":"Test"}`), method },
    { name: "db.sqlite", data: database(sql, schema), method },
  ])
}

/** Asserts that reading `zip` is refused with `code`, and returns the error. */
async function refused(
  zip: Uint8Array | Promise<Uint8Array>,
  code: string,
  options: Parameters<typeof parseActualBudget>[1] = {},
): Promise<StatementError> {
  const bytes = await zip
  const error = await assertRejects(() => parseActualBudget(bytes, options), StatementError)
  assertEquals(error.code, code)
  return error
}

Deno.test("an export with two accounts, a transfer and a split reads into accounts, categories, entries and transfers", async () => {
  const history = await parseActualBudget(await exportOf(BUDGET))
  assertEquals(history.rowErrors, [])
  assertEquals(history.accounts, [
    { name: "Checking", kind: "asset", currency: "EUR" },
    { name: "Savings", kind: "asset", currency: "EUR" },
  ])
  assertEquals(history.categories, [
    { name: "Groceries", group: "Food" },
    { name: "Restaurants", group: "Food" },
    { name: "Rent", group: "Home" },
  ])
  assertEquals(history.entries, [
    {
      line: 1,
      date: "2024-03-01",
      description: "Landlord",
      tags: [],
      sourceId: "t1",
      category: "Rent",
      notes: "March",
      account: "Checking",
      amount: -150000,
      currency: "EUR",
      payee: "Landlord",
    },
    {
      line: 3,
      date: "2024-03-02",
      description: "Market",
      tags: [],
      sourceId: "t2/1",
      category: "Groceries",
      groupId: "t2",
      account: "Checking",
      amount: -3000,
      currency: "EUR",
      payee: "Market",
    },
    {
      line: 4,
      date: "2024-03-02",
      description: "Market",
      tags: [],
      sourceId: "t2/2",
      category: "Restaurants",
      notes: "lunch",
      groupId: "t2",
      account: "Checking",
      amount: -2000,
      currency: "EUR",
      payee: "Market",
    },
  ])
  assertEquals(history.transfers, [{
    line: 5,
    date: "2024-03-03",
    description: "",
    tags: [],
    sourceId: "t3",
    notes: "monthly saving",
    from: "Checking",
    to: "Savings",
    amount: 10000,
    currency: "EUR",
  }])
})

Deno.test("a stored zip reads the same as a deflated one", async () => {
  assertEquals(
    await parseActualBudget(await exportOf(BUDGET, 0)),
    await parseActualBudget(await exportOf(BUDGET)),
  )
})

Deno.test("deleted rows are skipped: transactions, accounts, categories, payees and split parts", async () => {
  const history = await parseActualBudget(
    await exportOf(
      BUDGET + `
      UPDATE category_groups SET tombstone = 1 WHERE id = 'g2';
      INSERT INTO transactions (id, isParent, acct, amount, description, date, tombstone)
        VALUES ('t6', 1, 'a1', -100, 'p1', 20240305, 1);
      INSERT INTO transactions (id, isChild, acct, amount, description, date, parent_id)
        VALUES ('t6/1', 1, 'a1', -100, 'p1', 20240305, 't6');
      INSERT INTO transactions (id, acct, amount, description, date)
        VALUES ('t7', 'a1', -100, 'p3', 20240306);
      UPDATE payee_mapping SET targetId = 'p3' WHERE id = 'p3';
    `,
    ),
  )
  assertEquals(history.accounts.map(({ name }) => name), ["Checking", "Savings"])
  assertEquals(history.categories.at(-1), { name: "Rent" })
  assertEquals(history.entries.map(({ sourceId }) => sourceId), ["t1", "t2/1", "t2/2", "t7"])
  // t7's payee is deleted and no longer merged, so it has none.
  assertEquals(history.entries.at(-1)?.payee, undefined)
  assertEquals(history.entries.at(-1)?.description, "")
})

Deno.test("a merged payee and a merged category read as the ones they were merged into", async () => {
  const history = await parseActualBudget(await exportOf(BUDGET))
  const merged = history.entries.find(({ sourceId }) => sourceId === "t2/2")
  assertEquals([merged?.payee, merged?.category], ["Market", "Restaurants"])
  assertEquals(history.categories.some(({ name }) => name === "Dining"), false)
})

Deno.test("a transfer whose other side is deleted is an entry paid to the other account", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + "UPDATE transactions SET tombstone = 1 WHERE id = 't4';"),
  )
  assertEquals(history.transfers, [])
  const entry = history.entries.find(({ sourceId }) => sourceId === "t3")
  assertEquals([entry?.amount, entry?.payee, entry?.description], [-10000, "Savings", "Savings"])
})

Deno.test("a transfer whose other side does not link back is an entry", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + "UPDATE transactions SET transferred_id = NULL WHERE id = 't4';"),
  )
  assertEquals(history.transfers, [])
  assertEquals(
    history.entries.filter(({ sourceId }) => sourceId === "t3" || sourceId === "t4").map((
      { account, amount },
    ) => [account, amount]),
    [["Checking", -10000], ["Savings", 10000]],
  )
})

Deno.test("a transfer is written once, from the side the money left, whichever side comes first", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + "UPDATE transactions SET date = 20240310 WHERE id = 't3';"),
  )
  assertEquals(
    history.transfers.map(({ sourceId, from, to, amount, line }) => ({
      sourceId,
      from,
      to,
      amount,
      line,
    })),
    [{ sourceId: "t3", from: "Checking", to: "Savings", amount: 10000, line: 6 }],
  )
})

Deno.test("a zero transfer is written once, as 0", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + "UPDATE transactions SET amount = 0 WHERE id IN ('t3', 't4');"),
  )
  assertEquals(history.transfers.map(({ sourceId, amount }) => [sourceId, amount]), [["t3", 0]])
  assertEquals(Object.is(history.transfers[0].amount, -0), false)
})

Deno.test("the currency option is used when the budget names none, and wins over the budget's", async () => {
  const none = await exportOf(BUDGET.replace("'EUR'", "''"))
  await refused(none, "unsupported")
  assertEquals((await parseActualBudget(none, { currency: "USD" })).entries[0].currency, "USD")
  const eur = await exportOf(BUDGET)
  assertEquals((await parseActualBudget(eur, { currency: "GBP" })).accounts[0].currency, "GBP")
})

Deno.test("a budget made before the preferences table reads with the currency option", async () => {
  const schema = SCHEMA.replace("CREATE TABLE preferences (id TEXT PRIMARY KEY, value TEXT);", "")
  const zip = await exportOf(BUDGET.split("\n").slice(2).join("\n"), 8, schema)
  await refused(zip, "unsupported")
  assertEquals((await parseActualBudget(zip, { currency: "EUR" })).entries.length, 3)
})

Deno.test("a currency option that is not an ISO 4217 code throws a RangeError", async () => {
  const zip = await exportOf(BUDGET)
  await assertRejects(() => parseActualBudget(zip, { currency: "EURO" }), RangeError)
})

Deno.test("hundredths become yen by dividing, and a yen fraction is a row error", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + "UPDATE transactions SET amount = -150050 WHERE id = 't2/1';"),
    { currency: "JPY" },
  )
  assertEquals(history.entries.map(({ amount }) => amount), [-1500, -20])
  assertEquals(history.transfers[0].amount, 100)
  assertEquals(history.rowErrors, [{
    line: 3,
    reason: "amount -1500.5 has a fraction JPY does not have",
  }])
})

Deno.test("hundredths become fils of a three-decimal currency by multiplying, unless that overflows", async () => {
  const history = await parseActualBudget(
    await exportOf(BUDGET + `UPDATE transactions SET amount = ${2 ** 53 - 1} WHERE id = 't1';`),
    { currency: "KWD" },
  )
  assertEquals(history.entries.map(({ amount }) => amount), [-30000, -20000])
  assertEquals(history.rowErrors, [{ line: 1, reason: `amount ${2 ** 53 - 1} is too large` }])
})

Deno.test("a bad or overlong date, a non-integer amount and an unknown account are row errors", async () => {
  const history = await parseActualBudget(
    await exportOf(
      BUDGET + `
      UPDATE transactions SET date = 20240231 WHERE id = 't1';
      UPDATE transactions SET amount = 12.5 WHERE id = 't2/1';
      UPDATE transactions SET acct = 'a3' WHERE id = 't2/2';
      INSERT INTO transactions (id, acct, amount, description, date)
        VALUES ('t8', 'a1', -100, 'p1', 202403011);
    `,
    ),
  )
  assertEquals(history.rowErrors, [
    { line: 1, reason: `date "20240231" is not YYYYMMDD` },
    { line: 3, reason: `amount "12.5" is not a whole number of hundredths` },
    { line: 4, reason: `account "a3" is not in the budget` },
    { line: 7, reason: `date "202403011" is not YYYYMMDD` },
  ])
  assertEquals(history.transfers.length, 1)
})

Deno.test("a note over 10,000 characters is a row error, and one at 10,000 reads", async () => {
  const history = await parseActualBudget(
    await exportOf(
      BUDGET + `
      UPDATE transactions SET notes = '${"x".repeat(10_001)}' WHERE id = 't1';
      UPDATE transactions SET notes = '${"x".repeat(10_000)}' WHERE id = 't2/1';
    `,
    ),
  )
  assertEquals(history.rowErrors, [{ line: 1, reason: "a name or note is over 10000 characters" }])
  assertEquals(history.entries[0].notes?.length, 10_000)
})

Deno.test("an account or category named with over 10,000 characters is left out, and its rows are row errors", async () => {
  const long = "x".repeat(10_001)
  const history = await parseActualBudget(
    await exportOf(
      BUDGET + `
      UPDATE accounts SET name = '${long}' WHERE id = 'a2';
      UPDATE categories SET name = '${long}' WHERE id = 'c3';
    `,
    ),
  )
  assertEquals(history.accounts.map(({ name }) => name), ["Checking"])
  assertEquals(history.categories.map(({ name }) => name), ["Groceries", "Restaurants"])
  assertEquals(history.transfers, [])
  assertEquals(history.rowErrors.map(({ line }) => line), [1, 5, 6])
})

Deno.test("a file that is not a zip is refused whole", async () => {
  for (const bytes of [new TextEncoder().encode("date,amount\n2024-03-01,1\n"), new Uint8Array()]) {
    assertEquals(
      (await refused(bytes, "malformed")).message,
      "not a zip archive: no end of central directory",
    )
  }
})

Deno.test("a zip without db.sqlite is refused whole", async () => {
  const zip = zipOf([{ name: "metadata.json", data: new TextEncoder().encode("{}") }])
  const error = await refused(zip, "malformed")
  assertEquals(error.message, "not an Actual Budget export: no db.sqlite")
})

Deno.test("a db.sqlite that is not SQLite is refused whole", async () => {
  const zip = zipOf([{
    name: "db.sqlite",
    data: new TextEncoder().encode("SQLite format 2\0 and more"),
  }])
  assertEquals((await refused(zip, "malformed")).message, "db.sqlite is not a SQLite database")
})

Deno.test("a db.sqlite with SQLite's header and broken pages is refused whole", async () => {
  const data = new Uint8Array(4096).fill(0xff)
  data.set(new TextEncoder().encode("SQLite format 3\0"))
  const zip = zipOf([{ name: "db.sqlite", data }])
  assertEquals(
    (await refused(zip, "malformed")).message,
    "db.sqlite is not an Actual Budget database",
  )
})

Deno.test("a SQLite database without Actual's tables is refused whole", async () => {
  const zip = exportOf("", 8, "CREATE TABLE notes (id TEXT);")
  assertEquals(
    (await refused(zip, "malformed")).message,
    "not an Actual Budget database: no accounts table",
  )
})

Deno.test("a table that is a view or computes a column is refused before it is read", async () => {
  const view = SCHEMA.replace(
    "CREATE TABLE payee_mapping (id TEXT PRIMARY KEY, targetId TEXT);",
    "CREATE VIEW payee_mapping AS SELECT id, id AS targetId FROM payees;",
  )
  assertEquals(
    (await refused(exportOf("", 8, view), "unsupported")).message,
    "payee_mapping is not a plain table",
  )
  const generated = SCHEMA.replace(
    "CREATE TABLE payee_mapping (id TEXT PRIMARY KEY, targetId TEXT);",
    "CREATE TABLE payee_mapping (id TEXT PRIMARY KEY, targetId TEXT AS (zeroblob(1000)));",
  )
  assertEquals(
    (await refused(exportOf("", 8, generated), "unsupported")).message,
    "payee_mapping has a generated column",
  )
})

Deno.test("an encrypted db.sqlite is refused whole", async () => {
  const zip = zipOf([{ name: "db.sqlite", data: database(BUDGET), flags: 1 }])
  assertEquals((await refused(zip, "unsupported")).message, `zip: "db.sqlite" is encrypted`)
})

Deno.test("a compression method other than stored and deflate is refused whole", async () => {
  const zip = zipOf([{ name: "db.sqlite", data: database(BUDGET), method: 12 }])
  assertEquals(
    (await refused(zip, "unsupported")).message,
    `zip: "db.sqlite" uses compression method 12`,
  )
})

Deno.test("a zip64 or multi-disk archive is refused whole", async () => {
  const zip = await exportOf(BUDGET)
  const zip64 = zip.slice()
  new DataView(zip64.buffer).setUint16(zip64.length - 14, 0xffff, true)
  new DataView(zip64.buffer).setUint16(zip64.length - 12, 0xffff, true)
  assertEquals((await refused(zip64, "unsupported")).message, "zip: zip64 archives are not read")
  const locator = zip.slice()
  new DataView(locator.buffer).setUint32(locator.length - 42, 0x07064b50, true)
  assertEquals((await refused(locator, "unsupported")).message, "zip: zip64 archives are not read")
  const disks = zip.slice()
  new DataView(disks.buffer).setUint16(disks.length - 18, 1, true)
  assertEquals(
    (await refused(disks, "unsupported")).message,
    "zip: archives on several disks are not read",
  )
})

Deno.test("a zip whose records point outside it or hold broken data is refused whole", async () => {
  const data = database(BUDGET)
  const stored = await zipOf([{ name: "db.sqlite", data, method: 0 }])
  const deflated = await zipOf([{ name: "db.sqlite", data }])
  /** `zip` with the 32-bit field at `at` set to `value`. */
  const patched = (zip: Uint8Array, at: number, value: number) => {
    const copy = zip.slice()
    new DataView(copy.buffer).setUint32(at, value, true)
    return copy
  }
  // Each zip holds one entry: its local header at 0, its data at 39, the directory after it.
  const directory = (zip: Uint8Array) => new DataView(zip.buffer).getUint32(zip.length - 6, true)
  const cases: [Uint8Array, string][] = [
    [patched(stored, stored.length - 6, stored.length), "the central directory runs past its end"],
    [patched(stored, directory(stored), 0), "a central directory entry is broken"],
    [patched(stored, directory(stored) + 42, 1000), `the local header of "db.sqlite" is broken`],
    [patched(deflated, directory(deflated) + 20, 1 << 30), `"db.sqlite" runs past its end`],
    [
      patched(stored, directory(stored) + 24, data.length - 1),
      `"db.sqlite" is stored with two sizes`,
    ],
    [patched(deflated, 39, 0xffffffff), `"db.sqlite" does not inflate`],
  ]
  for (const [zip, message] of cases) {
    assertEquals((await refused(zip, "malformed")).message, `not a zip archive: ${message}`)
  }
})

Deno.test("a database whose tables lack a column Actual has is refused whole", async () => {
  const schema = SCHEMA.replace("closed INTEGER DEFAULT 0, sort_order REAL,", "")
  assertEquals(
    (await refused(exportOf("", 8, schema), "malformed", { currency: "EUR" })).message,
    "db.sqlite is not an Actual Budget database",
  )
})

Deno.test("a zip over maxBytes is refused whole", async () => {
  const zip = await exportOf(BUDGET)
  await refused(zip, "too-large", { maxBytes: zip.length - 1 })
  assertEquals((await parseActualBudget(zip, { maxBytes: zip.length })).entries.length, 3)
})

Deno.test("a db.sqlite that declares more than maxDatabaseBytes is refused before it inflates", async () => {
  const data = database(BUDGET)
  const zip = await zipOf([{ name: "db.sqlite", data }])
  await refused(zip, "too-large", { maxDatabaseBytes: data.length - 1 })
  assertEquals((await parseActualBudget(zip, { maxDatabaseBytes: data.length })).entries.length, 3)
})

Deno.test("a db.sqlite that inflates past its declared size stops at that size", async () => {
  // 64 MiB of zeros deflate to about 64 KiB; the records claim 1 KiB.
  const zip = await zipOf([{
    name: "db.sqlite",
    data: new Uint8Array(64 << 20),
    declaredSize: 1024,
  }])
  const error = await refused(zip, "malformed", { maxDatabaseBytes: 2048 })
  assertEquals(
    error.message,
    `not a zip archive: "db.sqlite" inflates past its declared 1024 bytes`,
  )
})

Deno.test("a db.sqlite that inflates short of its declared size is refused whole", async () => {
  const data = database(BUDGET)
  const zip = await zipOf([{ name: "db.sqlite", data, declaredSize: data.length + 1 }])
  await refused(zip, "malformed")
})

Deno.test("more live transactions than maxRows are refused whole, and deleted ones do not count", async () => {
  const zip = await exportOf(BUDGET)
  // Six live transactions, the split's parent among them, and one deleted.
  await refused(zip, "too-large", { maxRows: 5 })
  assertEquals((await parseActualBudget(zip, { maxRows: 6 })).entries.length, 3)
})

Deno.test("the main entry imports no sql.js and no Actual Budget reader, and app-exports loads sql.js only when called", async () => {
  const seen = new Set<string>()
  const visit = async (url: URL) => {
    if (seen.has(url.href)) return
    seen.add(url.href)
    const source = await Deno.readTextFile(url)
    for (const [, specifier] of source.matchAll(/^(?:import|export)\b[^"]*?\bfrom "([^"]+)"/gm)) {
      if (specifier.startsWith(".")) await visit(new URL(specifier, url))
      else seen.add(specifier)
    }
  }
  await visit(new URL("./mod.ts", import.meta.url))
  assertEquals([...seen].filter((name) => /sql\.js|actual-budget|zip\.ts/.test(name)), [])
  seen.clear()
  await visit(new URL("./app-exports.ts", import.meta.url))
  assertEquals(seen.has(new URL("./actual-budget.ts", import.meta.url).href), true)
  assertEquals([...seen].filter((name) => name.startsWith("sql.js")), [])
})
