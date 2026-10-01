// The in-memory fake every server module here is tested through, held to the same
// `FileSystemPort` contract that `deno-fs.integration.test.ts` runs on the real disk.

import { expect } from "@std/expect"
import { fakeFs } from "./_fake-fs.ts"
import { describeFileSystemContract } from "./fs-contract.test.ts"

describeFileSystemContract("fakeFs", () => {
  const fs = fakeFs()
  const root = "/scratch"
  return fs.mkdirp(root).then(() => ({ fs, root, close: () => Promise.resolve() }))
})

Deno.test("fakeFs treats the folders of seeded files as existing", async () => {
  const fs = fakeFs({ "/data/state/now.json": "{}" })
  expect(await fs.exists("/data/state")).toBe(true)
  expect(await fs.exists("/data")).toBe(true)
  await fs.writeText("/data/state/next.json", "{}")
  expect(await fs.readText("/data/state/next.json")).toBe("{}")
})
