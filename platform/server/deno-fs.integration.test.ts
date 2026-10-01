// `denoFileSystem` on a real folder, held to the same `FileSystemPort` contract the unit tier runs
// on the in-memory fake (`_fake-fs.test.ts`). The unit tier cannot write to disk, so this is where
// the write side of the adapter — and the fake's resemblance to it — is checked.

import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { denoFileSystem } from "./deno-fs.ts"
import { describeFileSystemContract } from "./fs-contract.test.ts"

describeFileSystemContract("denoFileSystem", async () => {
  const root = await createScratchFolder("it_deno_fs")
  return { fs: denoFileSystem, root, close: () => removeScratchFolder(root) }
})
