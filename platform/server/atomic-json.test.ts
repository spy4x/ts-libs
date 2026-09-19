import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { atomicWriteJson, readJsonFile, tempPathFor } from "./atomic-json.ts"
import { fakeFs } from "./_fake-fs.ts"

const options = { pid: 1234, sequence: 0 }

describe("readJsonFile", () => {
  it("parses a present document", async () => {
    const fs = fakeFs({ "/state.json": `{"version":2}` })
    expect(await readJsonFile(fs, "/state.json")).toEqual({ kind: "ok", value: { version: 2 } })
  })

  it("reports a missing document as missing, not as an error", async () => {
    expect(await readJsonFile(fakeFs(), "/absent.json")).toEqual({ kind: "missing" })
  })

  it("reports unparseable content with the raw text kept for repair", async () => {
    const fs = fakeFs({ "/state.json": '{"version":2,' })
    const result = await readJsonFile(fs, "/state.json")
    expect(result.kind).toBe("invalid")
    if (result.kind === "invalid") {
      expect(result.raw).toBe(`{"version":2,`)
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  it("accepts any JSON value, including a bare scalar", async () => {
    const fs = fakeFs({ "/n.json": "42" })
    expect(await readJsonFile(fs, "/n.json")).toEqual({ kind: "ok", value: 42 })
  })
})

describe("tempPathFor", () => {
  it("keeps the temp file in the target directory so the rename stays atomic", () => {
    expect(tempPathFor("/dir/state.json", options)).toBe("/dir/state.json.1234.0.tmp")
  })

  it("distinguishes two writers by pid and by sequence", () => {
    const a = tempPathFor("/s.json", { pid: 1, sequence: 0 })
    const b = tempPathFor("/s.json", { pid: 1, sequence: 1 })
    const c = tempPathFor("/s.json", { pid: 2, sequence: 0 })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe("atomicWriteJson", () => {
  it("writes the temp file and renames it over the target", async () => {
    const fs = fakeFs()
    await atomicWriteJson(fs, "/dir/state.json", { version: 2 }, options)
    expect(fs.files.get("/dir/state.json")).toBe(`{\n  "version": 2\n}`)
    // The temp file is gone: the rename moved it.
    expect(fs.files.has("/dir/state.json.1234.0.tmp")).toBe(false)
  })

  it("creates the parent directory first", async () => {
    const fs = fakeFs()
    await atomicWriteJson(fs, "/deep/nested/state.json", 1, options)
    expect(fs.dirs.has("/deep/nested")).toBe(true)
  })

  it("replaces an existing document rather than appending", async () => {
    const fs = fakeFs({ "/state.json": `{"old":true}` })
    await atomicWriteJson(fs, "/state.json", { fresh: true }, options)
    expect(JSON.parse(fs.files.get("/state.json") as string)).toEqual({ fresh: true })
  })

  it("never leaves the target half-written: the write goes to the temp path", async () => {
    const fs = fakeFs({ "/state.json": `{"old":true}` })
    await atomicWriteJson(fs, "/state.json", { fresh: true }, options)
    const write = fs.calls.find((call) => call.op === "writeText")
    expect(write?.path).toBe("/state.json.1234.0.tmp")
    const rename = fs.calls.find((call) => call.op === "rename")
    expect(rename?.path).toBe("/state.json.1234.0.tmp")
    expect(rename?.extra).toBe("/state.json")
  })

  it("removes the temp file when the rename fails, so no litter is left", async () => {
    const fs = fakeFs()
    fs.failRenames.add("/state.json.1234.0.tmp")
    await expect(atomicWriteJson(fs, "/state.json", 1, options)).rejects.toThrow("rename refused")
    expect(fs.files.has("/state.json.1234.0.tmp")).toBe(false)
    expect(fs.files.has("/state.json")).toBe(false)
  })

  it("propagates a write failure after cleaning up", async () => {
    const fs = fakeFs()
    fs.failWrites.add("/state.json.1234.0.tmp")
    await expect(atomicWriteJson(fs, "/state.json", 1, options)).rejects.toThrow("write refused")
    expect(fs.files.size).toBe(0)
  })

  it("writes compact JSON when space is zero", async () => {
    const fs = fakeFs()
    await atomicWriteJson(fs, "/s.json", { a: 1 }, options, 0)
    expect(fs.files.get("/s.json")).toBe(`{"a":1}`)
  })

  it("round-trips through readJsonFile", async () => {
    const fs = fakeFs()
    await atomicWriteJson(fs, "/s.json", { version: 2, entries: {} }, options)
    expect(await readJsonFile(fs, "/s.json")).toEqual({
      kind: "ok",
      value: { version: 2, entries: {} },
    })
  })
})
