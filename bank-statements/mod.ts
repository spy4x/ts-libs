/**
 * Bank statements read into dated, signed amounts in minor units, and checked against their own
 * balances.
 *
 * Standard formats need nothing else: OFX and QFX ({@link parseOfx}), QIF ({@link parseQif}),
 * CAMT.053 ({@link parseCamt053}) and MT940 ({@link parseMt940}). A bank's own CSV is read through
 * a {@link StatementProfile}, which describes its format as data ({@link parseWithProfile}). A
 * PDF statement is read by the `@spy4x/bank-statements/pdf` entry, through a profile's `pdf`
 * layout; it is a separate entry so that pdf.js stays out of apps that do not read PDF.
 * {@link readStatement} takes the uploaded bytes, checks the size limits, tells the format by
 * content ({@link detectFormat}) and calls the right parser. {@link verifyStatement} then checks
 * the result, and a failure names the lines that do not add up.
 *
 * ```ts
 * import {
 *   builtInProfiles,
 *   detectFormat,
 *   matchProfile,
 *   readStatement,
 *   verifyStatement,
 * } from "@spy4x/bank-statements"
 *
 * const bytes = new TextEncoder().encode("Date,Description,Amount,Currency,Balance\n")
 * const profile = detectFormat(bytes) === "csv"
 *   ? matchProfile(new TextDecoder().decode(bytes), builtInProfiles)[0]?.profile
 *   : undefined
 * const statement = readStatement(bytes, { profile, currency: "EUR" })
 * const check = verifyStatement(statement) // "unverifiable": no rows, so no balance to check
 * ```
 *
 * The file comes from a stranger, so `maxBytes` (10 MiB) and `maxRows` (100,000) are on by
 * default, the XML formats refuse a DTD, and no parser runs a regular expression that can
 * backtrack over the whole input. A file refused whole throws a {@link StatementError}; a row that
 * does not read becomes a row error with its line, and a statement with one never verifies.
 *
 * @module
 */

export { parseCamt053 } from "./camt053.ts"
export { detectFormat, readStatement, type ReadStatementOptions } from "./detect.ts"
export { parseMt940 } from "./mt940.ts"
export { parseOfx } from "./ofx.ts"
export {
  foldHeader,
  parseWithProfile,
  type PdfColumnRange,
  type PdfToken,
  type StatementPdfLayout,
  type StatementProfile,
  statementProfile,
} from "./profile.ts"
export { builtInProfiles, guessProfile, matchProfile, type ProfileMatch } from "./profiles.ts"
export { parseQif, type ParseQifOptions } from "./qif.ts"
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ROWS,
  type ParsedStatement,
  type RowError,
  type StatementBalance,
  StatementError,
  type StatementErrorCode,
  type StatementFormat,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"
export { type BalanceFailure, type Verification, verifyStatement } from "./verify.ts"
