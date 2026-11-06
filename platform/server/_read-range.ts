// The byte-range read every `FileSystemPort` implementation shares: one checks the range, the other
// fills it from a file a chunk at a time. Not exported from the package.

import type { ReadBytesOptions } from "./ports.ts"

/** `options` with defaults filled in, or a throw on a negative or fractional value. */
export function checkRange(
  options: ReadBytesOptions = {},
): { offset: number; length: number } {
  const { offset = 0, length = Infinity } = options
  for (const [name, value] of [["offset", offset], ["length", length]] as const) {
    if (!(value >= 0) || (value !== Infinity && !Number.isInteger(value))) {
      throw new RangeError(`readBytes: ${name} must be a non-negative integer, got ${value}`)
    }
  }
  return { offset, length }
}

/**
 * Up to `length` bytes from `read`, which fills the start of the buffer it is given and resolves
 * to how many bytes it wrote, `0` at the end of the file.
 */
export async function readUpTo(
  read: (buffer: Uint8Array) => Promise<number>,
  length: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < length) {
    const buffer = new Uint8Array(Math.min(64 * 1024, length - total))
    const count = await read(buffer)
    if (count === 0) break
    chunks.push(buffer.subarray(0, count))
    total += count
  }
  const joined = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return joined
}
