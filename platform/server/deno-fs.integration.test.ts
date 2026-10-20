// `denoFileSystem` on a real folder, held to the same `FileSystemPort` contract the unit tier runs
// on the in-memory fake (`_fake-fs.test.ts`). The unit tier cannot write to disk, so this is where
// the write side of the adapter — and the fake's resemblance to it — is checked.

import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { expect } from "@std/expect"
import { atomicWriteJson } from "./atomic-json.ts"
import { denoFileSystem } from "./deno-fs.ts"
import { describeFileSystemContract } from "./fs-contract.test.ts"

describeFileSystemContract("denoFileSystem", async () => {
  const root = await createScratchFolder("it_deno_fs")
  return { fs: denoFileSystem, root, close: () => removeScratchFolder(root) }
})

/** The permission bits of `path`; fails where the platform has none, instead of passing unseen. */
async function permissionBits(path: string): Promise<number> {
  const { mode } = await Deno.stat(path)
  if (mode === null) throw new Error("this platform reports no file permissions")
  return mode & 0o777
}

Deno.test("denoFileSystem creates a file with the permission bits asked for", async () => {
  const root = await createScratchFolder("it_deno_fs_mode")
  try {
    await denoFileSystem.writeText(`${root}/secret.json`, "{}", { mode: 0o600 })
    expect(await permissionBits(`${root}/secret.json`)).toBe(0o600)
    // The control: without a mode the file is readable by more than its owner.
    await denoFileSystem.writeText(`${root}/open.json`, "{}")
    expect(await permissionBits(`${root}/open.json`)).not.toBe(0o600)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("denoFileSystem writeBytes and writeStream create a file with the bits asked for", async () => {
  const root = await createScratchFolder("it_deno_fs_byte_mode")
  try {
    await denoFileSystem.writeBytes!(`${root}/a.bin`, new Uint8Array([1]), { mode: 0o600 })
    expect(await permissionBits(`${root}/a.bin`)).toBe(0o600)
    const source = ReadableStream.from([new Uint8Array([1])])
    await denoFileSystem.writeStream!(`${root}/b.bin`, source, { mode: 0o600 })
    expect(await permissionBits(`${root}/b.bin`)).toBe(0o600)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("an atomic write with a mode replaces a world-readable document with an owner-only one", async () => {
  const root = await createScratchFolder("it_deno_fs_atomic_mode")
  try {
    const path = `${root}/state.json`
    await denoFileSystem.writeText(path, "{}")
    await atomicWriteJson(denoFileSystem, path, { a: 1 }, { pid: 1, sequence: 1 }, 2, {
      mode: 0o600,
    })
    expect(await permissionBits(path)).toBe(0o600)
    expect(await denoFileSystem.readText(path)).toContain(`"a": 1`)
  } finally {
    await removeScratchFolder(root)
  }
})
