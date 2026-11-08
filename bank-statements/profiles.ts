/**
 * Finding the profile for a CSV file: the built-in ones, ranking by fingerprint, and a guess built
 * from the file alone, with no network call.
 *
 * @module
 */

import { parseCsv, sniffCsv } from "@spy4x/platform/universal/csv"
import {
  detectNumberFormat,
  isCurrencyCode,
  isDebitCreditPair,
  NEGATIVE_STYLES,
} from "@spy4x/platform/universal/money-core"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import { detectDatePatterns } from "@spy4x/time/date"
import { csvRecords, foldHeader, type StatementProfile } from "./profile.ts"
import { quote } from "./statement.ts"

/**
 * The profiles this package ships, one per CSV shape, each with a synthetic fixture in
 * `fixtures/` and a test that parses and verifies it. A real bank joins once its export has been
 * anonymised.
 */
export const builtInProfiles: readonly StatementProfile[] = Object.freeze(
  [
    {
      id: "019a6000-0000-7000-8000-000000000001",
      name: "Signed amount, comma, ISO dates",
      encoding: "utf-8",
      delimiter: ",",
      headerLine: 1,
      date: { column: 0, pattern: "YYYY-MM-DD" },
      amount: { column: 2 },
      numberFormat: { decimal: ".", group: "" },
      currency: { column: 3 },
      description: 1,
      balance: 4,
      fingerprint: {
        headers: ["date", "description", "amount", "currency", "balance"],
        columns: 5,
        delimiter: ",",
      },
    },
    {
      id: "019a6000-0000-7000-8000-000000000002",
      name: "Debit and credit, semicolon, German numbers",
      encoding: "windows-1252",
      delimiter: ";",
      headerLine: 1,
      date: { column: 0, pattern: "DD.MM.YYYY" },
      amount: { debit: 3, credit: 4 },
      numberFormat: { decimal: ",", group: "." },
      currency: { code: "EUR" },
      payee: 1,
      description: 2,
      balance: 5,
      fingerprint: {
        headers: [
          "buchungstag",
          "empfänger",
          "verwendungszweck",
          "soll",
          "haben",
          "saldo",
        ],
        columns: 6,
        delimiter: ";",
      },
    },
    {
      id: "019a6000-0000-7000-8000-000000000003",
      name: "Preamble rows, US dates, foreign amounts",
      encoding: "utf-8",
      delimiter: ",",
      headerLine: 4,
      date: { column: 0, pattern: "MM/DD/YYYY" },
      amount: { column: 3 },
      numberFormat: { decimal: ".", group: "," },
      negatives: ["minus", "parentheses"],
      currency: { code: "USD" },
      payee: 1,
      reference: 2,
      originalAmount: 4,
      originalCurrency: 5,
      fingerprint: {
        headers: [
          "posted date",
          "payee",
          "reference",
          "amount",
          "original amount",
          "original currency",
        ],
        columns: 6,
        delimiter: ",",
      },
    },
  ] satisfies StatementProfile[],
)

/** A profile and how well a file fits it, from 0 (not at all) to 1 (every header name). */
export interface ProfileMatch {
  profile: StatementProfile
  score: number
}

/**
 * Rank `profiles` by how well `sample`, the start of a decoded CSV file, fits their fingerprint:
 * the header line split on the profile's delimiter must have its column count, and the score is
 * the share of header names equal in the same place. Profiles that do not fit at all are left out;
 * the best fit comes first. Pass the built-in list plus the household's own.
 */
export function matchProfile(
  sample: string,
  profiles: readonly StatementProfile[],
): ProfileMatch[] {
  const matches: ProfileMatch[] = []
  for (const profile of profiles) {
    const { headers, columns, delimiter } = profile.fingerprint
    const [header] = csvRecords(sample.slice(0, 65_536), profile.headerLine)
    const parsed = header && parseCsv(header.text, { delimiter })
    const names = parsed && parsed.ok ? parsed.value[0] ?? [] : []
    if (names.length !== columns || headers.length === 0) continue
    const equal = headers.filter((name, index) =>
      foldHeader(name) === foldHeader(names[index] ?? "")
    ).length
    if (equal > 0) {
      matches.push({ profile, score: equal / headers.length })
    }
  }
  return matches.sort((a, b) => b.score - a.score)
}

/** How many lines {@link guessProfile} looks at. */
const GUESS_LINES = 60

/** Header words that name a column, in the languages of the first users. */
const HEADER_WORDS = {
  balance: /balance|saldo|solde|остаток/,
  payee: /payee|recipient|beneficiary|counterparty|empfänger|получатель|bénéficiaire/,
  description: /description|memo|details|purpose|verwendungszweck|назначение|libellé/,
  reference: /reference|^ref/,
}

/**
 * Build a candidate profile for a CSV file from the file alone, for a person to confirm: the
 * delimiter, the header line (the first line with as many columns as most lines), the date column
 * and pattern, the amount as a debit and credit pair or one signed column, the number format, and
 * the balance, payee, description and reference columns by their header names. `currency` is the
 * account's, used when no column holds currency codes; `encoding` is set to `"utf-8"`, since the
 * text is already decoded. `null` when no header, date column or amount column is found.
 */
export function guessProfile(
  text: string,
  currency: string,
): StatementProfile | null {
  if (!isCurrencyCode(currency)) {
    throw new RangeError(`unknown currency ${quote(currency)}`)
  }
  const { delimiter } = sniffCsv(text)
  const lines = csvRecords(text.slice(0, 65_536)).slice(0, GUESS_LINES).map(
    (record) => {
      const parsed = parseCsv(record.text, { delimiter })
      return {
        line: record.line,
        fields: parsed.ok ? parsed.value[0] ?? [] : [],
      }
    },
  )
  const tally = new Map<number, number>()
  for (const { fields } of lines) {
    tally.set(fields.length, (tally.get(fields.length) ?? 0) + 1)
  }
  const columns = [...tally].filter(([count]) => count >= 2).sort((a, b) => b[1] - a[1])[0]?.[0]
  const headerIndex = lines.findIndex(({ fields }) => fields.length === columns)
  if (columns === undefined || headerIndex === -1) return null
  const header = lines[headerIndex].fields.map(foldHeader)
  const data = lines.slice(headerIndex + 1).filter(({ fields }) => fields.length === columns)
  if (data.length === 0 || detectDatePatterns(header).length > 0) return null
  const cells = (column: number) => data.map(({ fields }) => fields[column].trim())
  const named = (word: RegExp) => {
    const index = header.findIndex((name) => word.test(name))
    return index === -1 ? undefined : index
  }

  const dateColumn = header.findIndex((_, column) => detectDatePatterns(cells(column)).length > 0)
  if (dateColumn === -1) return null
  const balance = named(HEADER_WORDS.balance)
  const numeric = header.map((_, column) => column).filter((column) =>
    column !== dateColumn && column !== balance && cells(column).some((cell) => cell !== "") &&
    detectNumberFormat(cells(column)).length > 0
  )
  const pair = numeric.findIndex((column, index) =>
    numeric[index + 1] === column + 1 &&
    isDebitCreditPair(cells(column), cells(column + 1))
  )
  const amount: StatementProfile["amount"] | undefined = pair !== -1
    ? { debit: numeric[pair], credit: numeric[pair] + 1 }
    : numeric.length > 0
    ? { column: numeric[0] }
    : undefined
  if (!amount) return null
  const amountColumns = "column" in amount ? [amount.column] : [amount.debit, amount.credit]
  const numberFormat = detectNumberFormat(
    [...amountColumns, ...(balance === undefined ? [] : [balance])].flatMap(
      cells,
    ),
  )[0]
  if (!numberFormat) return null
  const currencyColumn = header.findIndex((_, column) =>
    cells(column).every((cell) => isCurrencyCode(cell))
  )

  const profile: StatementProfile = {
    id: uuidV7(),
    name: "Guessed profile",
    encoding: "utf-8",
    delimiter,
    headerLine: lines[headerIndex].line,
    date: {
      column: dateColumn,
      pattern: detectDatePatterns(cells(dateColumn))[0],
    },
    amount,
    numberFormat,
    negatives: [...NEGATIVE_STYLES],
    currency: currencyColumn === -1 ? { code: currency } : { column: currencyColumn },
    payee: named(HEADER_WORDS.payee),
    description: named(HEADER_WORDS.description),
    reference: named(HEADER_WORDS.reference),
    balance,
    fingerprint: { headers: header, columns, delimiter },
  }
  for (const key of ["payee", "description", "reference", "balance"] as const) {
    if (profile[key] === undefined) delete profile[key]
  }
  return profile
}
