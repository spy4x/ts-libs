/**
 * Telling a statement's format by its content, and reading a file of any supported format.
 *
 * @module
 */

import { decodeTextFile, type SingleByteEncoding, sniffCsv } from "@spy4x/platform/universal/csv"
import { parseCamt053 } from "./camt053.ts"
import { parseMt940 } from "./mt940.ts"
import { parseOfx } from "./ofx.ts"
import { parseWithProfile, type StatementProfile } from "./profile.ts"
import { parseQif } from "./qif.ts"
import {
  DEFAULT_MAX_BYTES,
  type ParsedStatement,
  StatementError,
  type StatementFormat,
  type StatementLimits,
} from "./statement.ts"

/** How many bytes {@link detectFormat} looks at. */
const HEAD_BYTES = 65_536

/**
 * The format of a statement file, decided by its content, never by its name: `"%PDF-"` is a PDF,
 * `OFXHEADER:` or an `<OFX>` element is OFX or QFX, an XML `Document` in a CAMT.053 namespace is
 * CAMT.053, `!Type:` is QIF, `:20:` with a `:60F:` balance is MT940, and text that splits into
 * the same number of columns on most lines is CSV. Only the first 64 KiB are read.
 */
export function detectFormat(bytes: Uint8Array): StatementFormat {
  const head = bytes.subarray(0, HEAD_BYTES)
  if (new TextDecoder().decode(head.subarray(0, 5)) === "%PDF-") return "pdf"
  const text = decodeTextFile(head).text.trimStart()
  if (text.includes("\0")) return "unknown"
  const upper = text.slice(0, 4096).toUpperCase()
  if (
    upper.startsWith("OFXHEADER:") || upper.includes("<OFX>") ||
    upper.includes("<?OFX")
  ) {
    return "ofx"
  }
  if (text.startsWith("<")) {
    return text.includes("urn:iso:std:iso:20022:tech:xsd:camt.053.") ? "camt053" : "unknown"
  }
  if (
    upper.startsWith("!TYPE:") || upper.startsWith("!ACCOUNT") ||
    upper.startsWith("!OPTION")
  ) {
    return "qif"
  }
  if (/^(\{1:|:20:)/.test(text) && /^:6[02][FM]:/m.test(text)) return "mt940"
  const lines = text.split("\n", 3)
  const { delimiter } = sniffCsv(text)
  return lines.length > 1 && lines[0].includes(delimiter) ? "csv" : "unknown"
}

/** Settings for {@link readStatement}. */
export interface ReadStatementOptions extends StatementLimits {
  /** How to read a CSV file; {@link matchProfile} or {@link guessProfile} finds one. */
  profile?: StatementProfile
  /** The account's currency, for a QIF file, which names none. */
  currency?: string
}

/**
 * Read a statement file of any supported format. `maxBytes` is checked before anything is
 * decoded, `maxRows` before any row is read. A CSV file needs `options.profile` and a QIF file
 * `options.currency`; without them, and for a PDF or an unknown format, it throws a
 * {@link StatementError} with code `"unsupported"`.
 */
export function readStatement(
  bytes: Uint8Array,
  options: ReadStatementOptions = {},
): ParsedStatement {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  if (bytes.length > maxBytes) {
    throw new StatementError("too-large", `file is over ${maxBytes} bytes`)
  }
  const format = detectFormat(bytes)
  const encoding = options.profile?.encoding
  const fallback = encoding && !encoding.startsWith("utf")
    ? encoding as SingleByteEncoding
    : undefined
  const { text } = decodeTextFile(bytes, { fallback })
  // The bytes passed the limit already; one byte decodes to at most three UTF-8 bytes of text.
  const limits = { maxBytes: maxBytes * 3, maxRows: options.maxRows }
  switch (format) {
    case "ofx":
      return parseOfx(text, limits)
    case "camt053":
      return parseCamt053(text, limits)
    case "mt940":
      return parseMt940(text, limits)
    case "qif":
      if (!options.currency) {
        throw new StatementError("unsupported", "a QIF file needs a currency")
      }
      return parseQif(text, { ...limits, currency: options.currency })
    case "csv":
      if (!options.profile) {
        throw new StatementError("unsupported", "a CSV file needs a profile")
      }
      return parseWithProfile(text, options.profile, limits)
    default:
      throw new StatementError("unsupported", `cannot read a ${format} file`)
  }
}
