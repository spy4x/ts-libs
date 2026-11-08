/**
 * ISO 20022 CAMT.053, the bank-to-customer statement most European banks export as XML.
 *
 * @module
 */

import { childElement, childElements, textContent, type XmlElement } from "@spy4x/caldav/xml"
import { err, ok, type Result } from "@spy4x/platform/universal/result"
import {
  checkRowCount,
  checkTextSize,
  definedOnly,
  linesAt,
  openingTagOffsets,
  type ParsedStatement,
  readDecimal,
  readIsoDate,
  readXml,
  type RowError,
  StatementError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** Every CAMT.053 version's namespace starts with this. */
const CAMT053_NS = "urn:iso:std:iso:20022:tech:xsd:camt.053."

/**
 * Read a CAMT.053 file: its booked entries (`Ntry` with status `BOOK`; pending and informational
 * ones are not in the balances, so they are left out), its opening balance (`OPBD`, or `PRCD`, the
 * previous closing) and its closing balance (`CLBD`). A file with a DTD is refused as
 * `"forbidden"` before any entry is read; a file holding more than one statement as
 * `"unsupported"`.
 */
export function parseCamt053(
  text: string,
  limits: StatementLimits = {},
): ParsedStatement {
  checkTextSize(text, limits.maxBytes)
  const document = readXml(text, limits.maxBytes)
  const ns = document.namespace
  if (!ns.startsWith(CAMT053_NS) || document.name !== "Document") {
    throw new StatementError("malformed", "not a CAMT.053 document")
  }
  const statements = childElements(
    child(document, ns, "BkToCstmrStmt"),
    ns,
    "Stmt",
  )
  if (statements.length !== 1) {
    throw new StatementError(
      statements.length === 0 ? "malformed" : "unsupported",
      `file holds ${statements.length} statements`,
    )
  }
  const [statement] = statements
  const result: ParsedStatement = {
    format: "camt053",
    rows: [],
    rowErrors: [],
  }
  const rowErrors: RowError[] = result.rowErrors

  const balanceLines = linesAt(text, openingTagOffsets(text, "Bal"))
  for (
    const [index, balance] of childElements(statement, ns, "Bal").entries()
  ) {
    const type = text1(balance, ns, "Tp", "CdOrPrtry", "Cd")
    if (type !== "OPBD" && type !== "PRCD" && type !== "CLBD") continue
    const line = balanceLines[index] ?? 0
    const amount = signedAmount(balance, ns)
    if (!amount.ok) {
      rowErrors.push({
        line,
        reason: `${type} balance: ${amount.error}`,
      })
    } else if (type === "CLBD") {
      result.closingBalance = {
        amount: amount.value,
        line,
      }
    } else result.openingBalance ??= { amount: amount.value, line }
  }

  const entries = childElements(statement, ns, "Ntry")
  checkRowCount(entries.length, limits.maxRows)
  const lines = linesAt(text, openingTagOffsets(text, "Ntry"))
  for (const [index, entry] of entries.entries()) {
    const status = text1(entry, ns, "Sts", "Cd") || text1(entry, ns, "Sts")
    if (status !== "BOOK") continue
    const line = lines[index] ?? 0
    const date = readIsoDate(
      text1(entry, ns, "BookgDt", "Dt") || text1(entry, ns, "BookgDt", "DtTm"),
      false,
    )
    const amount = signedAmount(entry, ns)
    if (!date) {
      rowErrors.push({ line, reason: "no valid booking date" })
      continue
    }
    if (!amount.ok) {
      rowErrors.push({ line, reason: amount.error })
      continue
    }
    const currency = attribute(child(entry, ns, "Amt"), "Ccy")
    const details = child(child(entry, ns, "NtryDtls"), ns, "TxDtls")
    const party = amount.value < 0 ? "Cdtr" : "Dbtr"
    const row: StatementRow = definedOnly({
      line,
      date,
      amount: amount.value,
      currency,
      payee: text1(details, ns, "RltdPties", party, "Nm") ||
        text1(details, ns, "RltdPties", party, "Pty", "Nm"),
      memo: childElements(child(details, ns, "RmtInf"), ns, "Ustrd")
        .map((element) => textContent(element).trim()).join(" ") ||
        text1(entry, ns, "AddtlNtryInf"),
      reference: text1(entry, ns, "AcctSvcrRef") || text1(entry, ns, "NtryRef"),
    })
    // The amount the payer instructed, when it was in another currency than the booked one.
    const instructed = child(
      child(child(details, ns, "AmtDtls"), ns, "InstdAmt"),
      ns,
      "Amt",
    )
    const originalCurrency = attribute(instructed, "Ccy")
    if (originalCurrency && originalCurrency !== currency) {
      const original = readDecimal(textContent(instructed), originalCurrency)
      if (!original.ok) {
        rowErrors.push({ line, reason: `original amount: ${original.error}` })
        continue
      }
      row.originalAmount = amount.value < 0 ? 0 - original.value : original.value
      row.originalCurrency = originalCurrency
    }
    result.rows.push(row)
  }
  return result
}

/** An empty element, so a missing step in a path reads as empty text instead of throwing. */
const NONE: XmlElement = {
  namespace: "",
  name: "",
  attributes: [],
  children: [],
}

/** The first child of `element` named `name` in `ns`, or an empty element. */
function child(element: XmlElement, ns: string, name: string): XmlElement {
  return childElement(element, ns, name) ?? NONE
}

/** The trimmed text at `path` under `element`, or `""`. */
function text1(element: XmlElement, ns: string, ...path: string[]): string {
  let current = element
  for (const name of path) current = child(current, ns, name)
  return textContent(current).trim()
}

/** The value of attribute `name` on `element`, or `""`. */
function attribute(element: XmlElement, name: string): string {
  return element.attributes.find((item) => item.name === name)?.value.trim() ??
    ""
}

/** `Amt` in minor units of its `Ccy`, negative when `CdtDbtInd` is `DBIT`. */
function signedAmount(element: XmlElement, ns: string): Result<number, string> {
  const amountElement = child(element, ns, "Amt")
  const indicator = text1(element, ns, "CdtDbtInd")
  const amount = readDecimal(
    textContent(amountElement),
    attribute(amountElement, "Ccy"),
  )
  if (!amount.ok) return amount
  if (indicator !== "CRDT" && indicator !== "DBIT") {
    return err("no CdtDbtInd of CRDT or DBIT")
  }
  return ok(indicator === "DBIT" ? 0 - amount.value : amount.value)
}
