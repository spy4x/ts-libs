/**
 * Whether a file's first bytes match the type it claims. A browser upload names its own
 * `Content-Type`, and a signed URL only holds it to that name; the bytes are what the file is.
 * Read the first {@link SNIFF_BYTES} bytes of an upload (`S3Storage.getRange`) and check them
 * here before trusting it.
 *
 * @module
 */

/** How many leading bytes {@link matchesContentType} looks at; more are ignored. */
export const SNIFF_BYTES = 512

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))

/** Byte prefixes, each a list of `[offset, bytes]` that must all match. */
const SIGNATURES: Record<string, readonly (readonly [number, readonly number[]])[][]> = {
  "image/png": [[[0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]]]],
  "image/jpeg": [[[0, [0xff, 0xd8, 0xff]]]],
  "image/gif": [[[0, ascii(`GIF87a`)]], [[0, ascii(`GIF89a`)]]],
  "image/webp": [[[0, ascii(`RIFF`)], [8, ascii(`WEBP`)]]],
  // An ISO media file whose major brand is a HEIC one; an AVIF's major brand is `avif`.
  "image/heic": ["heic", "heix", "mif1"].map((brand): [number, number[]][] => [
    [4, ascii(`ftyp`)],
    [8, ascii(brand)],
  ]),
  "application/pdf": [[[0, ascii(`%PDF-`)]]],
  // A local file header, or the end record alone: an archive with no entries.
  "application/zip": [[[0, [0x50, 0x4b, 0x03, 0x04]]], [[0, [0x50, 0x4b, 0x05, 0x06]]]],
}

/** Types with no signature: their bytes must be UTF-8 text with no NUL byte. */
const TEXT_TYPES = new Set([`text/plain`, `text/csv`, `application/json`])

/** Every type {@link matchesContentType} can confirm. Any other type never matches. */
export const SNIFFABLE_CONTENT_TYPES: readonly string[] = [
  ...Object.keys(SIGNATURES),
  ...TEXT_TYPES,
]

/** The bare type of a `Content-Type` value, lower case, without parameters such as `charset`. */
function bareType(contentType: string): string {
  return contentType.split(`;`)[0].trim().toLowerCase()
}

/** UTF-8 that may stop in the middle of a character, since `bytes` is often a file's head. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder(`utf-8`, { fatal: true }).decode(bytes, { stream: true })
    return true
  } catch {
    return false
  }
}

/**
 * Whether `bytes`, the start of a file, are what `contentType` says. Images (PNG, JPEG, GIF,
 * WebP, HEIC by its major brand), PDF and ZIP are checked by their signature; plain text, CSV and JSON by being UTF-8
 * without a NUL byte. Parameters (`; charset=utf-8`) and case are ignored. An empty file, and a
 * type not in {@link SNIFFABLE_CONTENT_TYPES}, never match: a check that cannot tell must refuse.
 */
export function matchesContentType(bytes: Uint8Array, contentType: string): boolean {
  const head = bytes.subarray(0, SNIFF_BYTES)
  if (head.length === 0) return false
  const type = bareType(contentType)
  if (TEXT_TYPES.has(type)) return isText(head)
  // Own keys only: `constructor` and `__proto__` are inherited, not signatures.
  if (!Object.hasOwn(SIGNATURES, type)) return false
  const signatures = SIGNATURES[type]
  return signatures.some((parts) =>
    parts.every(([offset, expected]) =>
      expected.every((byte, index) => head[offset + index] === byte)
    )
  )
}
