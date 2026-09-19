/**
 * Memory probe for `sha256OfStream`.
 *
 * The digest is buffered, not streamed, and the module JSDoc states the measured ceiling rather than
 * a guess. This script is how those numbers were produced, kept runnable so they can be re-checked in
 * one command instead of taken on faith:
 *
 * ```bash
 * deno run --allow-read platform/scripts/memory-probe.ts
 * ```
 *
 * **It undercounts, and that is the finding.** `Deno.memoryUsage().external` does not track these
 * `ArrayBuffer` allocations synchronously: sampling before every chunk of a 204 MiB file reports only
 * ~57-65 MiB (0.28x-0.32x input), which cannot be the live set of 204 retained 1 MiB chunks. An
 * independent measurement of the same code reported 2x input. The numbers below are therefore
 * **indicative, not evidence**, and `server/hash-file.ts` claims no ratio as a result.
 *
 * What IS reliable is the **mechanism**, and it is what the module doc now states: `collectBytes`
 * retains every chunk until the stream ends, then allocates a joined buffer, so peak memory grows with
 * the input and is never bounded — unlike a streaming digest, which needs one chunk. That is a
 * code-reading fact.
 *
 * An earlier version of this probe asserted a `toBeLessThan(total)` bound and the suite kept it green
 * under a streaming mutation, because the assertion was measuring the collector. It was removed rather
 * than relaxed: a test that passes either way is worse than no test.
 *
 * There is no in-suite substitute: every behavioural property of the digest (chunk-boundary
 * independence, first-chunk-empty, reader-failure propagation, published vectors) is identical
 * between a buffered and an incremental implementation, so no test that only asserts the digest can
 * distinguish them. Detecting the difference needs the measurement below.
 */

import { denoByteReader } from "../server/deno-fs.ts"
import { sha256OfBytes, sha256OfStream } from "../server/hash-file.ts"
import type { ByteReader } from "../server/ports.ts"

const MIB = 1024 * 1024

/** First existing path at or above `minBytes`, largest first: no writes needed to get a big file. */
async function findLargeFile(minBytes: number): Promise<{ path: string; size: number }> {
  for (const root of ["/usr/lib64", "/usr/lib", "/usr/bin", "/usr/share"]) {
    let best = { path: "", size: 0 }
    try {
      for await (const entry of Deno.readDir(root)) {
        if (!entry.isFile) continue
        try {
          const { size } = await Deno.stat(`${root}/${entry.name}`)
          if (size > best.size) best = { path: `${root}/${entry.name}`, size }
        } catch {
          // Unreadable entry: skip it rather than aborting the probe.
        }
      }
    } catch {
      continue
    }
    if (best.size >= minBytes) return best
  }
  throw new Error(`no readable file of at least ${minBytes} bytes found`)
}

/** Peak `external` while the source is being drained, sampled before each chunk is handed over. */
async function measureFile(
  path: string,
  chunkSize: number,
): Promise<{ ratio: number; delta: number }> {
  const base = Deno.memoryUsage().external
  let peak = 0
  const reader: ByteReader = {
    async *chunks() {
      for await (const chunk of denoByteReader(path, chunkSize).chunks()) {
        peak = Math.max(peak, Deno.memoryUsage().external)
        yield chunk
      }
    },
  }
  await sha256OfStream(reader)
  const size = (await Deno.stat(path)).size
  return { ratio: (peak - base) / size, delta: peak - base }
}

const { path, size } = await findLargeFile(64 * MIB)
console.log(`probe file: ${path} (${(size / MIB).toFixed(0)} MiB)`)
console.log(`  one-shot digest: ${(await sha256OfBytes(await Deno.readFile(path))).slice(0, 16)}…`)

for (const chunkSize of [MIB, 256 * 1024]) {
  const { ratio, delta } = await measureFile(path, chunkSize)
  console.log(
    `  ${(chunkSize / 1024).toFixed(0)} KiB chunks: delta=${(delta / MIB).toFixed(1)} MiB ` +
      `ratio=${ratio.toFixed(2)}x input`,
  )
}
