import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { fileSystemOver, fsErrorOver, type RuntimeHost } from "./_runtime-host.ts"
import { fakeFs } from "./_fake-fs.ts"
import { denoFileSystem } from "./deno-fs.ts"
import { fsError, isFsError, nodeFileSystem, runtimeFileSystem } from "./runtime-fs.ts"

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

describe("fsErrorOver", () => {
  const denoHost: RuntimeHost = { Deno: { errors: Deno.errors }, process: {} }
  const nodeHost: RuntimeHost = { process: {} }

  it("makes Deno's own error class on Deno, so instanceof checks keep working", () => {
    expect(fsErrorOver(denoHost, "NotFound", "gone")).toBeInstanceOf(Deno.errors.NotFound)
    expect(fsErrorOver(denoHost, "AlreadyExists", "there")).toBeInstanceOf(
      Deno.errors.AlreadyExists,
    )
    expect(fsErrorOver(denoHost, "WriteZero", "stuck")).toBeInstanceOf(Deno.errors.WriteZero)
  })

  it("makes an Error named after the kind with Node's code on Node and Bun", () => {
    const missing = fsErrorOver(nodeHost, "NotFound", "gone") as Error & { code?: string }
    expect([missing.name, missing.code, missing.message]).toEqual(["NotFound", "ENOENT", "gone"])
    const there = fsErrorOver(nodeHost, "AlreadyExists", "there") as Error & { code?: string }
    expect([there.name, there.code]).toEqual(["AlreadyExists", "EEXIST"])
    const stuck = fsErrorOver(nodeHost, "WriteZero", "stuck") as Error & { code?: string }
    expect([stuck.name, stuck.code]).toEqual(["WriteZero", undefined])
  })
})

describe("isFsError", () => {
  it("recognises the kind from Deno, from Node's code, and from fsError on every runtime", () => {
    const nodeMissing = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })
    expect(isFsError(new Deno.errors.NotFound("gone"), "NotFound")).toBe(true)
    expect(isFsError(nodeMissing, "NotFound")).toBe(true)
    expect(isFsError(fsErrorOver({ process: {} }, "WriteZero", "stuck"), "WriteZero")).toBe(true)
    expect(isFsError(fsError("AlreadyExists", "there"), "AlreadyExists")).toBe(true)
  })

  it("rejects another kind, another code and anything that is not an Error", () => {
    expect(isFsError(new Deno.errors.NotFound("gone"), "AlreadyExists")).toBe(false)
    expect(isFsError(Object.assign(new Error("denied"), { code: "EACCES" }), "NotFound")).toBe(
      false,
    )
    expect(isFsError({ name: "NotFound", code: "ENOENT" }, "NotFound")).toBe(false)
    expect(isFsError(null, "NotFound")).toBe(false)
  })
})
