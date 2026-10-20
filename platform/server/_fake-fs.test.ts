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

Deno.test("fakeFs gives a mode to a file it creates, keeps an existing file's, and renames carry it", async () => {
  const fs = fakeFs({ "/data/old.json": "{}" })
  await fs.writeText("/data/new.json", "{}", { mode: 0o600 })
  await fs.writeText("/data/old.json", "{}", { mode: 0o600 })
  expect(fs.modes.get("/data/new.json")).toBe(0o600)
  expect(fs.modes.has("/data/old.json")).toBe(false)
  await fs.rename("/data/new.json", "/data/old.json")
  expect(fs.modes.get("/data/old.json")).toBe(0o600)
  expect(fs.modes.has("/data/new.json")).toBe(false)
})

Deno.test("fakeFs gives a mode to a file it creates as bytes or from a stream", async () => {
  const fs = fakeFs({ "/data/old.bin": "" })
  await fs.writeBytes!("/data/a.bin", new Uint8Array([1]), { mode: 0o600 })
  await fs.writeStream!("/data/b.bin", ReadableStream.from([new Uint8Array([1])]), { mode: 0o600 })
  await fs.writeBytes!("/data/old.bin", new Uint8Array([1]), { mode: 0o600 })
  expect(fs.modes.get("/data/a.bin")).toBe(0o600)
  expect(fs.modes.get("/data/b.bin")).toBe(0o600)
  expect(fs.modes.has("/data/old.bin")).toBe(false)
})

Deno.test("fakeFs moves and removes the exact bytes with the file", async () => {
  const fs = fakeFs({ "/data/x": "" })
  const data = new Uint8Array([0xff, 0x01])
  await fs.writeBytes!("/data/a.bin", data)
  await fs.rename("/data/a.bin", "/data/b.bin")
  expect(await fs.readBytes!("/data/b.bin")).toEqual(data)
  expect(await fs.readBytes!("/data/a.bin")).toBeNull()
  await fs.appendText("/data/b.bin", "A")
  expect(await fs.readBytes!("/data/b.bin")).toEqual(new Uint8Array([0xff, 0x01, 0x41]))
  await fs.writeText("/data/b.bin", "text")
  expect(await fs.readBytes!("/data/b.bin")).toEqual(new TextEncoder().encode("text"))
  await fs.remove("/data/b.bin")
  expect(await fs.readBytes!("/data/b.bin")).toBeNull()
})
