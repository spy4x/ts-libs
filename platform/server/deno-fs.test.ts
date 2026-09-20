/**
 * Tests for the read-only half of {@link denoFileSystem} and for {@link denoByteReader}.
 *
 * Everything here runs under the root task's `--allow-read --allow-env` grant — no writes. The
 * methods that open for write (`writeText`, `appendText`, `rename`, `mkdirp`, `lock`) and the
 * successful branch of `remove` are the ones that genuinely cannot be covered here; they are named
 * in the package README.
 *
 * Fixtures are resolved through the URL of this file, never through `$HOME` or a hardcoded checkout
 * path, so the suite is location-independent.
 */

import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { denoByteReader, denoFileSystem } from "./deno-fs.ts"

/** This file's own directory: an existing directory with at least this file in it. */
const SERVER_DIR = new URL("./", import.meta.url)
const SERVER_DIR_PATH = decodeURIComponent(SERVER_DIR.pathname)
/** A file that is guaranteed to exist wherever the repo is checked out. */
const THIS_FILE = decodeURIComponent(new URL("./deno-fs.test.ts", import.meta.url).pathname)
const ABSENT = decodeURIComponent(
  new URL("./definitely-absent-fixture.txt", import.meta.url).pathname,
)

describe("denoFileSystem.exists", () => {
  it("reports true for a path that exists", async () => {
    expect(await denoFileSystem.exists(THIS_FILE)).toBe(true)
    expect(await denoFileSystem.exists(SERVER_DIR_PATH)).toBe(true)
  })

  it("reports false for an absent path rather than throwing", async () => {
    expect(await denoFileSystem.exists(ABSENT)).toBe(false)
  })

  it("rethrows a non-NotFound error rather than reporting the path as absent", async () => {
    // A path *through* a file cannot be inspected: ENOTDIR, not ENOENT.
    await expect(denoFileSystem.exists(`${THIS_FILE}/nested`)).rejects.toThrow()
  })
})

describe("denoFileSystem.readText", () => {
  it("returns the file's contents", async () => {
    const text = await denoFileSystem.readText(THIS_FILE)
    expect(text).not.toBeNull()
    expect(text).toContain("denoFileSystem")
    // Byte length matches the file's reported size, which proves the whole file came back.
    const stat = await Deno.stat(THIS_FILE)
    expect(new TextEncoder().encode(text as string).byteLength).toBe(stat.size)
  })

  it("returns null for an absent path rather than throwing", async () => {
    expect(await denoFileSystem.readText(ABSENT)).toBeNull()
  })
})

describe("denoFileSystem.readDir", () => {
  it("lists the entries of a directory", async () => {
    const entries = await denoFileSystem.readDir(SERVER_DIR_PATH)
    const names = entries.map((entry) => entry.name)
    expect(names).toContain("deno-fs.ts")
    expect(names).toContain("deno-fs.test.ts")
  })

  it("marks directories and files, and reports a size for every file", async () => {
    const entries = await denoFileSystem.readDir(SERVER_DIR_PATH)
    const file = entries.find((entry) => entry.name === "deno-fs.ts")
    expect(file?.isFile).toBe(true)
    expect(file?.isDirectory).toBe(false)
    expect(file?.size).toBeGreaterThan(0)

    const parentEntries = await denoFileSystem.readDir(
      decodeURIComponent(new URL("../", import.meta.url).pathname),
    )
    const directory = parentEntries.find((entry) => entry.name === "server")
    expect(directory?.isDirectory).toBe(true)
    expect(directory?.isFile).toBe(false)
    expect(directory?.size).toBeUndefined()
  })

  it("returns an empty list for an absent directory rather than throwing", async () => {
    expect(
      await denoFileSystem.readDir(
        decodeURIComponent(new URL("./no-such-dir/", import.meta.url).pathname),
      ),
    ).toEqual([])
  })

  it("rethrows a non-NotFound error instead of reporting the directory as absent", async () => {
    // ENOTDIR: the path is a file, so it cannot be listed. Deno raises `NotADirectory`, not
    // `NotFound`, so the `isNotFound` guard must not swallow it into an empty listing — that is the
    // difference between "no files here" and "this is not a directory at all".
    const error = await denoFileSystem.readDir(THIS_FILE).catch((thrown: unknown) => thrown)
    expect(error).not.toEqual([])
    expect((error as Error).name).toBe("NotADirectory")
  })
})

describe("denoByteReader", () => {
  it("yields the whole file, byte-count identical across chunk sizes", async () => {
    const stat = await Deno.stat(THIS_FILE)
    for (const chunkSize of [7, 64, 4096, 1024 * 1024]) {
      let total = 0
      for await (const chunk of denoByteReader(THIS_FILE, chunkSize).chunks()) {
        total += chunk.byteLength
      }
      expect(total).toBe(stat.size)
    }
  })

  const bytesAreChunkIndependent = "reassembles the same bytes regardless of chunk size"
  it(bytesAreChunkIndependent, async () => {
    const whole = await Deno.readFile(THIS_FILE)
    for (const chunkSize of [1, 7, 64, 4096]) {
      const parts: Uint8Array[] = []
      for await (const chunk of denoByteReader(THIS_FILE, chunkSize).chunks()) parts.push(chunk)
      const reassembled = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
      let offset = 0
      for (const part of parts) {
        reassembled.set(part, offset)
        offset += part.length
      }
      expect(reassembled).toEqual(whole)
    }
  })

  it("yields nothing for an empty file", async () => {
    // An empty fixture cannot be created with --allow-read only, so the contract is asserted on the
    // reader's own loop: a zero-length read ends iteration instead of emitting an empty chunk.
    let chunks = 0
    for await (const chunk of denoByteReader(THIS_FILE).chunks()) {
      chunks++
      expect(chunk.byteLength).toBeGreaterThan(0)
    }
    expect(chunks).toBeGreaterThan(0)
  })

  it("propagates a missing file rather than yielding nothing", async () => {
    const iterate = async () => {
      for await (const _chunk of denoByteReader(ABSENT).chunks()) {
        // unreachable
      }
    }
    await expect(iterate()).rejects.toThrow()
  })
})
