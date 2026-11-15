/**
 * A minimal zip reader for app exports that come as a zip: it lists the entries from the central
 * directory and reads one entry, stored or deflated. Internal to this package. Web standards only:
 * deflate is `DecompressionStream("deflate-raw")`.
 *
 * The zip comes from a stranger, so every offset is checked against the bytes, and an entry is
 * inflated only up to its declared size, which must fit `maxBytes`: the declared size is checked
 * before inflating and the output is counted while inflating, because a hostile file can lie about
 * it. Encrypted entries, zip64, archives split over several disks and compression methods other
 * than stored (0) and deflate (8) are refused. CRC-32 is not checked: a corrupt entry reads as bad
 * rows, not as a security problem.
 *
 * @module
 */

import { StatementError } from "./statement.ts"

/** Most entries an archive may list. An app export holds a handful. */
export const MAX_ZIP_ENTRIES = 1_000

/** The signature a zip's first local file header starts with: `PK\x03\x04`. */
const LOCAL_HEADER = 0x04034b50
/** The signature of a central directory file header: `PK\x01\x02`. */
const CENTRAL_HEADER = 0x02014b50
/** The signature of the end of central directory record: `PK\x05\x06`. */
const END_OF_DIRECTORY = 0x06054b50
/** The end record's fixed size; a comment of at most 65,535 bytes may follow it. */
const END_SIZE = 22
const MAX_COMMENT = 0xffff
/** How many compressed bytes go into the inflater at a time. */
const INFLATE_SLICE = 1024

/** One file the central directory lists. */
export interface ZipEntry {
  name: string
  /** 0 stored, 8 deflate; others are refused before this point. */
  method: number
  compressedSize: number
  /** What the archive claims the entry inflates to. Untrusted. */
  uncompressedSize: number
  /** Where the entry's local file header starts. */
  localOffset: number
}

/** Whether `bytes` start like a zip archive: a local file header, or the end record of an empty one. */
export function isZip(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const signature = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true)
  return signature === LOCAL_HEADER || signature === END_OF_DIRECTORY
}

function malformed(message: string): never {
  throw new StatementError("malformed", `zip: ${message}`)
}

/**
 * The entries `bytes` list in their central directory. Throws a {@link StatementError}: `"too-large"`
 * over {@link MAX_ZIP_ENTRIES}, `"malformed"` for a broken or unsupported archive.
 */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  const lowest = Math.max(0, bytes.length - END_SIZE - MAX_COMMENT)
  for (let at = bytes.length - END_SIZE; at >= lowest; at--) {
    if (view.getUint32(at, true) === END_OF_DIRECTORY) {
      end = at
      break
    }
  }
  if (end === -1) malformed("no end of central directory record")
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    malformed("archives split over several disks are not read")
  }
  const count = view.getUint16(end + 10, true)
  const size = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    malformed("zip64 archives are not read")
  }
  if (count > MAX_ZIP_ENTRIES) {
    throw new StatementError(
      "too-large",
      `zip lists ${count} entries, over the limit of ${MAX_ZIP_ENTRIES}`,
    )
  }
  if (offset + size > end) malformed("the central directory is outside the file")

  const names = new TextDecoder()
  const entries: ZipEntry[] = []
  let at = offset
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== CENTRAL_HEADER) {
      malformed("a central directory header is broken")
    }
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const nameLength = view.getUint16(at + 28, true)
    const next = at + 46 + nameLength + view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
    if (next > end) malformed("a central directory header is broken")
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLength))
    if (flags & 1) malformed(`${JSON.stringify(name)} is encrypted`)
    if (method !== 0 && method !== 8) {
      malformed(`${JSON.stringify(name)} uses compression method ${method}; only 0 and 8 are read`)
    }
    const compressedSize = view.getUint32(at + 20, true)
    const uncompressedSize = view.getUint32(at + 24, true)
    const localOffset = view.getUint32(at + 42, true)
    if (
      compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      malformed("zip64 archives are not read")
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
    at = next
  }
  return entries
}

/**
 * The bytes of `entry`, at most `maxBytes` of them. Throws a {@link StatementError}: `"too-large"`
 * when the entry declares more than `maxBytes` or inflates past its declared size, `"malformed"`
 * when its data is outside the file or does not inflate.
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new StatementError(
      "too-large",
      `zip entry ${JSON.stringify(entry.name)} is over ${maxBytes} bytes`,
    )
  if (entry.uncompressedSize > maxBytes) throw tooLarge()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header = entry.localOffset
  if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER) {
    malformed(`the local header of ${JSON.stringify(entry.name)} is broken`)
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (data.length !== entry.compressedSize) {
    malformed(`the data of ${JSON.stringify(entry.name)} is outside the file`)
  }
  // A stored entry is no bigger than the archive, which the caller has capped at `maxBytes`.
  if (entry.method === 0) return data

  // The declared size is the stranger's word: count the output and stop the moment it passes. The
  // input goes in slices of INFLATE_SLICE bytes, pulled only when the output is read, since a
  // runtime may inflate a whole input chunk before handing out any of it: deflate expands at most
  // about 1,032 times, so one slice overshoots the limit by about 1 MiB at worst.
  const limit = entry.uncompressedSize
  const input = data.slice()
  let fed = 0
  const reader = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (fed >= input.length) return controller.close()
      controller.enqueue(input.subarray(fed, fed + INFLATE_SLICE))
      fed += INFLATE_SLICE
    },
  }, { highWaterMark: 0 }).pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        await reader.cancel().catch(() => {})
        throw new StatementError(
          "too-large",
          `zip entry ${JSON.stringify(entry.name)} inflates past its declared ${limit} bytes`,
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof StatementError) throw error
    malformed(`${JSON.stringify(entry.name)} does not inflate`)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}
