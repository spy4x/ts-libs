import { expect } from "@std/expect"
import { type } from "arktype"
import { describe, it } from "@std/testing/bdd"
import { type StatementProfile, statementProfile, verifyStatement } from "./mod.ts"
import { extractPdfLines, NO_TEXT_LAYER_MESSAGE, parsePdfStatement, type PdfPage } from "./pdf.ts"
import { type OpenPdf, type PdfDocument, readPdfLines } from "./pdf-read.ts"
import { definePDFJSModule } from "unpdf"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const bytes = (name: string) => Deno.readFile(new URL(name, FIXTURES))

/** The pages of `name`, failing the test when the fixture is refused. */
async function pages(name: string, change?: [string, string]): Promise<PdfPage[]> {
  let data = await bytes(name)
  if (change) {
    const source = new TextDecoder().decode(data)
    if (!source.includes(change[0])) throw new Error(`${name} has no ${change[0]}`)
    data = new TextEncoder().encode(source.replace(change[0], change[1]))
  }
  const read = await extractPdfLines(data)
  if (!read.ok) throw new Error(`${name} was refused: ${read.error.message}`)
  return read.value
}

const base: StatementProfile = {
  id: "019a6000-0000-7000-8000-0000000000f1",
  name: "Example Bank, PDF statement",
  encoding: "utf-8",
  delimiter: ",",
  headerLine: 1,
  date: { column: 0, pattern: "DD.MM.YYYY" },
  amount: { column: 2 },
  numberFormat: { decimal: ".", group: "," },
  currency: { code: "EUR" },
  description: 1,
  balance: 3,
  fingerprint: { headers: [], columns: 4, delimiter: "," },
}

const byColumns: StatementProfile = {
  ...base,
  pdf: {
    columns: [{ from: 0, to: 120 }, { from: 120, to: 340 }, { from: 340, to: 440 }, {
      from: 440,
      to: 600,
    }],
  },
}

const byPattern: StatementProfile = {
  ...base,
  pdf: { pattern: [{ type: "date" }, { type: "text" }, { type: "amount" }, { type: "amount" }] },
}

/** A fake pdf.js document with `numPages` pages, each holding `items`, that records its use. */
function fakeOpener(
  numPages: number,
  items: { str: string; transform: number[]; width: number }[] = [],
) {
  const seen = { pagesRead: 0, opened: 0, destroyed: 0 }
  const open: OpenPdf = () => {
    seen.opened++
    const document: PdfDocument = {
      numPages,
      getPage: () => {
        seen.pagesRead++
        return Promise.resolve({
          streamTextContent: () =>
            new ReadableStream({
              start(controller) {
                controller.enqueue({ items })
                controller.close()
              },
            }),
        })
      },
      loadingTask: { destroy: () => Promise.resolve(void seen.destroyed++) },
    }
    return Promise.resolve(document)
  }
  return { open, seen }
}

const item = (str: string, x: number, y: number) => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width: str.length * 5,
})

/** One page with one line of `words`, 50 points apart, as `extractPdfLines` would group it. */
const handPage = (words: string[]): PdfPage => ({
  page: 1,
  lines: [{
    line: 1,
    page: 1,
    y: 700,
    text: words.join(" "),
    words: words.map((text, index) => ({ text, x: index * 50, width: 40 })),
  }],
})

describe("extractPdfLines", () => {
  it("groups the text fixture's words into numbered lines, left to right, with their x", async () => {
    const read = await pages("statement.pdf")
    expect(read.map(({ page, lines }) => [page, lines.map((line) => line.line)])).toEqual([
      [1, [1, 2, 3, 4, 5, 6, 7]],
      [2, [8, 9, 10, 11]],
    ])
    const row = read[0].lines[4]
    expect(row.text).toBe("03.01.2026 Coffee Shop -4.50 3,495.50")
    expect(row.words.map(({ text, x }) => [text, Math.round(x)])).toEqual([
      ["03.01.2026", 50],
      ["Coffee", 130],
      ["Shop", 165],
      ["-4.50", 375],
      ["3,495.50", 460],
    ])
  })

  it("joins words whose baselines are within 2 points and splits lines further apart", async () => {
    const { open } = fakeOpener(1, [
      item("right", 200, 701.5),
      item("left", 50, 700),
      item("below", 50, 697),
    ])
    const read = await readPdfLines(new Uint8Array(8), {}, open)
    expect(read.ok && read.value[0].lines.map((line) => line.text)).toEqual([
      "left right",
      "below",
    ])
  })

  it("returns no-text-layer with the scan message for an image-only PDF", async () => {
    expect(await extractPdfLines(await bytes("scanned.pdf"))).toEqual({
      ok: false,
      error: { code: "no-text-layer", message: NO_TEXT_LAYER_MESSAGE },
    })
    expect(NO_TEXT_LAYER_MESSAGE).toBe(
      "This PDF is a scanned image. Download a CSV or a text PDF from your bank.",
    )
  })

  it("returns encrypted for a password-protected PDF", async () => {
    const read = await extractPdfLines(await bytes("encrypted.pdf"))
    expect(!read.ok && read.error.code).toBe("encrypted")
  })

  it("returns malformed for bytes that are not a PDF", async () => {
    const read = await extractPdfLines(new TextEncoder().encode("Date,Amount\n"))
    expect(!read.ok && read.error.code).toBe("malformed")
  })

  it("passes isEvalSupported: false to pdf.js on every load", async () => {
    const seen: unknown[] = []
    definePDFJSModule(() =>
      Promise.resolve({
        getDocument: (params: unknown) => {
          seen.push(params)
          return { promise: Promise.reject(new Error("fake pdf.js opens nothing")) }
        },
      })
    )
    try {
      await extractPdfLines(new Uint8Array(8))
      await extractPdfLines(new Uint8Array(8), { maxPages: 1, maxBytes: 100 })
    } finally {
      // No loader: unpdf goes back to its bundled pdf.js.
      definePDFJSModule(undefined as unknown as () => Promise<unknown>)
    }
    expect(seen).toHaveLength(2)
    for (const options of seen) expect(options).toMatchObject({ isEvalSupported: false })
  })

  it("refuses a file over maxBytes before pdf.js opens it", async () => {
    const { open, seen } = fakeOpener(1, [item("text", 50, 700)])
    const read = await readPdfLines(new Uint8Array(101), { maxBytes: 100 }, open)
    expect(!read.ok && read.error.code).toBe("too-large")
    expect(seen.opened).toBe(0)
  })

  it("refuses a PDF over maxPages before any page's text is read", async () => {
    const { open, seen } = fakeOpener(51, [item("text", 50, 700)])
    const read = await readPdfLines(new Uint8Array(8), {}, open)
    expect(read).toEqual({
      ok: false,
      error: { code: "too-large", message: "The PDF has 51 pages, over the limit of 50." },
    })
    expect(seen.pagesRead).toBe(0)
    expect(seen.destroyed).toBe(1)
    const real = await extractPdfLines(await bytes("statement.pdf"), { maxPages: 1 })
    expect(!real.ok && real.error.code).toBe("too-large")
  })

  it("refuses text past maxBytes characters as it streams in", async () => {
    const { open } = fakeOpener(1, [item("a".repeat(60), 50, 700), item("b".repeat(60), 50, 680)])
    const read = await readPdfLines(new Uint8Array(8), { maxBytes: 100 }, open)
    expect(!read.ok && read.error.code).toBe("too-large")
  })

  it("refuses a PDF with more lines than maxLines", async () => {
    const read = await extractPdfLines(await bytes("statement.pdf"), { maxLines: 10 })
    expect(!read.ok && read.error.code).toBe("too-large")
  })
})

describe("parsePdfStatement", () => {
  it("reads the text fixture with column ranges into rows that verify", async () => {
    const statement = parsePdfStatement(await pages("statement.pdf"), byColumns)
    expect(statement.rowErrors).toEqual([])
    expect(statement.format).toBe("pdf")
    expect(statement.rows.map(({ line, date, amount, memo, balance }) => [
      line,
      date,
      amount,
      memo,
      balance,
    ])).toEqual([
      [4, "2026-01-02", 250000, "Salary", 350000],
      [5, "2026-01-03", -450, "Coffee Shop", 349550],
      [6, "2026-01-05", -120000, "Rent January", 229550],
      [9, "2026-01-07", -8520, "Grocery Store", 221030],
      [10, "2026-01-09", 1999, "Refund Online Shop", 223029],
    ])
    expect(verifyStatement(statement)).toEqual({ status: "verified" })
  })

  it("reads the same rows with a line pattern of typed tokens", async () => {
    const read = await pages("statement.pdf")
    expect(parsePdfStatement(read, byPattern)).toEqual(parsePdfStatement(read, byColumns))
  })

  it("fails the fixture with one amount changed and names that row's line", async () => {
    const changed = await pages("statement.pdf", ["(-4.50)", "(-4.60)"])
    for (const profile of [byColumns, byPattern]) {
      expect(verifyStatement(parsePdfStatement(changed, profile))).toEqual({
        status: "failed",
        failures: [{ type: "running", line: 5, expected: 349540, found: 349550 }],
      })
    }
    expect(changed[0].lines.find((line) => line.line === 5)?.text).toContain("-4.60")
  })

  it("turns a line that starts like a row but does not match the pattern into a row error", async () => {
    const changed = await pages("statement.pdf", ["(-4.50)", "(four)"])
    expect(parsePdfStatement(changed, byPattern).rowErrors).toEqual([
      { line: 5, reason: `line "03.01.2026 Coffee Shop four 3,495.50" does not match the pattern` },
    ])
  })

  it("matches a literal token and an amount written over two words", () => {
    const page = handPage(["02.01.2026", "Salary", "EUR", "2", "500,00", "3", "500,00"])
    const profile: StatementProfile = {
      ...base,
      numberFormat: { decimal: ",", group: " " },
      pdf: {
        pattern: [
          { type: "date" },
          { type: "text" },
          { literal: "EUR" },
          { type: "amount" },
          { type: "amount" },
        ],
      },
    }
    expect(parsePdfStatement([page], profile).rows).toMatchObject([
      { line: 1, amount: 250000, memo: "Salary", balance: 350000 },
    ])
  })

  it("keeps a number inside the description when the amounts come after it", () => {
    const page = handPage(["02.01.2026", "Invoice", "2024", "paid", "-5.00", "95.00"])
    expect(parsePdfStatement([page], byPattern)).toMatchObject({
      rows: [{ line: 1, memo: "Invoice 2024 paid", amount: -500, balance: 9500 }],
      rowErrors: [],
    })
  })

  it("gives up on a long line of numbers that matches no way within a second", () => {
    const numbers = Array.from({ length: 300 }, (_, index) => String(index + 1))
    const page = handPage(["02.01.2026", ...numbers, "end"])
    const pairs = Array.from({ length: 3 }, () => [{ type: "text" }, { type: "amount" }] as const)
    const profile: StatementProfile = {
      ...base,
      pdf: { pattern: [{ type: "date" }, ...pairs.flat()] },
    }
    const started = performance.now()
    const parsed = parsePdfStatement([page], profile)
    const took = performance.now() - started
    expect(parsed.rows).toEqual([])
    expect(parsed.rowErrors).toHaveLength(1)
    expect(parsed.rowErrors[0].reason).toContain("does not match the pattern")
    expect(took).toBeLessThan(1000)
  })

  it("throws for a profile without a pdf layout", () => {
    expect(() => parsePdfStatement([], base)).toThrow("no pdf layout")
  })
})

describe("statementProfile pdf layout", () => {
  const isRejected = (pdf: unknown) => statementProfile({ ...base, pdf }) instanceof type.errors

  it("accepts column ranges and a pattern of typed tokens", () => {
    expect(isRejected(byColumns.pdf)).toBe(false)
    expect(isRejected({ pattern: [{ type: "date" }, { literal: "EUR" }] })).toBe(false)
    expect(isRejected(byPattern.pdf)).toBe(false)
  })

  it("rejects a line pattern that is a regular expression and not the typed-token list", () => {
    expect(isRejected({ pattern: "^(\\d{2}\\.){2}\\d{4} (.+) (-?[\\d,.]+)$" })).toBe(true)
    expect(isRejected({ pattern: [{ regex: "(a+)+$" }] })).toBe(true)
    expect(isRejected({ pattern: [{ type: "regex" }] })).toBe(true)
    expect(isRejected({ pattern: [{ type: "date", regex: "(a+)+$" }] })).toBe(true)
    expect(isRejected({ pattern: [] })).toBe(true)
    expect(isRejected({ pattern: Array(65).fill({ type: "text" }) })).toBe(true)
    expect(isRejected({ pattern: [{ literal: "two  spaces" }] })).toBe(true)
  })

  it("rejects a column range whose from is not below its to", () => {
    expect(isRejected({ columns: [{ from: 100, to: 100 }] })).toBe(true)
    expect(isRejected({ columns: [] })).toBe(true)
  })
})

describe("the main entry", () => {
  it("imports no pdf.js, so an app that reads only CSV does not carry it", async () => {
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
    expect(seen.has(new URL("./profile.ts", import.meta.url).href)).toBe(true)
    expect([...seen].filter((name) => /unpdf|pdfjs|pdf\.ts|pdf-read\.ts/.test(name))).toEqual([])
  })
})
