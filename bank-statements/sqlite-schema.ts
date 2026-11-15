/**
 * Counts a SQLite file's schema entries (the rows of `sqlite_master`) from its bytes, before SQLite
 * opens it. Written from the file format (https://www.sqlite.org/fileformat2.html); internal to
 * this package, exported from no entry.
 *
 * @module
 */

import { StatementError } from "./statement.ts"

/**
 * The most schema entries a file may have: tables, indexes, views and triggers. SQLite loads the
 * whole schema when it opens a file, before any check can run, and that load slows with the square
 * of the number of views: 100,000 views take 14.5 s in native `sqlite3`. A real Actual budget has
 * about 100 entries, so 1,000 leaves room for its growth while the load stays in milliseconds.
 */
export const MAX_SCHEMA_ENTRIES = 1_000

/**
 * The most pages of the schema's b-tree the walk visits. Every page but the root holds at least
 * one entry or one child in a file SQLite wrote, so a schema within {@link MAX_SCHEMA_ENTRIES} needs
 * at most twice as many pages.
 */
export const MAX_SCHEMA_PAGES = 2 * MAX_SCHEMA_ENTRIES

/**
 * The most bytes the schema's rows may hold together, their SQL text included. SQLite parses each
 * view's SQL into memory on open: one view of 120 MB of `VALUES` fills sql.js's 2 GiB heap, which
 * never shrinks. A real Actual schema is tens of KiB.
 */
export const MAX_SCHEMA_BYTES = 1 << 20

/** The deepest b-tree SQLite itself walks (`BTCURSOR_MAX_DEPTH`). */
const MAX_DEPTH = 20

/** A b-tree page that holds rows. */
const LEAF_TABLE = 0x0d
/** A b-tree page that points to other pages of a table. */
const INTERIOR_TABLE = 0x05

/**
 * Throws unless `file`'s schema has at most {@link MAX_SCHEMA_ENTRIES} entries: `"too-large"` past
 * that or past {@link MAX_SCHEMA_PAGES} pages, `"malformed"` when its pages are inconsistent. Only
 * page headers and the child pointers of interior pages are read, each page at most once, so the
 * walk reads at most {@link MAX_SCHEMA_PAGES} pages and one child pointer per page it visits.
 * `file` starts with SQLite's 16-byte magic, checked by the caller.
 */
export function checkSchemaSize(file: Uint8Array): void {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const fail = (reason: string): never => {
    throw new StatementError("malformed", `db.sqlite is not a valid SQLite database: ${reason}`)
  }
  if (file.length < 100) fail("its header is cut short")
  const sizeField = view.getUint16(16)
  const pageSize = sizeField === 1 ? 65536 : sizeField
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) {
    fail(`page size ${sizeField} is not a power of two from 512 to 65536`)
  }
  const usable = pageSize - file[20]
  if (usable < 480) fail(`only ${usable} bytes of each page are usable`)
  const pageCount = Math.floor(file.length / pageSize)

  const visited = new Set<number>([1])
  let entries = 0
  let schemaBytes = 0
  const visit = (page: number, depth: number): void => {
    if (depth > MAX_DEPTH) fail(`the schema is more than ${MAX_DEPTH} pages deep`)
    const start = (page - 1) * pageSize
    // Page 1 starts with the 100-byte file header.
    const header = start + (page === 1 ? 100 : 0)
    const type = file[header]
    if (type !== LEAF_TABLE && type !== INTERIOR_TABLE) {
      fail(`schema page ${page} has type ${type}, not a table page`)
    }
    const cells = view.getUint16(header + 3)
    const pointers = header + (type === LEAF_TABLE ? 8 : 12)
    if (pointers + 2 * cells > start + usable) fail(`schema page ${page} lists too many cells`)
    if (type === LEAF_TABLE) {
      // Each cell starts with its payload size, a varint of at most 9 bytes: one schema row's SQL.
      for (let cell = 0; cell < cells; cell++) {
        const offset = view.getUint16(pointers + 2 * cell)
        if (offset < pointers + 2 * cells - start || offset + 9 > usable) {
          fail(`a cell of schema page ${page} is outside the page`)
        }
        let size = 0
        for (let at = start + offset, end = at + 9; at < end; at++) {
          size = size * 128 + (file[at] & 0x7f)
          if (file[at] < 0x80) break
        }
        schemaBytes += size
        if (schemaBytes > MAX_SCHEMA_BYTES) {
          throw new StatementError(
            "too-large",
            `db.sqlite's schema holds more than ${MAX_SCHEMA_BYTES} bytes of SQL`,
          )
        }
      }
      entries += cells
      if (entries > MAX_SCHEMA_ENTRIES) {
        throw new StatementError(
          "too-large",
          `db.sqlite has more than ${MAX_SCHEMA_ENTRIES} tables, indexes, views and triggers`,
        )
      }
      return
    }
    // Each child is checked as it is read, so the visited cap also bounds the cells read.
    const children: number[] = []
    for (let cell = 0; cell <= cells; cell++) {
      let child: number
      if (cell < cells) {
        const offset = view.getUint16(pointers + 2 * cell)
        // A cell starts with its 4-byte left child; a pointer into the header or past it is broken.
        if (offset < pointers + 2 * cells - start || offset + 4 > usable) {
          fail(`a cell of schema page ${page} is outside the page`)
        }
        child = view.getUint32(start + offset)
      } else {
        // The right-most child, after the last cell.
        child = view.getUint32(header + 8)
      }
      if (child === 0 || child > pageCount) fail(`schema page ${child} is not in the file`)
      if (visited.has(child)) fail(`schema page ${child} is reached twice`)
      visited.add(child)
      if (visited.size > MAX_SCHEMA_PAGES) {
        throw new StatementError(
          "too-large",
          `db.sqlite's schema spans more than ${MAX_SCHEMA_PAGES} pages`,
        )
      }
      children.push(child)
    }
    for (const child of children) visit(child, depth + 1)
  }
  if (pageCount < 1) fail("its first page is cut short")
  visit(1, 1)
}
