/**
 * A statement profile proposed by a language model, for a CSV file or PDF statement that no known
 * profile reads. The model sees only a masked sample: every digit becomes `9` and every letter `x`
 * or `X`, except the header row's words that are column names from a fixed vocabulary ("Datum",
 * "Betrag", "Saldo"), so no name, amount or account number leaves the host. The model proposes the structure only; the date pattern and number format are detected
 * here from the real values, and the proposal is accepted only when it reads the whole file
 * without a row error and the file's balances add up.
 *
 * The model is a port, so this module imports no HTTP client. `chatJson` from
 * `@spy4x/integrations/llm` fits it in a few lines:
 *
 * ```ts
 * import { inferProfile } from "@spy4x/bank-statements/infer"
 * import { chatJson, createChatClient, LLM_PRESETS } from "@spy4x/integrations/llm"
 * import { builtInProfiles } from "@spy4x/bank-statements"
 *
 * declare const upload: Uint8Array
 * const client = createChatClient({ baseUrl: LLM_PRESETS.deepseek, apiKey: "…", model: "…" })
 *
 * const result = await inferProfile(upload, {
 *   currency: "EUR",
 *   profiles: builtInProfiles, // plus the household's own
 *   propose: async ({ prompt, schema }) => {
 *     const reply = await chatJson(client, {
 *       messages: [{ role: "user", content: prompt }],
 *       schema,
 *       maxTokens: 1_000,
 *     })
 *     return reply.success ? reply.output.value : null
 *   },
 * })
 * if (result.ok) console.log(result.value.source, result.value.profile)
 * else console.log(result.error.code) // "invalid-reply", "parse-errors", "failed", "unverifiable"
 * ```
 *
 * A PDF statement goes in as the pages `extractPdfLines` from `@spy4x/bank-statements/pdf`
 * returns, so this module carries no pdf.js.
 *
 * @module
 */

import { type Type, type } from "arktype"
import { decodeTextFile, parseCsv, sniffCsv } from "@spy4x/platform/universal/csv"
import {
  detectNumberFormat,
  NEGATIVE_STYLES,
  NUMBER_FORMATS,
  type NumberFormatGuess,
} from "@spy4x/platform/universal/money-core"
import { err, ok, type Result } from "@spy4x/platform/universal/result"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import { DATE_PATTERNS, type DatePattern, detectDatePatterns } from "@spy4x/time/date"
import { detectFormat, readStatement } from "./detect.ts"
import { parsePdfStatement, type PdfLine, type PdfPage } from "./pdf-read.ts"
import { csvRecords, foldHeader, type StatementProfile, statementProfile } from "./profile.ts"
import { isHeaderWord } from "./header-words.ts"
import { builtInProfiles, guessProfile, matchProfile } from "./profiles.ts"
import {
  type ParsedStatement,
  type RowError,
  StatementError,
  type StatementLimits,
} from "./statement.ts"
import { type BalanceFailure, verifyStatement } from "./verify.ts"

/** How many lines a sample has by default. */
export const DEFAULT_SAMPLE_ROWS = 20

/** How many lines the header search and the local detection look at. */
const SCAN_LINES = 60

/** How much of the decoded text the sample is cut from. */
const SAMPLE_CHARACTERS = 65_536

/**
 * What the model proposes: the structure of a profile, without the date pattern and the number
 * format, which are read from the real values. A CSV proposal has `delimiter` and `headerLine`, a
 * PDF one has `pdf`. Without a `currency` column, the account's currency applies.
 */
export type ProfileProposal =
  & Pick<
    StatementProfile,
    | "amount"
    | "payee"
    | "description"
    | "reference"
    | "balance"
    | "originalAmount"
    | "originalCurrency"
  >
  & Partial<Pick<StatementProfile, "currency" | "delimiter" | "headerLine" | "pdf">>
  & { date: { column: number } }

/** A currency in a reply: a column, or any code, which is ignored since the model saw it masked. */
const proposedCurrency = statementProfile.get("currency").or({ code: "string" })

const proposalBase = statementProfile
  .pick(
    "amount",
    "payee",
    "description",
    "reference",
    "balance",
    "originalAmount",
    "originalCurrency",
  )
  .merge({
    "currency?": proposedCurrency,
    date: statementProfile.get("date").pick("column"),
  })

/** The reply schema for a CSV file. Keys the profile does not have are dropped. */
const csvProposal = proposalBase
  .merge(statementProfile.pick("delimiter", "headerLine"))
  .onUndeclaredKey("delete") as unknown as Type<ProfileProposal>

/** The reply schema for a PDF statement. */
const pdfProposal = proposalBase
  .merge(statementProfile.pick("pdf").required())
  .onUndeclaredKey("delete") as unknown as Type<ProfileProposal>

/** What the port is asked: the prompt to send, and the schema the reply's JSON must satisfy. */
export interface ProfileProposalRequest {
  prompt: string
  schema: Type<ProfileProposal>
}

/**
 * The language model, as a port: resolves to the parsed JSON of the reply, or `null` when there
 * is none. The reply is checked against `schema` again here, so the port may pass it through.
 */
export type ProposeProfile = (request: ProfileProposalRequest) => Promise<unknown>

/** Settings for {@link inferProfile}. */
export interface InferProfileOptions extends StatementLimits {
  /** The account's ISO 4217 code, for a file with no currency column. */
  currency: string
  /** Asked at most once, and only when no known or guessed profile verifies. */
  propose: ProposeProfile
  /** The profiles to try first: the built-in ones and the household's. Default the built-in. */
  profiles?: readonly StatementProfile[]
  /** Most lines of the masked sample the model sees. Default {@link DEFAULT_SAMPLE_ROWS}, 20. */
  sampleRows?: number
}

/** A file that reads and verifies, and where the way to read it came from. */
export type InferredProfile =
  /** A standard format (OFX, QIF, CAMT.053, MT940) needs no profile; its check is the caller's. */
  | { source: "standard"; statement: ParsedStatement }
  | {
    source: "known" | "guessed" | "model"
    profile: StatementProfile
    statement: ParsedStatement
  }

/** Why no profile was found. Only the model's proposal reaches here; it is never accepted. */
export type InferFailure =
  /** No reply, or one that is not a profile's structure for this file. */
  | { code: "invalid-reply"; message: string }
  /** The proposal leaves rows of the file unread. */
  | { code: "parse-errors"; profile: StatementProfile; rowErrors: RowError[] }
  /** The proposal reads the file, but the balances do not add up on these lines. */
  | { code: "failed"; profile: StatementProfile; failures: BalanceFailure[] }
  /** The file states no balance, so nothing shows the proposal is right. */
  | { code: "unverifiable"; profile: StatementProfile }

/**
 * Find a profile that reads a statement and makes its balances add up. In turn: a standard
 * format; each matching profile of `options.profiles`; {@link guessProfile}; and only when none of
 * them verifies, one proposal of `options.propose` from a masked sample. A PDF statement goes in
 * as its extracted pages and tries the profiles with a `pdf` layout, then the model.
 *
 * A file refused whole throws a {@link StatementError}, as {@link readStatement} does; PDF bytes
 * and a format no reader knows throw one with code `"unsupported"`.
 */
export async function inferProfile(
  input: Uint8Array | readonly PdfPage[],
  options: InferProfileOptions,
): Promise<Result<InferredProfile, InferFailure>> {
  const { currency, propose, profiles = builtInProfiles, sampleRows = DEFAULT_SAMPLE_ROWS } =
    options
  const limits: StatementLimits = { maxBytes: options.maxBytes, maxRows: options.maxRows }
  if (!(input instanceof Uint8Array)) {
    return await inferPdf(input, { currency, propose, profiles, sampleRows, limits })
  }

  const format = detectFormat(input)
  if (format === "pdf") {
    throw new StatementError("unsupported", "a PDF goes in as the pages extractPdfLines reads")
  }
  if (format !== "csv") {
    return ok({ source: "standard", statement: readStatement(input, { ...limits, currency }) })
  }
  const read = (profile: StatementProfile) => readStatement(input, { ...limits, profile })
  const decoded = decodeTextFile(input)
  const text = decoded.text
  for (const { profile } of matchProfile(text, profiles)) {
    const statement = read(profile)
    if (isVerified(statement)) return ok({ source: "known", profile, statement })
  }
  const guess = guessProfile(text, currency)
  if (guess) {
    const profile = { ...guess, encoding: decoded.encoding }
    const statement = read(profile)
    if (isVerified(statement)) return ok({ source: "guessed", profile, statement })
  }

  const lines = text.slice(0, SAMPLE_CHARACTERS).replace(/\r?\n$/, "").split("\n")
    .map((line) => line.replace(/\r$/, ""))
  const { delimiter } = sniffCsv(text)
  const header = findHeader(lines, (line) => csvCells(line, delimiter).length)
  const start = sampleStart(header)
  const masked = maskSample(lines.slice(start), {
    headerRow: header === undefined ? undefined : header - start,
    maxRows: sampleRows,
  })
  const reply = await ask(propose, profilePrompt(masked, { firstLine: start + 1 }), csvProposal)
  if (!reply.ok) return reply
  const proposal = reply.value
  const delimiterOf = proposal.delimiter as NonNullable<ProfileProposal["delimiter"]>
  const records = csvRecords(text.slice(0, SAMPLE_CHARACTERS), proposal.headerLine)
  const names = records[0] ? csvCells(records[0].text, delimiterOf) : []
  if (names.length === 0) {
    return err({ code: "invalid-reply", message: "the proposed header line is not in the file" })
  }
  const rows = records.slice(1, SCAN_LINES).map((record) => csvCells(record.text, delimiterOf))
  const cells = (column: number | undefined) =>
    column === undefined ? [] : rows.map((row) => (row[column] ?? "").trim())
  const amountColumns = "column" in proposal.amount
    ? [proposal.amount.column]
    : [proposal.amount.debit, proposal.amount.credit]
  const profile = completeProposal(proposal, {
    currency,
    encoding: decoded.encoding,
    delimiter: delimiterOf,
    headerLine: proposal.headerLine as number,
    fingerprint: { headers: names.map(foldHeader), columns: names.length, delimiter: delimiterOf },
  })
  return tryFormats(
    profile,
    fitting(detectDatePatterns, cells(proposal.date.column)),
    fitting(detectNumberFormat, [...amountColumns, proposal.balance].flatMap(cells)),
    read,
  )
}

/**
 * The formats that read every cell some format reads, so one broken cell becomes a row error of
 * the proposal rather than hiding the column's format.
 */
function fitting<T>(detect: (cells: readonly string[]) => T[], cells: readonly string[]): T[] {
  return detect(cells.filter((cell) => detect([cell]).length > 0))
}

/** The PDF path of {@link inferProfile}. */
async function inferPdf(
  pages: readonly PdfPage[],
  options:
    & Required<Pick<InferProfileOptions, "currency" | "propose" | "profiles" | "sampleRows">>
    & {
      limits: StatementLimits
    },
): Promise<Result<InferredProfile, InferFailure>> {
  const read = (profile: StatementProfile) => parsePdfStatement(pages, profile, options.limits)
  for (const profile of options.profiles) {
    if (!profile.pdf) continue
    const statement = read(profile)
    if (isVerified(statement)) return ok({ source: "known", profile, statement })
  }

  const lines = pages.flatMap((page) => page.lines)
  const texts = lines.map((line) => line.text)
  const header = findHeader(texts)
  const start = sampleStart(header)
  // A PDF line has no cell count to confirm a header, so a name right above the first row could
  // pass for one: every PDF line is masked whole, and the model reads the columns from positions.
  const masked = lines.slice(start, start + checkSampleRows(options.sampleRows)).map(maskPdfLine)
  const reply = await ask(options.propose, profilePrompt(masked, { pdf: true }), pdfProposal)
  if (!reply.ok) return reply
  const proposal = reply.value
  const layout = proposal.pdf as NonNullable<ProfileProposal["pdf"]>
  const columns = "columns" in layout
    ? layout.columns.length
    : layout.pattern.filter((token) => !("literal" in token)).length
  const profile = completeProposal(proposal, {
    currency: options.currency,
    encoding: "utf-8",
    delimiter: ",",
    headerLine: 1,
    fingerprint: { headers: [], columns, delimiter: "," },
  })
  // A pattern needs the formats to cut a line into cells, so every format the words allow is
  // tried rather than detected from cells first.
  const words = lines.slice(0, SCAN_LINES * 10).flatMap((line) =>
    line.words.map((word) => word.text)
  )
  const patterns = DATE_PATTERNS.filter((pattern) =>
    words.some((word) => detectDatePatterns([word]).includes(pattern))
  )
  return tryFormats(profile, patterns, NUMBER_FORMATS, read)
}

/** The fields of a profile the model does not propose. */
type LocalFields =
  & Pick<
    StatementProfile,
    "encoding" | "delimiter" | "headerLine" | "fingerprint"
  >
  & { currency: string }

/** A profile from a proposal, with a placeholder date pattern and number format. */
function completeProposal(proposal: ProfileProposal, local: LocalFields): StatementProfile {
  const { amount, currency } = proposal
  const profile: StatementProfile = {
    id: uuidV7(),
    name: "Proposed profile",
    encoding: local.encoding,
    delimiter: local.delimiter,
    headerLine: local.headerLine,
    date: { column: proposal.date.column, pattern: DATE_PATTERNS[0] },
    // Rebuilt field by field, so a key the reply added inside an object is not stored.
    amount: "column" in amount
      ? { column: amount.column }
      : { debit: amount.debit, credit: amount.credit },
    numberFormat: { ...NUMBER_FORMATS[0] },
    negatives: [...NEGATIVE_STYLES],
    // The model sees every code masked, so only a column is taken from it.
    currency: currency && "column" in currency
      ? { column: currency.column }
      : { code: local.currency },
    fingerprint: local.fingerprint,
  }
  for (
    const key of [
      "payee",
      "description",
      "reference",
      "balance",
      "originalAmount",
      "originalCurrency",
    ] as const
  ) {
    if (proposal[key] !== undefined) profile[key] = proposal[key]
  }
  if (proposal.pdf) profile.pdf = proposal.pdf
  return profile
}

/**
 * The first pairing of a date pattern and a number format with which `profile` reads the file and
 * verifies. When none does, the failure of the first pairing.
 */
function tryFormats(
  profile: StatementProfile,
  patterns: readonly DatePattern[],
  formats: readonly Readonly<NumberFormatGuess>[],
  read: (profile: StatementProfile) => ParsedStatement,
): Result<InferredProfile, InferFailure> {
  if (patterns.length === 0) {
    return err({ code: "invalid-reply", message: "the proposed date column holds no dates" })
  }
  if (formats.length === 0) {
    return err({ code: "invalid-reply", message: "the proposed amount columns hold no numbers" })
  }
  // The reply passed its own schema, but the whole profile can still be invalid (a PDF pattern of
  // literals only fills no column), and the readers throw on an invalid profile.
  const checked = statementProfile(profile)
  if (checked instanceof type.errors) {
    return err({ code: "invalid-reply", message: `not a profile: ${checked.summary}` })
  }
  let first: InferFailure | undefined
  for (const pattern of patterns) {
    for (const format of formats) {
      const candidate: StatementProfile = {
        ...profile,
        date: { ...profile.date, pattern },
        numberFormat: { ...format },
      }
      const statement = read(candidate)
      const verification = verifyStatement(statement)
      if (verification.status === "verified") {
        return ok({ source: "model", profile: candidate, statement })
      }
      first ??= statement.rowErrors.length > 0
        ? { code: "parse-errors", profile: candidate, rowErrors: statement.rowErrors }
        : verification.status === "failed"
        ? { code: "failed", profile: candidate, failures: verification.failures }
        : { code: "unverifiable", profile: candidate }
    }
  }
  return err(first as InferFailure)
}

/** Ask the port once and check its reply against `schema`. */
async function ask(
  propose: ProposeProfile,
  prompt: string,
  schema: Type<ProfileProposal>,
): Promise<Result<ProfileProposal, InferFailure>> {
  const reply = await propose({ prompt, schema })
  if (reply === null || reply === undefined) {
    return err({ code: "invalid-reply", message: "the model gave no reply" })
  }
  const checked = schema(reply)
  if (checked instanceof type.errors) {
    return err({ code: "invalid-reply", message: `not a profile: ${checked.summary}` })
  }
  return ok(checked)
}

const isVerified = (statement: ParsedStatement) => verifyStatement(statement).status === "verified"

/** The cells of one CSV line, or none when it does not parse. */
function csvCells(line: string, delimiter: string): string[] {
  const parsed = parseCsv(line, { delimiter })
  return parsed.ok ? parsed.value[0] ?? [] : []
}

/** Where the sample starts: a few lines above the header, so the model sees what precedes it. */
const sampleStart = (header: number | undefined) => Math.max(0, (header ?? 0) - 3)

/** Settings for {@link maskSample}. */
export interface MaskSampleOptions {
  /**
   * The 0-based index in `lines` of the header row, whose column-name words keep their letters.
   * A header with a piece that reads as a date or an amount is masked like a data row.
   */
  headerRow?: number
  /** Most lines returned. Default {@link DEFAULT_SAMPLE_ROWS}, 20. */
  maxRows?: number
}

/**
 * The first `maxRows` of `lines`, masked so that no value leaves the host: every digit (any
 * Unicode number) becomes `9`, every upper- or title-case letter `X`, and every other letter, mark,
 * other symbol (an emoji, a circled letter), format character (invisible tag characters can spell
 * text), lone surrogate, private-use or unassigned code point, and line or paragraph separator `x`.
 * Spaces, punctuation, separators, control characters and currency signs stay, and every line
 * keeps its length in code points. In the header row, a word that is a column name from a fixed
 * vocabulary ("Datum", "Betrag", "Saldo", "Дата") keeps its letters; every other word, and every
 * digit, is masked.
 */
export function maskSample(lines: readonly string[], options: MaskSampleOptions = {}): string[] {
  const { headerRow } = options
  return lines.slice(0, checkSampleRows(options.maxRows)).map((line, index) =>
    maskText(line, index === headerRow && !hasValue(line))
  )
}

function checkSampleRows(rows = DEFAULT_SAMPLE_ROWS): number {
  if (!Number.isInteger(rows) || rows < 1) {
    throw new RangeError(`sample rows must be a positive integer, got ${rows}`)
  }
  return rows
}

/**
 * What is masked: numbers, letters, marks, other symbols, format characters, lone surrogates,
 * private-use and unassigned code points, and line and paragraph separators.
 */
const MASKED = /[\p{N}\p{L}\p{M}\p{So}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu

/** A run of letters and marks, or a run of anything else. */
const RUNS = /[\p{L}\p{M}]+|[^\p{L}\p{M}]+/gu

/** `text` masked; with `keepHeaderWords`, a word that {@link isHeaderWord} accepts stays. */
function maskText(text: string, keepHeaderWords: boolean): string {
  return text.replace(RUNS, (run) =>
    keepHeaderWords && isHeaderWord(run) ? run : run.replace(
      MASKED,
      (char) => /\p{N}/u.test(char) ? "9" : /[\p{Lu}\p{Lt}]/u.test(char) ? "X" : "x",
    ))
}

/** A PDF line for the prompt: each word's left and right edge in points, and its masked text. */
function maskPdfLine(line: PdfLine): string {
  return JSON.stringify(
    line.words.map((word) => [
      Math.round(word.x),
      Math.round(word.x + word.width),
      maskText(word.text, false),
    ]),
  )
}

/**
 * The pieces of a line that could be a value: each cell between common delimiters, and each run
 * of one to three words in it, quotes trimmed.
 */
function pieces(line: string): string[] {
  return line.split(/[,;\t|]/).flatMap((cell) => {
    const trimmed = cell.trim().replace(/^"|"$/g, "").trim()
    const words = trimmed.split(/\s+/).filter((word) => word !== "")
    const runs = words.flatMap((_, at) =>
      [1, 2, 3].filter((length) => at + length <= words.length)
        .map((length) => words.slice(at, at + length).join(" "))
    )
    return trimmed === "" ? runs : [trimmed, ...runs]
  })
}

const isDate = (piece: string) => detectDatePatterns([piece]).length > 0
const isAmount = (piece: string) => detectNumberFormat([piece]).length > 0

/** Whether any piece of `line` reads as a date or an amount. */
function hasValue(line: string): boolean {
  return pieces(line).some((piece) => isDate(piece) || isAmount(piece))
}

/** Whether `line` looks like a transaction: a date and, apart from it, an amount. */
function isDataLine(line: string): boolean {
  const all = pieces(line)
  return all.some(isDate) && all.some((piece) => !isDate(piece) && isAmount(piece))
}

/**
 * The index of the header row: the line right above the first transaction, when it holds at least
 * two cells or words and no value, and, with `cellCount`, as many cells as that transaction.
 * `undefined` when there is none, and then every line is masked whole. The guess can be wrong (a
 * name line between the header and the first row), so only column-name words of it stay.
 */
function findHeader(
  lines: readonly string[],
  cellCount?: (line: string) => number,
): number | undefined {
  const first = lines.slice(0, SCAN_LINES).findIndex(isDataLine)
  if (first < 1) return undefined
  const header = lines[first - 1]
  const count = cellCount ? cellCount(header) : header.trim().split(/\s+/).length
  if (count < 2 || hasValue(header)) return undefined
  if (cellCount && count !== cellCount(lines[first])) return undefined
  return first - 1
}

/** Settings for {@link profilePrompt}. */
export interface ProfilePromptOptions {
  /** The file line of the sample's first line, 1-based. Default 1. */
  firstLine?: number
  /** The sample is PDF lines from {@link inferProfile}, so the model proposes a `pdf` layout. */
  pdf?: boolean
}

/**
 * The prompt that asks a model for a profile's structure from a masked sample: it says how the
 * sample was masked, names each field of the reply, and contains the word "json" and an example
 * reply, as DeepSeek's JSON mode requires.
 */
export function profilePrompt(
  masked: readonly string[],
  options: ProfilePromptOptions = {},
): string {
  const { firstLine = 1, pdf = false } = options
  const intro = pdf
    ? `The sample below is the start of a bank statement PDF, one line per row. Each row lists its
words as [left, right, text], with the edges in points from the left of the page.`
    : `The sample below is the start of a bank statement exported as CSV. Its first line is line ${firstLine} of the file.`
  const structure = pdf
    ? `- "pdf": how a line becomes columns. Either {"columns": [{"from": left, "to": right}, ...]},
  where a word belongs to the column its left edge falls in, or {"pattern": [token, ...]}, where a
  token is {"type": "date"}, {"type": "amount"}, {"type": "text"} or {"literal": "words"} and each
  token but a literal fills the next column.`
    : `- "delimiter": the field separator, one of ",", ";", "\\t" or "|".
- "headerLine": the 1-based file line of the row with the column names.`
  const example = pdf
    ? `{"pdf": {"pattern": [{"type": "date"}, {"type": "text"}, {"type": "amount"}, {"type": "amount"}]}, "date": {"column": 0}, "description": 1, "amount": {"column": 2}, "balance": 3}`
    : `{"delimiter": ";", "headerLine": 1, "date": {"column": 0}, "payee": 1, "description": 2, "amount": {"debit": 3, "credit": 4}, "balance": 5}`
  return `You read the layout of bank statements and answer with one json object.

${intro} To keep it private, every letter became x or X and every digit 9, except the column-name
words of the header row; spaces, separators and quotes are as in the file.

<sample>
${masked.join("\n")}
</sample>

Answer with a json object with these fields. Column numbers count from 0.
${structure}
- "date": {"column": n}, the booking date.
- "amount": {"column": n} for one signed amount, or {"debit": n, "credit": n} for separate
  money-out and money-in columns.
- "balance": n, the account balance after each row.
- "payee", "description", "reference": n each.
- "currency": {"column": n} when a column holds currency codes.
- "originalAmount", "originalCurrency": n each, the amount before conversion and its currency.
Leave out every field the statement does not have. Do not give date or number formats.

Example json:
${example}
`
}
