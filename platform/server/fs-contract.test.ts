// The `FileSystemPort` contract, written once and run against both implementations:
// `_fake-fs.test.ts` runs it on the in-memory fake in the unit tier, and
// `deno-fs.integration.test.ts` runs it on `denoFileSystem` in a real scratch folder. Every server
// module in this package is tested through the fake, so a case the fake gets wrong here is a case
// those tests get wrong too.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeFileSystemContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import type { FileSystemPort } from "./ports.ts"

/** A port, an existing empty folder to work in, and how to dispose of both. */
export interface FileSystemFixture {
  fs: FileSystemPort
  /** Absolute path of an existing, empty folder that belongs to this case alone. */
  root: string
  close(): Promise<void>
}

/** Opens a fresh fixture for one case. */
export type OpenFileSystem = () => Promise<FileSystemFixture>

/** Runs `body` on a fresh fixture and closes it, whether the body passed or not. */
async function withFixture(
  open: OpenFileSystem,
  body: (fs: FileSystemPort, root: string) => Promise<void>,
): Promise<void> {
  const fixture = await open()
  try {
    await body(fixture.fs, fixture.root)
  } finally {
    await fixture.close()
  }
}

/** Registers the contract suite for one implementation. */
export function describeFileSystemContract(name: string, open: OpenFileSystem): void {
  describe(`${name} (file system contract)`, () => {
    it("writeText replaces the whole content of an existing file", async () => {
      await withFixture(open, async (fs, root) => {
        const path = `${root}/a.txt`
        await fs.writeText(path, "a longer first version")
        await fs.writeText(path, "short")
        expect(await fs.readText(path)).toBe("short")
        expect(await fs.exists(path)).toBe(true)
      })
    })

    it("refuses to write, append, rename or lock into a folder that does not exist", async () => {
      await withFixture(open, async (fs, root) => {
        await expect(fs.writeText(`${root}/missing/a.txt`, "x")).rejects.toThrow()
        await expect(fs.appendText(`${root}/missing/a.txt`, "x")).rejects.toThrow()
        await fs.writeText(`${root}/source.txt`, "kept")
        await expect(fs.rename(`${root}/source.txt`, `${root}/missing/a.txt`)).rejects.toThrow()
        await expect(fs.lock(`${root}/missing/.job.lock`)).rejects.toThrow()
        expect(await fs.exists(`${root}/missing`)).toBe(false)
        expect(await fs.readText(`${root}/source.txt`)).toBe("kept")
      })
    })

    it("appendText creates a missing file, then adds to its end", async () => {
      await withFixture(open, async (fs, root) => {
        const path = `${root}/log.jsonl`
        await fs.appendText(path, "one\n")
        await fs.appendText(path, "two\n")
        expect(await fs.readText(path)).toBe("one\ntwo\n")
      })
    })

    it("rename over an existing file replaces it and removes the source", async () => {
      await withFixture(open, async (fs, root) => {
        await fs.writeText(`${root}/target.json`, "old")
        await fs.writeText(`${root}/target.json.tmp`, "new")
        await fs.rename(`${root}/target.json.tmp`, `${root}/target.json`)
        expect(await fs.readText(`${root}/target.json`)).toBe("new")
        expect(await fs.exists(`${root}/target.json.tmp`)).toBe(false)
      })
    })

    it("rename of a missing source rejects and leaves the target alone", async () => {
      await withFixture(open, async (fs, root) => {
        await fs.writeText(`${root}/target.json`, "kept")
        await expect(fs.rename(`${root}/absent`, `${root}/target.json`)).rejects.toThrow()
        expect(await fs.readText(`${root}/target.json`)).toBe("kept")
      })
    })

    it("remove deletes a file, and a missing path is not an error", async () => {
      await withFixture(open, async (fs, root) => {
        const path = `${root}/gone.txt`
        await fs.writeText(path, "x")
        await fs.remove(path)
        expect(await fs.exists(path)).toBe(false)
        expect(await fs.readText(path)).toBeNull()
        await fs.remove(path)
        await fs.remove(`${root}/never-existed/either`)
      })
    })

    it("mkdirp creates the folder and every missing parent, and runs twice", async () => {
      await withFixture(open, async (fs, root) => {
        await fs.mkdirp(`${root}/a/b/c`)
        await fs.mkdirp(`${root}/a/b/c`)
        expect(await fs.exists(`${root}/a`)).toBe(true)
        expect(await fs.exists(`${root}/a/b`)).toBe(true)
        expect(await fs.exists(`${root}/a/b/c`)).toBe(true)
        await fs.writeText(`${root}/a/b/c/file.txt`, "x")
        expect(await fs.readText(`${root}/a/b/c/file.txt`)).toBe("x")
      })
    })

    it("readDir lists one level, with a file's size in bytes", async () => {
      await withFixture(open, async (fs, root) => {
        await fs.mkdirp(`${root}/sub/deeper`)
        await fs.writeText(`${root}/sub/inner.txt`, "x")
        await fs.writeText(`${root}/top.txt`, "ü€") // 2 + 3 bytes, 2 UTF-16 code units
        const entries = await fs.readDir(root)
        entries.sort((left, right) => left.name.localeCompare(right.name))
        expect(entries).toEqual([
          { name: "sub", isDirectory: true, isFile: false },
          { name: "top.txt", isDirectory: false, isFile: true, size: 5 },
        ])
        expect(await fs.readDir(`${root}/absent`)).toEqual([])
      })
    })

    it("lock refuses a second holder until the first releases", async () => {
      await withFixture(open, async (fs, root) => {
        const path = `${root}/.job.lock`
        const first = await fs.lock(path)
        expect(first).not.toBeNull()
        expect(await fs.lock(path)).toBeNull()
        await first!.release()
        await first!.release()
        const second = await fs.lock(path)
        expect(second).not.toBeNull()
        await second!.release()
      })
    })

    it("lock leaves an empty lock file behind, as the real one does", async () => {
      await withFixture(open, async (fs, root) => {
        const path = `${root}/.job.lock`
        const handle = await fs.lock(path)
        expect(await fs.readText(path)).toBe("")
        await handle!.release()
        expect(await fs.exists(path)).toBe(true)
      })
    })
  })
}
