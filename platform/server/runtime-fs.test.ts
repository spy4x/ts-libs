import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { fileSystemOver, type RuntimeHost } from "./_runtime-host.ts"
import { fakeFs } from "./_fake-fs.ts"
import { denoFileSystem } from "./deno-fs.ts"
import { nodeFileSystem, runtimeFileSystem } from "./runtime-fs.ts"

describe("fileSystemOver", () => {
  const ports = () => ({ deno: fakeFs({ "/a.txt": "deno" }), node: fakeFs({ "/a.txt": "node" }) })

  it("uses the Deno port on Deno, even where process is defined too, and the Node port on Node and Bun", async () => {
    const both = ports()
    const deno = fileSystemOver(() => ({ Deno: {}, process: {} }), both)
    const node = fileSystemOver(() => ({ process: {} }), both)
    expect(await deno.readText("/a.txt")).toBe("deno")
    expect(await node.readText("/a.txt")).toBe("node")
  })

  it("hands every method, the optional ones too, to the chosen port", async () => {
    const both = ports()
    const fs = fileSystemOver(() => ({ process: {} }), both)
    await fs.mkdirp("/job")
    const dir = await fs.makeTempDir!("/job")
    await fs.writeBytes!(`${dir}/b.bin`, new Uint8Array([1]))
    expect(await fs.readBytes!(`${dir}/b.bin`)).toEqual(new Uint8Array([1]))
    await fs.removeTree!("/job")
    expect(both.node.calls.map((call) => call.op)).toEqual([
      "mkdirp",
      "makeTempDir",
      "writeBytes",
      "readBytes",
      "removeTree",
    ])
    expect(both.deno.calls).toEqual([])
  })

  it("picks the runtime again on every call", async () => {
    const both = ports()
    let host: RuntimeHost = { Deno: {} }
    const fs = fileSystemOver(() => host, both)
    expect(await fs.readText("/a.txt")).toBe("deno")
    host = { process: {} }
    expect(await fs.readText("/a.txt")).toBe("node")
  })

  it("throws on a runtime with neither Deno nor process", () => {
    expect(() => fileSystemOver(() => ({}), ports()).exists("/a.txt")).toThrow(
      "unsupported runtime",
    )
  })
})

describe("runtimeFileSystem", () => {
  it("reads a file on Deno", async () => {
    const path = new URL(import.meta.url).pathname
    expect(await runtimeFileSystem.readText(path)).toBe(await denoFileSystem.readText(path))
  })
})

describe("nodeFileSystem", () => {
  it("refuses to lock, since Node and Bun have no file lock", async () => {
    await expect(nodeFileSystem.lock("/tmp/never.lock")).rejects.toThrow("no file lock")
  })
})
