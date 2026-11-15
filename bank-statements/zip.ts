/**
 * A small reader of one file in a zip archive, for app exports that come zipped. It reads the
 * central directory, never scans the data, and inflates with the web-standard
 * `DecompressionStream`. Internal: no entry point exports it.
 *
 * @module
 */

import { quote, StatementError } from "./statement.ts"

/** The end-of-central-directory record: its fixed part and its signature. */
const EOCD_SIZE = 22
const EOCD_SIGNATURE = 0x06054b50
/** A zip64 end-of-central-directory locator, which sits right before the record. */
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50
const ZIP64_LOCATOR_SIZE = 20
const CENTRAL_SIZE = 46
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIZE = 30
const LOCAL_SIGNATURE = 0x04034b50
/** How much compressed input the inflater gets at a time, so its output stays near the limit. */
const INFLATE_CHUNK = 4096

/**
 * The bytes of the entry `name` in the zip archive `zip`, or `undefined` when there is none.
 *
 * Throws a {@link StatementError}: `"malformed"` when `zip` is not a zip archive, a record runs
 * past its end, or the entry inflates to another size than the central directory declares;
 * `"unsupported"` for zip64, an archive on several disks, an encrypted entry or a compression
 * method other than stored (0) and deflate (8); `"too-large"` when the entry declares more than
 * `maxSize` bytes. Inflating stops as soon as the output passes the declared size, so an entry
 * that lies about its size never grows past `maxSize`.
 */
export async function readZipEntry(
  zip: Uint8Array,
  name: string,
  maxSize: number,
): Promise<Uint8Array | undefined> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const malformed = (why: string) => new StatementError("malformed", `not a zip archive: ${why}`)
  const unsupported = (why: string) => new StatementError("unsupported", `zip: ${why}`)

  // The record ends the file: its comment, at most 65,535 bytes, runs to the last byte.
  let eocd = -1
  const lowest = Math.max(0, zip.length - EOCD_SIZE - 0xffff)
  for (let at = zip.length - EOCD_SIZE; at >= lowest; at--) {
    if (
      view.getUint32(at, true) === EOCD_SIGNATURE &&
      at + EOCD_SIZE + view.getUint16(at + 20, true) === zip.length
    ) {
      eocd = at
      break
    }
  }
  if (eocd === -1) throw malformed("no end of central directory")
  if (
    eocd >= ZIP64_LOCATOR_SIZE &&
    view.getUint32(eocd - ZIP64_LOCATOR_SIZE, true) === ZIP64_LOCATOR_SIGNATURE
  ) {
    throw unsupported("zip64 archives are not read")
  }
  const disk = view.getUint16(eocd + 4, true)
  const directoryDisk = view.getUint16(eocd + 6, true)
  const entriesHere = view.getUint16(eocd + 8, true)
  const entries = view.getUint16(eocd + 10, true)
  const directorySize = view.getUint32(eocd + 12, true)
  const directoryStart = view.getUint32(eocd + 16, true)
  if (disk !== 0 || directoryDisk !== 0 || entriesHere !== entries) {
    throw unsupported("archives on several disks are not read")
  }
  if (entries === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
    throw unsupported("zip64 archives are not read")
  }
  const directoryEnd = directoryStart + directorySize
  if (directoryEnd > eocd) throw malformed("the central directory runs past its end")

  const wanted = new TextEncoder().encode(name)
  let at = directoryStart
  for (let index = 0; index < entries; index++) {
    if (at + CENTRAL_SIZE > directoryEnd || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw malformed("a central directory entry is broken")
    }
    const nameLength = view.getUint16(at + 28, true)
    const next = at + CENTRAL_SIZE + nameLength + view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true)
    if (next > directoryEnd) throw malformed("a central directory entry is broken")
    const entryName = zip.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength)
    if (entryName.length === wanted.length && entryName.every((byte, i) => byte === wanted[i])) {
      return await readEntry(zip, view, at, directoryStart, maxSize, malformed, unsupported)
    }
    at = next
  }
  return undefined
}

/** The data of the entry whose central directory record starts at `record`. */
async function readEntry(
  zip: Uint8Array,
  view: DataView,
  record: number,
  dataEnd: number,
  maxSize: number,
  malformed: (why: string) => StatementError,
  unsupported: (why: string) => StatementError,
): Promise<Uint8Array> {
  const name = new TextDecoder().decode(
    zip.subarray(record + CENTRAL_SIZE, record + CENTRAL_SIZE + view.getUint16(record + 28, true)),
  )
  const flags = view.getUint16(record + 8, true)
  const method = view.getUint16(record + 10, true)
  const compressedSize = view.getUint32(record + 20, true)
  const size = view.getUint32(record + 24, true)
  const local = view.getUint32(record + 42, true)
  if (flags & 1) throw unsupported(`${quote(name)} is encrypted`)
  if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) {
    throw unsupported("zip64 archives are not read")
  }
  if (method !== 0 && method !== 8) {
    throw unsupported(`${quote(name)} uses compression method ${method}`)
  }
  if (size > maxSize) {
    throw new StatementError(
      "too-large",
      `${quote(name)} is ${size} bytes, over the limit of ${maxSize}`,
    )
  }
  if (local + LOCAL_SIZE > dataEnd || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
    throw malformed(`the local header of ${quote(name)} is broken`)
  }
  const start = local + LOCAL_SIZE + view.getUint16(local + 26, true) +
    view.getUint16(local + 28, true)
  const end = start + compressedSize
  if (end > dataEnd) throw malformed(`${quote(name)} runs past its end`)
  const data = zip.subarray(start, end)
  if (method === 0) {
    if (compressedSize !== size) throw malformed(`${quote(name)} is stored with two sizes`)
    return data.slice()
  }
  return await inflate(data, size, name, malformed)
}

/**
 * `data` inflated as raw deflate, which must give exactly `size` bytes. Input goes in by
 * {@link INFLATE_CHUNK} bytes as the output is read, and reading stops once the output passes
 * `size`, so a lying entry costs at most `size` plus one chunk's output.
 */
async function inflate(
  data: Uint8Array,
  size: number,
  name: string,
  malformed: (why: string) => StatementError,
): Promise<Uint8Array> {
  let offset = 0
  const input = new ReadableStream<BufferSource>({
    pull(controller) {
      if (offset >= data.length) return controller.close()
      controller.enqueue(data.slice(offset, offset + INFLATE_CHUNK))
      offset += INFLATE_CHUNK
    },
  }, { highWaterMark: 0 })
  const reader = input.pipeThrough(new DecompressionStream("deflate-raw")).getReader()
  const output = new Uint8Array(size)
  let length = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (length + value.length > size) {
        await reader.cancel().catch(() => {})
        throw malformed(`${quote(name)} inflates past its declared ${size} bytes`)
      }
      output.set(value, length)
      length += value.length
    }
  } catch (error) {
    if (error instanceof StatementError) throw error
    throw malformed(`${quote(name)} does not inflate`)
  }
  if (length !== size) throw malformed(`${quote(name)} inflates to ${length} bytes, not ${size}`)
  return output
}
