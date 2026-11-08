/**
 * Bank statements from PDF: the text layer read with each word's position, grouped into lines,
 * and turned into statement rows by a profile's `pdf` layout. A separate entry, so pdf.js stays
 * out of apps that read only CSV and the standard formats.
 *
 * ```ts
 * import { extractPdfLines, parsePdfStatement } from "@spy4x/bank-statements/pdf"
 * import { type StatementProfile, verifyStatement } from "@spy4x/bank-statements"
 *
 * declare const upload: Uint8Array
 * declare const profile: StatementProfile // with `pdf: { pattern: [...] }` or `pdf: { columns: [...] }`
 *
 * const lines = await extractPdfLines(upload)
 * if (!lines.ok) throw new Error(lines.error.message) // "This PDF is a scanned image. …"
 * const check = verifyStatement(parsePdfStatement(lines.value, profile))
 * ```
 *
 * The file comes from a stranger. `maxBytes` (10 MiB) is checked before pdf.js sees it and also
 * caps the text read, `maxPages` (50) is checked before any page's text is read, and `maxLines`
 * (100,000) caps the lines. pdf.js loads with `isEvalSupported: false` and renders nothing. A
 * line pattern is a list of typed tokens, never a regular expression, and is matched in one pass.
 *
 * @module
 */

import { getDocumentProxy } from "unpdf"
import {
  type ExtractPdfLinesOptions,
  type OpenPdf,
  type PdfDocument,
  type PdfPage,
  type PdfRefusal,
  readPdfLines,
} from "./pdf-read.ts"
import type { Result } from "@spy4x/platform/universal/result"

export {
  DEFAULT_MAX_PAGES,
  type ExtractPdfLinesOptions,
  NO_TEXT_LAYER_MESSAGE,
  parsePdfStatement,
  type PdfLine,
  type PdfPage,
  type PdfRefusal,
  type PdfRefusalCode,
  type PdfWord,
} from "./pdf-read.ts"

const openWithUnpdf: OpenPdf = async (data, options) =>
  await getDocumentProxy(data, options as Parameters<typeof getDocumentProxy>[1]) as PdfDocument

/**
 * The lines of every page of a PDF, top to bottom, each line's words left to right with their x.
 * Words whose baselines sit within 2 points of each other are one line. A refusal comes back as
 * an error, never a throw: `"too-large"`, `"encrypted"`, `"no-text-layer"` (a scan, with
 * {@link NO_TEXT_LAYER_MESSAGE}) or `"malformed"`.
 */
export function extractPdfLines(
  bytes: Uint8Array,
  options: ExtractPdfLinesOptions = {},
): Promise<Result<PdfPage[], PdfRefusal>> {
  return readPdfLines(bytes, options, openWithUnpdf)
}
