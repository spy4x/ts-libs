/**
 * OFX and QFX: OFX 1 (SGML, where a value's tag never closes) and OFX 2 (XML).
 *
 * @module
 */

import { childElement, childElements, textContent, type XmlElement } from "@spy4x/caldav/xml"
import { isCurrencyCode } from "@spy4x/platform/universal/money-core"
import {
  checkRowCount,
  checkTextSize,
  definedOnly,
  linesAt,
  openingTagOffsets,
  type ParsedStatement,
  quote,
  readDecimal,
  readIsoDate,
  readXml,
  type RowError,
  StatementError,
  type StatementLimits,
  type StatementRow,
} from "./statement.ts"

/** How deep OFX 1 aggregates may nest, as `@spy4x/caldav/xml` allows for OFX 2. */
const MAX_DEPTH = 64

/**
 * Read an OFX or QFX file: its transactions (`STMTTRN`), in the statement currency (`CURDEF`), and
 * its closing balance (`LEDGERBAL`). OFX states no opening balance, so a statement without row
 * balances verifies as `"unverifiable"`. A file holding more than one account is refused as
 * `"unsupported"`, rather than mixing accounts in one list.
 */
export function parseOfx(
  text: string,
  limits: StatementLimits = {},
): ParsedStatement {
  checkTextSize(text, limits.maxBytes)
  const root = text.trimStart().startsWith("<?xml")
    ? readXml(text, limits.maxBytes)
    : sgmlTree(text)

  const statements: XmlElement[] = []
  collect(root, statements)
  if (statements.length === 0) {
    throw new StatementError("malformed", "no OFX statement found")
  }
  if (statements.length > 1) {
    throw new StatementError(
      "unsupported",
      `file holds ${statements.length} statements`,
    )
  }
  const [statement] = statements
  const currency = leaf(statement, "CURDEF")
  if (!isCurrencyCode(currency)) {
    throw new StatementError(
      "malformed",
      `unknown currency ${quote(currency)}`,
    )
  }

  const list = childElement(statement, "", "BANKTRANLIST")
  const transactions = list ? childElements(list, "", "STMTTRN") : []
  checkRowCount(transactions.length, limits.maxRows)
  const lines = linesAt(text, openingTagOffsets(text, "STMTTRN"))
  const rows: StatementRow[] = []
  const rowErrors: RowError[] = []
  for (const [index, transaction] of transactions.entries()) {
    const line = lines[index] ?? 0
    const date = readIsoDate(leaf(transaction, "DTPOSTED"), true)
    const amount = readDecimal(leaf(transaction, "TRNAMT"), currency)
    if (!date) rowErrors.push({ line, reason: "no valid DTPOSTED date" })
    else if (!amount.ok) rowErrors.push({ line, reason: amount.error })
    else {
      rows.push(definedOnly({
        line,
        date,
        amount: amount.value,
        currency,
        payee: leaf(transaction, "NAME") ||
          leaf(childElement(transaction, "", "PAYEE"), "NAME"),
        memo: leaf(transaction, "MEMO"),
        reference: leaf(transaction, "FITID"),
        originalCurrency: leaf(
          childElement(transaction, "", "ORIGCURRENCY"),
          "CURSYM",
        ),
      }))
    }
  }

  const statementResult: ParsedStatement = { format: "ofx", rows, rowErrors }
  const ledger = childElement(statement, "", "LEDGERBAL")
  if (ledger) {
    const balance = readDecimal(leaf(ledger, "BALAMT"), currency)
    const [line] = linesAt(
      text,
      openingTagOffsets(text, "LEDGERBAL").slice(0, 1),
    )
    if (!balance.ok) {
      rowErrors.push({ line, reason: `closing balance: ${balance.error}` })
    } else statementResult.closingBalance = { amount: balance.value, line }
  }
  return statementResult
}

/** Every bank (`STMTRS`) and credit card (`CCSTMTRS`) statement under `element`. */
function collect(element: XmlElement, found: XmlElement[]): void {
  for (const child of element.children) {
    if (typeof child === "string") continue
    if (child.name === "STMTRS" || child.name === "CCSTMTRS") found.push(child)
    else collect(child, found)
  }
}

/** The trimmed text of `element`'s child named `name`, or `""`. */
function leaf(element: XmlElement | undefined, name: string): string {
  const child = element && childElement(element, "", name)
  return child ? textContent(child).trim() : ""
}

/**
 * OFX 1 SGML as a tree of the same shape `@spy4x/caldav/xml` returns. A tag followed by text is a
 * value; a tag followed by another tag is an aggregate when the file closes it somewhere, and an
 * empty value otherwise. One forward pass with `indexOf`, so time is linear in the input.
 */
function sgmlTree(text: string): XmlElement {
  const start = text.indexOf("<OFX>")
  if (start === -1) {
    throw new StatementError("malformed", "no <OFX> element found")
  }
  const closed = new Set<string>()
  for (
    let at = text.indexOf("</", start);
    at !== -1;
    at = text.indexOf("</", at + 2)
  ) {
    // Look only as far as a tag name can reach, so `</</</…` costs one pass, not one per `</`.
    const end = text.slice(at, at + 67).indexOf(">")
    if (end !== -1) closed.add(text.slice(at + 2, at + end))
  }

  const root: XmlElement = {
    namespace: "",
    name: "",
    attributes: [],
    children: [],
  }
  const stack = [root]
  let at = start
  while (at < text.length) {
    const end = text.indexOf(">", at)
    if (end === -1) throw new StatementError("malformed", "a tag never closes")
    const tag = text.slice(at + 1, end)
    const next = text.indexOf("<", end)
    const value = decodeSgml(
      text.slice(end + 1, next === -1 ? text.length : next).trim(),
    )
    at = next === -1 ? text.length : next
    if (tag.startsWith("/")) {
      const depth = stack.findLastIndex((element) => element.name === tag.slice(1))
      if (depth > 0) stack.length = depth
      continue
    }
    if (!/^[A-Za-z0-9.]{1,64}$/.test(tag)) {
      throw new StatementError("malformed", `bad tag ${quote(tag)}`)
    }
    const element: XmlElement = {
      namespace: "",
      name: tag,
      attributes: [],
      children: value ? [value] : [],
    }
    stack[stack.length - 1].children.push(element)
    if (value === "" && closed.has(tag)) {
      if (stack.length > MAX_DEPTH) {
        throw new StatementError("too-large", "nested too deep")
      }
      stack.push(element)
    }
  }
  return root
}

/** The three entities OFX 1 uses. */
function decodeSgml(value: string): string {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll(
    "&amp;",
    "&",
  )
}
