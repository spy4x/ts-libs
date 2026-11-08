/**
 * Writes the synthetic PDF fixtures: `statement.pdf`, `scanned.pdf` and `encrypted.pdf`. Every
 * byte is built here, from made-up rows, so no real statement and no PDF tool is involved.
 *
 * ```bash
 * deno run --allow-write=bank-statements/fixtures bank-statements/fixtures/make-pdfs.ts
 * ```
 *
 * @module
 */

import { crypto } from "@std/crypto"

/** One PDF object's body, numbered from 1 in array order. */
type PdfObject = string

/**
 * A complete PDF file of `objects`, with its cross-reference table. Object 1 is the catalog.
 * Strings are Latin-1, one byte per character, so a stream's `/Length` is its string length.
 */
function pdfFile(objects: PdfObject[], trailerExtra = ""): Uint8Array {
  let body = "%PDF-1.4\n"
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(body.length)
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\n`
  body += `startxref\n${xref}\n%%EOF\n`
  return Uint8Array.from(body, (char) => char.charCodeAt(0))
}

/** A stream object holding `content`. */
function stream(content: string, dictionary = ""): PdfObject {
  return `<< /Length ${content.length} ${dictionary}>>\nstream\n${content}\nendstream`
}

/** Text drawn with Helvetica 10 at (`x`, `y`), PDF points from the bottom left. */
function text(x: number, y: number, value: string): string {
  return `BT /F1 10 Tf ${x} ${y} Td (${value}) Tj ET\n`
}

/** A page's statement rows: date, description, amount, balance, each at its own x. */
function rows(lines: string[][], top: number): string {
  return lines.map(([date, description, amount, balance], index) => {
    const y = top - index * 16
    // Amounts are right-aligned, as banks print them: a longer number starts further left.
    return text(50, y, date) + text(130, y, description) +
      text(400 - amount.length * 5, y, amount) + text(500 - balance.length * 5, y, balance)
  }).join("")
}

/**
 * Pages of `contents`, each a content stream on a US Letter page with Helvetica as `/F1` and
 * the given extra resources. Objects: catalog, pages, font, then a page and its content per page.
 */
function document(contents: string[], resources = "", extraObjects: PdfObject[] = []): PdfObject[] {
  const first = 4 + extraObjects.length
  const kids = contents.map((_, index) => `${first + index * 2} 0 R`).join(" ")
  return [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ...extraObjects,
    ...contents.flatMap((content, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${
        first + index * 2 + 1
      } 0 R /Resources << /Font << /F1 3 0 R >> ${resources}>> >>`,
      stream(content),
    ]),
  ]
}

/** The text statement: two pages, a running balance on every row, from 1,000.00 opening. */
export function statementPdf(): Uint8Array {
  const header = text(50, 750, "Example Bank") + text(50, 734, "Statement January 2026") +
    text(50, 700, "Date") + text(130, 700, "Description") + text(360, 700, "Amount") +
    text(450, 700, "Balance")
  return pdfFile(document([
    header + rows([
      ["02.01.2026", "Salary", "2,500.00", "3,500.00"],
      ["03.01.2026", "Coffee Shop", "-4.50", "3,495.50"],
      ["05.01.2026", "Rent January", "-1,200.00", "2,295.50"],
    ], 680) + text(50, 40, "Page 1 of 2"),
    text(50, 750, "Example Bank") + rows([
      ["07.01.2026", "Grocery Store", "-85.20", "2,210.30"],
      ["09.01.2026", "Refund Online Shop", "19.99", "2,230.29"],
    ], 700) + text(50, 40, "Page 2 of 2"),
  ]))
}

/** A scan: one page that paints a grey image and has no text at all. */
export function scannedPdf(): Uint8Array {
  const pixels = "\x40\x80\xc0\xff"
  const image = stream(
    pixels,
    "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 ",
  )
  return pdfFile(
    document(["q 400 0 0 500 100 150 cm /Im1 Do Q\n"], "/XObject << /Im1 4 0 R >> ", [image]),
  )
}

/** The 32 padding bytes of the PDF standard security handler. */
const PASSWORD_PADDING = Uint8Array.from([
  0x28,
  0xbf,
  0x4e,
  0x5e,
  0x4e,
  0x75,
  0x8a,
  0x41,
  0x64,
  0x00,
  0x4e,
  0x56,
  0xff,
  0xfa,
  0x01,
  0x08,
  0x2e,
  0x2e,
  0x00,
  0xb6,
  0xd0,
  0x68,
  0x3e,
  0x80,
  0x2f,
  0x0c,
  0xa9,
  0xfe,
  0x64,
  0x53,
  0x69,
  0x7a,
])

/** RC4, which revision 2 of the standard security handler encrypts with. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, index) => index)
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = new Uint8Array(data.length)
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    ;[s[i], s[j]] = [s[j], s[i]]
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

/** `password` padded to 32 bytes, as the security handler wants it. */
function padded(password: string): Uint8Array {
  const out = new Uint8Array(32)
  const bytes = new TextEncoder().encode(password).subarray(0, 32)
  out.set(bytes)
  out.set(PASSWORD_PADDING.subarray(0, 32 - bytes.length), bytes.length)
  return out
}

/** The MD5 digest of the concatenated `parts`. */
async function md5(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return new Uint8Array(await crypto.subtle.digest("MD5", all))
}

/** Bytes as a PDF hex string. */
const hex = (bytes: Uint8Array) =>
  `<${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}>`

/**
 * The text statement's first page behind the user password `secret` (standard security
 * handler, revision 2, 40-bit RC4), so a reader without the password cannot open it.
 */
export async function encryptedPdf(): Promise<Uint8Array> {
  const id = new TextEncoder().encode("synthetic-fixture")
  const permissions = -4 // Every permission granted; the password alone keeps the file shut.
  const owner = rc4((await md5(padded("owner"))).subarray(0, 5), padded("secret"))
  const p = new Uint8Array(4)
  new DataView(p.buffer).setInt32(0, permissions, true)
  const key = (await md5(padded("secret"), owner, p, id)).subarray(0, 5)
  const user = rc4(key, PASSWORD_PADDING)
  const objects = document([text(50, 750, "Example Bank")])
  objects.push(
    `<< /Filter /Standard /V 1 /R 2 /O ${hex(owner)} /U ${hex(user)} /P ${permissions} >>`,
  )
  return pdfFile(objects, `/Encrypt ${objects.length} 0 R /ID [${hex(id)} ${hex(id)}] `)
}

if (import.meta.main) {
  const folder = new URL("./", import.meta.url)
  await Deno.writeFile(new URL("statement.pdf", folder), statementPdf())
  await Deno.writeFile(new URL("scanned.pdf", folder), scannedPdf())
  await Deno.writeFile(new URL("encrypted.pdf", folder), await encryptedPdf())
}
