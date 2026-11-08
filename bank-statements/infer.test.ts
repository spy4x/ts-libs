import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { builtInProfiles, type StatementProfile } from "./mod.ts"
import {
  inferProfile,
  maskSample,
  profilePrompt,
  type ProfileProposalRequest,
  type ProposeProfile,
} from "./infer.ts"
import type { PdfLine, PdfPage } from "./pdf-read.ts"

const FIXTURES = new URL("./fixtures/", import.meta.url)
const bytes = (name: string) => Deno.readFile(new URL(name, FIXTURES))
const encode = (text: string) => new TextEncoder().encode(text)

/** A fake model that records every request and answers with `reply`. */
function recordingPort(
  reply: unknown = null,
): { propose: ProposeProfile; calls: ProfileProposalRequest[] } {
  const calls: ProfileProposalRequest[] = []
  return {
    calls,
    propose: (request) => {
      calls.push(request)
      return Promise.resolve(reply)
    },
  }
}

/** The masked lines a prompt carries, and the file line of the first one. */
function sampleOf(prompt: string): { lines: string[]; firstLine: number } {
  const block = /<sample>\n([\s\S]*?)\n<\/sample>/.exec(prompt)
  if (!block) throw new Error("the prompt has no sample block")
  const firstLine = Number(/Its first line is line (\d+) of the file/.exec(prompt)?.[1] ?? 1)
  return { lines: block[1].split("\n"), firstLine }
}

const codePoints = (text: string) => [...text].length

describe("maskSample", () => {
  it("keeps the header row's letters, masks its digits, and masks every other line", () => {
    expect(maskSample(["Datum;Empfänger;Betrag2", "05.01.2026;Anna Kowalska;-45,10"], {
      headerRow: 0,
    })).toEqual(["Datum;Empfänger;Betrag9", "99.99.9999;Xxxx Xxxxxxxx;-99,99"])
  })

  it("keeps the header row's letters only when no cell reads as a date or an amount", () => {
    expect(maskSample(["Date,Payee,Amount", "2026-01-05,Coffee,-3.50"], { headerRow: 0 }))
      .toEqual(["Date,Payee,Amount", "9999-99-99,Xxxxxx,-9.99"])
    expect(maskSample(["2026-01-05,Coffee,-3.50"], { headerRow: 0 }))
      .toEqual(["9999-99-99,Xxxxxx,-9.99"])
    expect(maskSample(["Anna Kowalska,1 200,00"], { headerRow: 0 }))
      .toEqual(["Xxxx Xxxxxxxx,9 999,99"])
  })

  it("masks Unicode letters by case and Unicode digits as 9, keeping each line's length", () => {
    const lines = ["Иван Петров ΣΩ ǅ 张伟 é ٣٤ ½ 🍕 𝐀𝐛 EUR 1.234,56€"]
    const [masked] = maskSample(lines)
    expect(masked).toBe("Xxxx Xxxxxx XX X xx x 99 9 x Xx XXX 9.999,99€")
    expect(codePoints(masked)).toBe(codePoints(lines[0]))
  })

  it("returns at most maxRows lines, 20 by default", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`)
    expect(maskSample(lines)).toHaveLength(20)
    expect(maskSample(lines, { maxRows: 3 })).toEqual(["xxxx 9", "xxxx 9", "xxxx 9"])
    expect(() => maskSample(lines, { maxRows: 0 })).toThrow(RangeError)
  })
})

describe("profilePrompt", () => {
  it("contains the word json, an example reply, the sample and its first line", () => {
    const prompt = profilePrompt(["Date,Amount", "9999-99-99,-9.99"], { firstLine: 3 })
    expect(prompt).toContain("json")
    expect(prompt).toContain(`{"delimiter": ";", "headerLine": 1`)
    expect(prompt).toContain("<sample>\nDate,Amount\n9999-99-99,-9.99\n</sample>")
    expect(prompt).toContain("Its first line is line 3 of the file")
  })
})

/** A deterministic random source, so a failing case reproduces. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LATIN = "abcdefghijklmnopqrstuvwxyzäöüß"
const CYRILLIC = "абвгдежзиклмнопрстуфхцчшщэюя"
const HEADERS = [
  ["Datum", "Date", "Дата"],
  ["Empfänger", "Counterparty", "Контрагент"],
  ["Text", "Details", "Описание"],
  ["Konto", "Account", "Счёт"],
  ["Umsatz", "Value", "Сумма", "Betrag2", "Betrag 2"],
]

/**
 * A synthetic CSV statement with names, IBANs, card numbers and amounts in Latin and Cyrillic, no
 * balance column, and sometimes preamble lines; with every value that must not leave the host.
 */
function generatedStatement(
  next: () => number,
): { text: string; header: string; secrets: string[] } {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]
  const digits = (count: number) =>
    Array.from({ length: count }, () => pick([..."0123456789"])).join("")
  const word = () => {
    const alphabet = pick([LATIN, CYRILLIC])
    const letters = Array.from({ length: 5 + Math.floor(next() * 4) }, () => pick([...alphabet]))
    return letters[0].toUpperCase() + letters.slice(1).join("")
  }
  const delimiter = pick([",", ";", "\t", "|"])
  const decimal = delimiter === "," ? "." : pick([".", ","])
  const secrets: string[] = []
  const field = (value: string) => value.includes(delimiter) ? `"${value}"` : value
  const header = HEADERS.map(pick).join(delimiter)
  const lines: string[] = []
  for (let index = Math.floor(next() * 3); index > 0; index--) {
    const holder = `${word()} ${word()}`
    secrets.push(holder)
    lines.push(`Inhaber${delimiter}${holder}`)
  }
  lines.push(header)
  for (let row = 0; row < 3 + Math.floor(next() * 25); row++) {
    const date = `${pick(["0", "1", "2"])}${1 + Math.floor(next() * 8)}.${pick(["01", "11"])}.2026`
    const payee = `${word()} ${word()}`
    const card = [digits(4), digits(4), digits(4), digits(4)].join(" ")
    const iban = `DE${digits(20)}`
    const amount = `${pick(["-", ""])}${1 + Math.floor(next() * 9000)}${decimal}${digits(2)}`
    secrets.push(payee, card, iban, amount)
    lines.push(
      [date, payee, `Karte ${card} ${word()}`, iban, amount].map(field).join(delimiter),
    )
  }
  return { text: lines.join(pick(["\n", "\r\n"])) + "\n", header, secrets }
}

describe("inferProfile, what the model sees", () => {
  it("never receives a digit from the file or a letter from outside the header row", async () => {
    const next = random(822)
    let headersKept = 0
    for (let run = 0; run < 150; run++) {
      const { text, header, secrets } = generatedStatement(next)
      const port = recordingPort()
      await inferProfile(encode(text), { currency: "EUR", propose: port.propose })
      expect(port.calls).toHaveLength(1)
      const { prompt } = port.calls[0]
      for (const secret of secrets) expect(prompt).not.toContain(secret)
      const fileLines = text.split(/\r?\n/)
      const { lines, firstLine } = sampleOf(prompt)
      expect(lines.length).toBeLessThanOrEqual(20)
      lines.forEach((masked, index) => {
        const original = fileLines[firstLine - 1 + index]
        expect(codePoints(masked)).toBe(codePoints(original))
        expect(masked).not.toMatch(/[\p{N}--9]/v)
        if (original !== header) expect(masked).not.toMatch(/[\p{L}--[xX]]/v)
        else if (masked === original) headersKept++
      })
    }
    // The header rule is exercised: most generated headers have no digit and keep their letters.
    expect(headersKept).toBeGreaterThan(50)
  })

  it("masks a file without a header row whole", async () => {
    const port = recordingPort()
    const text = "05.01.2026;Anna Kowalska;-45,10\n06.01.2026;Иван Петров;12,00\n"
    await inferProfile(encode(text), { currency: "EUR", propose: port.propose })
    expect(sampleOf(port.calls[0].prompt).lines).toEqual([
      "99.99.9999;Xxxx Xxxxxxxx;-99,99",
      "99.99.9999;Xxxx Xxxxxx;99,99",
    ])
  })
})

/** A file no built-in profile reads and whose balance column `guessProfile` cannot name. */
const UNKNOWN = [
  "Kontoauszug;Anna Kowalska",
  "Datum;Gegenseite;Umsatz;Kontostand",
  "13.01.2026;Arbeitgeber GmbH;2.000,00;2.150,00",
  "14.01.2026;Bäckerei;-4,80;2.145,20",
  "15.01.2026;Stadtwerke;-45,10;2.100,10",
  "",
].join("\n")

const PROPOSAL = {
  delimiter: ";",
  headerLine: 2,
  date: { column: 0 },
  payee: 1,
  amount: { column: 2 },
  balance: 3,
}

describe("inferProfile, the model's proposal", () => {
  it("accepts a proposal that reads every row and verifies, with formats read locally", async () => {
    const port = recordingPort({ ...PROPOSAL, extra: "ignored" })
    const result = await inferProfile(encode(UNKNOWN), { currency: "EUR", propose: port.propose })
    expect(port.calls).toHaveLength(1)
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`)
    expect(result.value.source).toBe("model")
    if (result.value.source === "standard") throw new Error("no profile")
    const { profile, statement } = result.value
    expect(profile.date).toEqual({ column: 0, pattern: "DD.MM.YYYY" })
    expect(profile.numberFormat).toEqual({ decimal: ",", group: "." })
    expect(profile.currency).toEqual({ code: "EUR" })
    expect(profile.fingerprint.headers).toEqual(["datum", "gegenseite", "umsatz", "kontostand"])
    expect(statement.rows.map((row) => row.amount)).toEqual([200000, -480, -4510])
  })

  it("refuses a proposal whose balances do not add up, naming the failing lines", async () => {
    const port = recordingPort(PROPOSAL)
    const broken = UNKNOWN.replace("2.145,20", "2.145,00")
    const result = await inferProfile(encode(broken), { currency: "EUR", propose: port.propose })
    expect(port.calls).toHaveLength(1)
    if (result.ok || result.error.code !== "failed") {
      throw new Error(`expected failed, got ${JSON.stringify(result)}`)
    }
    expect(result.error.failures.map((failure) => failure.line)).toEqual([4, 5])
  })

  it("refuses a proposal that leaves rows unread as parse-errors", async () => {
    const port = recordingPort(PROPOSAL)
    const broken = UNKNOWN.replace("-4,80", "n/a")
    const result = await inferProfile(encode(broken), { currency: "EUR", propose: port.propose })
    if (result.ok || result.error.code !== "parse-errors") {
      throw new Error(`expected parse-errors, got ${JSON.stringify(result)}`)
    }
    expect(result.error.rowErrors.map((error) => error.line)).toEqual([4])
  })

  it("refuses a proposal for a file without balances as unverifiable", async () => {
    const { balance: _, ...withoutBalance } = PROPOSAL
    const port = recordingPort(withoutBalance)
    const text = UNKNOWN.replace(/^(.*;.*;.*);[^;\n]*$/gm, "$1")
    const result = await inferProfile(encode(text), { currency: "EUR", propose: port.propose })
    expect(port.calls).toHaveLength(1)
    expect(result.ok ? "verified" : result.error.code).toBe("unverifiable")
  })

  it("refuses no reply, and a reply that fails the schema, as invalid-reply", async () => {
    for (const reply of [null, { delimiter: ";" }, { ...PROPOSAL, date: { column: -1 } }]) {
      const port = recordingPort(reply)
      const result = await inferProfile(encode(UNKNOWN), { currency: "EUR", propose: port.propose })
      expect(port.calls).toHaveLength(1)
      expect(result.ok ? "verified" : result.error.code).toBe("invalid-reply")
    }
  })

  it("refuses a proposal whose date column holds no dates as invalid-reply", async () => {
    const port = recordingPort({ ...PROPOSAL, date: { column: 1 } })
    const result = await inferProfile(encode(UNKNOWN), { currency: "EUR", propose: port.propose })
    expect(result.ok ? "verified" : result.error.code).toBe("invalid-reply")
  })
})

describe("inferProfile, when the model is asked", () => {
  it("never asks the model when a known profile verifies", async () => {
    const port = recordingPort(PROPOSAL)
    const result = await inferProfile(await bytes("signed.csv"), {
      currency: "EUR",
      propose: port.propose,
    })
    expect(port.calls).toHaveLength(0)
    expect(result.ok && result.value.source).toBe("known")
  })

  it("never asks the model when a guessed profile verifies", async () => {
    const port = recordingPort(PROPOSAL)
    const text = UNKNOWN.replace("Kontostand", "Saldo")
    const result = await inferProfile(encode(text), {
      currency: "EUR",
      propose: port.propose,
      profiles: [],
    })
    expect(port.calls).toHaveLength(0)
    expect(result.ok && result.value.source).toBe("guessed")
  })

  it("never asks the model for a standard format", async () => {
    const port = recordingPort(PROPOSAL)
    const result = await inferProfile(await bytes("ofx1.ofx"), {
      currency: "EUR",
      propose: port.propose,
    })
    expect(port.calls).toHaveLength(0)
    expect(result.ok && result.value.source).toBe("standard")
  })
})

/** A PDF line from words at the given x, each 40 points wide. */
function pdfLine(line: number, words: [number, string][]): PdfLine {
  return {
    line,
    page: 1,
    y: 800 - line * 12,
    words: words.map(([x, text]) => ({ text, x, width: 40 })),
    text: words.map(([, text]) => text).join(" "),
  }
}

const PDF: PdfPage[] = [{
  page: 1,
  lines: [
    pdfLine(1, [[50, "Anna"], [80, "Kowalska"]]),
    pdfLine(2, [[50, "Datum"], [120, "Text"], [300, "Betrag"], [400, "Saldo"]]),
    pdfLine(3, [[50, "13.01.2026"], [120, "Arbeitgeber"], [300, "2.000,00"], [400, "2.150,00"]]),
    pdfLine(4, [[50, "14.01.2026"], [120, "Иван"], [160, "Петров"], [300, "-4,80"], [
      400,
      "2.145,20",
    ]]),
  ],
}]

const PDF_PROPOSAL = {
  pdf: {
    pattern: [{ type: "date" }, { type: "text" }, { type: "amount" }, { type: "amount" }],
  },
  date: { column: 0 },
  description: 1,
  amount: { column: 2 },
  balance: 3,
}

describe("inferProfile, PDF statements", () => {
  it("sends masked words with their positions and accepts a pdf layout that verifies", async () => {
    const port = recordingPort(PDF_PROPOSAL)
    const result = await inferProfile(PDF, { currency: "EUR", propose: port.propose })
    expect(port.calls).toHaveLength(1)
    expect(sampleOf(port.calls[0].prompt).lines).toEqual([
      `[[50,90,"Xxxx"],[80,120,"Xxxxxxxx"]]`,
      `[[50,90,"Datum"],[120,160,"Text"],[300,340,"Betrag"],[400,440,"Saldo"]]`,
      `[[50,90,"99.99.9999"],[120,160,"Xxxxxxxxxxx"],[300,340,"9.999,99"],[400,440,"9.999,99"]]`,
      `[[50,90,"99.99.9999"],[120,160,"Xxxx"],[160,200,"Xxxxxx"],[300,340,"-9,99"],[400,440,"9.999,99"]]`,
    ])
    if (!result.ok || result.value.source !== "model") {
      throw new Error(`expected a model profile, got ${JSON.stringify(result)}`)
    }
    expect(result.value.profile.pdf).toEqual(PDF_PROPOSAL.pdf)
    expect(result.value.profile.numberFormat).toEqual({ decimal: ",", group: "." })
    expect(result.value.statement.rows.map((row) => row.amount)).toEqual([200000, -480])
  })

  it("never asks the model when a known pdf profile verifies", async () => {
    const port = recordingPort(PDF_PROPOSAL)
    const known: StatementProfile = {
      ...builtInProfiles[0],
      date: { column: 0, pattern: "DD.MM.YYYY" },
      amount: { column: 2 },
      numberFormat: { decimal: ",", group: "." },
      currency: { code: "EUR" },
      description: 1,
      balance: 3,
      pdf: PDF_PROPOSAL.pdf as StatementProfile["pdf"],
    }
    const result = await inferProfile(PDF, {
      currency: "EUR",
      propose: port.propose,
      profiles: [known],
    })
    expect(port.calls).toHaveLength(0)
    expect(result.ok && result.value.source).toBe("known")
  })
})

describe("infer.ts", () => {
  it("imports only web standards, @std, @spy4x, arktype and its own package, and no Deno API", async () => {
    const source = await Deno.readTextFile(new URL("./infer.ts", import.meta.url))
    const specifiers = [...source.matchAll(/^import\s(?:[^"]*?\sfrom\s)?"([^"]+)"/gm)].map((
      match,
    ) => match[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).toMatch(/^(\.\/(?!pdf\.ts)|@std\/|@spy4x\/|arktype$)/)
    }
    expect(source).not.toMatch(/\bDeno\.|unpdf|pdfjs/)
  })
})
