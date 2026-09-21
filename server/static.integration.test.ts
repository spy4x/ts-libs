/**
 * `server/static.ts` against a real disk, through `denoStaticFs` (#58).
 *
 * The unit tier proves the module's own streaming and close logic — including
 * closing the handle on a full read, a client cancel and a failed read — with a
 * fake `StaticFs`, so this file does not repeat that with real files. What it
 * proves instead, against the concrete `Deno.*` adapter: a real file larger than
 * one internal read chunk arrives as more than one chunk, and `Content-Length`
 * matches the real file size from `Deno.stat`.
 *
 * An earlier version of this file also looped many cancelled requests and
 * asserted the loop never hit "too many open files", as a proxy for the
 * descriptor being released. A review confirmed that proxy does not work:
 * `Deno.FsFile.readable` releases its own descriptor on cancel independently of
 * this module, and five hundred descriptors are far below any real per-process
 * limit, so the loop passed even with the close deliberately removed and even
 * with the handle deliberately never closed at all. Proving the descriptor
 * count directly would need to read `/proc/self/fd`, which needs `--allow-all`
 * and so cannot run inside this tier's `--allow-read --allow-env --allow-net
 * --allow-write=.volumes` grant. The unit tier's fake-filesystem tests are the
 * ones that actually pin the close behaviour; this file stays real-disk-only.
 */

import { assertEquals, assertGreater } from "@std/assert"
import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { denoStaticFs, serveStatic } from "./static.ts"

/**
 * Larger than one internal read chunk (64 KiB on this platform, confirmed by a
 * scratch probe), so a plain full read already exercises more than one chunk.
 */
const FILE_SIZE = 200 * 1024

Deno.test("static integration: a real file larger than one chunk streams as several chunks", async () => {
  const folder = await createScratchFolder("it_static")
  try {
    const bytes = new Uint8Array(FILE_SIZE)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
    await Deno.writeFile(`${folder}/asset.bin`, bytes)

    const response = await serveStatic("/asset.bin", { root: folder, fs: denoStaticFs })
    if (!response) throw new Error("expected a response")

    const info = await Deno.stat(`${folder}/asset.bin`)
    assertEquals(response.headers.get("content-length"), String(info.size))

    const reader = response.body!.getReader()
    let chunkCount = 0
    const received: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunkCount++
      received.push(value)
    }
    assertGreater(chunkCount, 1, "a 200 KiB file arrived as a single chunk")

    const total = received.reduce((sum, chunk) => sum + chunk.length, 0)
    assertEquals(total, FILE_SIZE)
    const joined = new Uint8Array(total)
    let offset = 0
    for (const chunk of received) {
      joined.set(chunk, offset)
      offset += chunk.length
    }
    assertEquals(joined, bytes)
  } finally {
    await removeScratchFolder(folder)
  }
})
