/**
 * `server/static.ts` against a real disk, through `denoStaticFs` (#58).
 *
 * The unit tier proves the module's own streaming and close logic with a fake
 * `StaticFs`. This file proves the concrete `Deno.*` adapter on top of it: a real
 * file larger than one internal read chunk arrives as more than one chunk, its
 * `Content-Length` matches the real file size from `Deno.stat`, and repeatedly
 * cancelling a real file's stream early never runs out of file descriptors —
 * the practical symptom of a handle that is not released.
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

Deno.test("static integration: cancelling many real-file streams early never exhausts file handles", async () => {
  const folder = await createScratchFolder("it_static")
  try {
    await Deno.writeFile(`${folder}/asset.bin`, new Uint8Array(FILE_SIZE).fill(1))

    // Well past a typical per-process file descriptor limit if a handle leaked
    // on every request; if `close` is not wired to `cancel`, this loop fails
    // with "too many open files" long before it completes.
    for (let i = 0; i < 500; i++) {
      const response = await serveStatic("/asset.bin", { root: folder, fs: denoStaticFs })
      if (!response) throw new Error("expected a response")
      const reader = response.body!.getReader()
      await reader.read() // read exactly one chunk, well short of the whole file
      await reader.cancel("client aborted")
    }

    // The filesystem is still usable: one more full read succeeds.
    const response = await serveStatic("/asset.bin", { root: folder, fs: denoStaticFs })
    if (!response) throw new Error("expected a response")
    const bytes = await response.arrayBuffer()
    assertEquals(bytes.byteLength, FILE_SIZE)
  } finally {
    await removeScratchFolder(folder)
  }
})
