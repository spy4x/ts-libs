// `nodeFileSystem` on a real folder, held to the same `FileSystemPort` contract as
// `denoFileSystem` (`deno-fs.integration.test.ts`). It runs on Deno's `node:fs/promises`; the PR that
// added it ran the same calls on Node and Bun themselves. `runtimeFileSystem` runs the contract too,
// so every method, the optional ones included, reaches the port it picks.

import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { expect } from "@std/expect"
import { describeFileSystemContract } from "./fs-contract.test.ts"
import { nodeFileSystem, runtimeFileSystem } from "./runtime-fs.ts"

describeFileSystemContract("nodeFileSystem", async () => {
  const root = await createScratchFolder("it_node_fs")
  return { fs: nodeFileSystem, root, close: () => removeScratchFolder(root) }
}, { locks: false })

describeFileSystemContract("runtimeFileSystem", async () => {
  const root = await createScratchFolder("it_runtime_fs")
  return { fs: runtimeFileSystem, root, close: () => removeScratchFolder(root) }
})

Deno.test("nodeFileSystem creates a file with the permission bits asked for, as bytes, text or a stream", async () => {
  const root = await createScratchFolder("it_node_fs_mode")
  try {
    await nodeFileSystem.writeText(`${root}/a.json`, "{}", { mode: 0o600 })
    await nodeFileSystem.writeBytes!(`${root}/b.bin`, new Uint8Array([1]), { mode: 0o600 })
    const source = ReadableStream.from([new Uint8Array([1])])
    await nodeFileSystem.writeStream!(`${root}/c.bin`, source, { mode: 0o600 })
    for (const name of ["a.json", "b.bin", "c.bin"]) {
      expect((await Deno.stat(`${root}/${name}`)).mode! & 0o777).toBe(0o600)
    }
    // The control: without a mode the file is readable by more than its owner.
    await nodeFileSystem.writeText(`${root}/open.json`, "{}")
    expect((await Deno.stat(`${root}/open.json`)).mode! & 0o777).not.toBe(0o600)
  } finally {
    await removeScratchFolder(root)
  }
})
