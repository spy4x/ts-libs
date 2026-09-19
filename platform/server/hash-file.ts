/**
 * SHA-256 of a whole byte source.
 *
 * **Buffered, not streamed, and the memory ceiling is unbounded.** {@link collectBytes} holds every
 * chunk the reader yields until the stream ends, then allocates one joined buffer for
 * `crypto.subtle.digest`. Peak memory therefore grows with the input: it is at least the input size
 * plus one chunk, and the original source was worse still (it called `Deno.readFile` and held the
 * whole file as a `Uint8Array` *and* the encoded copy).
 *
 * No ratio is claimed, because one could not be measured reliably. `Deno.memoryUsage().external` does
 * not track these `ArrayBuffer` allocations synchronously — `platform/scripts/memory-probe.ts`
 * samples it before every chunk of a 204 MiB file and reports only 57-65 MiB, i.e. it undercounts the
 * live set — while an independent measurement of the same code reported 2x the input. Both
 * observations are consistent with the mechanism below; neither is asserted.
 *
 * **Why not incremental.** An incremental digest is not reachable in this runtime: `crypto.subtle`
 * hashes in one shot; `crypto.DigestStream` does not exist in Deno 2.9.7
 * (`Property 'DigestStream' does not exist on type 'Crypto'`); `node:crypto`'s `createHash` works but
 * importing it makes Deno load a second `setTimeout` declaration that conflicts with its own, turning
 * an unguarded `setTimeout(...): number` at `server/http/bounded-body.ts:60` into a hard `TS2322`;
 * and `@std/crypto` is not a substitute (its `digestSync` is also one-shot). Restoring streaming
 * needs that one-line `server/http` fix (`ReturnType<typeof setTimeout>`), after which `createHash` +
 * `update` over the same {@link ByteReader} is a drop-in replacement.
 *
 * **This gap is not covered by the suite and cannot be.** Every behavioural property of the digest —
 * chunk-boundary independence, first-chunk-empty, reader-failure propagation, the published NIST
 * vectors — is identical between a buffered and an incremental implementation. A test asserting the
 * memory ceiling was written and then removed: it passed under a streaming mutation, so it was
 * measuring the collector rather than the code. The mechanism above is a property of `collectBytes`
 * and is verified by reading it; `platform/scripts/memory-probe.ts` is the reproducible probe.
 *
 * A hand-rolled SHA-256 is deliberately **not** an option: bespoke crypto is worse than a documented
 * memory ceiling.
 */

import { encodeHex } from "@std/encoding/hex"

import type { ByteReader } from "./ports.ts"

/** Join a byte source into one contiguous buffer, reusing the single chunk when there is only one. */
async function collectBytes(reader: ByteReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of reader.chunks()) {
    chunks.push(chunk)
    total += chunk.byteLength
  }
  if (chunks.length === 0) return new Uint8Array()
  if (chunks.length === 1) return chunks[0]
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return joined
}

/** SHA-256 of one buffer, as lowercase hex. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  // `subtle.digest` rejects a view backed by a shared buffer, so the bytes are copied into a plain
  // `ArrayBuffer` first.
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", buffer)
  return encodeHex(new Uint8Array(digest))
}

/** SHA-256 of a UTF-8 string, as lowercase hex. */
export function sha256OfText(value: string): Promise<string> {
  return sha256OfBytes(new TextEncoder().encode(value))
}

/**
 * SHA-256 of a whole byte source, as lowercase hex.
 *
 * Empty input hashes to the SHA-256 of the empty string
 * (`e3b0c442…b855`), which is what a caller comparing against a recorded digest expects. Chunk
 * boundaries carry no meaning: the digest is identical however the source splits its bytes.
 *
 * A failure while reading propagates — a digest of the bytes read so far is never returned.
 */
export async function sha256OfStream(reader: ByteReader): Promise<string> {
  return await sha256OfBytes(await collectBytes(reader))
}
