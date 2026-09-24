/**
 * {@link denoFileSystem}, the `Deno`-backed implementation of `FileSystemPort`.
 *
 * @module
 */

import { join } from "@std/path"

import type { ByteReader, FileSystemPort, LockHandle, WalkEntry } from "./ports.ts"

/** Node/Deno error shape carrying a string code — `ENOENT`, `EEXIST`, … */
interface CodedError {
  code?: string
}

function isNotFound(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true
  return (error as CodedError | null)?.code === "ENOENT"
}

/**
 * {@link FileSystemPort} backed by Deno's filesystem APIs.
 *
 * Every method body is a thin wrapper over one documented `Deno` call, which is why this file
 * holds the package's only untested statements: the root test task grants `--allow-read` and
 * `--allow-env` only, so no test here may write. The *decisions* — which file to write, when to
 * flush, which entry to skip — are tested against an in-memory fake in the modules that use this
 * port. Reviewers should read this file as the boundary, not as logic.
 *
 * `readText` and `readDir` map a missing path to `null` / `[]` so callers do not need to know
 * which of Deno's two not-found shapes a platform produces.
 */
export const denoFileSystem: FileSystemPort = {
  async exists(path) {
    try {
      await Deno.stat(path)
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  },

  async readText(path) {
    try {
      return await Deno.readTextFile(path)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  },

  writeText(path, content) {
    return Deno.writeTextFile(path, content)
  },

  appendText(path, content) {
    return Deno.writeTextFile(path, content, { append: true, create: true })
  },

  rename(from, to) {
    return Deno.rename(from, to)
  },

  async remove(path) {
    try {
      await Deno.remove(path)
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
  },

  mkdirp(path) {
    return Deno.mkdir(path, { recursive: true }).then(() => {})
  },

  async readDir(path): Promise<WalkEntry[]> {
    const entries: WalkEntry[] = []
    try {
      for await (const entry of Deno.readDir(path)) {
        entries.push({
          name: entry.name,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
        })
      }
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }
    return Promise.all(
      entries.map((entry) => withSize(join(path, entry.name), entry)),
    )
  },

  async lock(path): Promise<LockHandle | null> {
    const file = await Deno.open(path, { create: true, write: true, read: false })
    if (!file.tryLockSync(true)) {
      file.close()
      return null
    }
    let released = false
    return {
      release: () => {
        if (released) return Promise.resolve()
        released = true
        try {
          file.unlockSync()
        } catch {
          // Best effort: the descriptor is closed below either way.
        }
        file.close()
        return Promise.resolve()
      },
    }
  },
}

/** Stat a file entry for its byte size; an entry that vanished mid-listing keeps no size. */
async function withSize(path: string, entry: WalkEntry): Promise<WalkEntry> {
  if (!entry.isFile) return entry
  try {
    const stat = await Deno.stat(path)
    return { ...entry, size: stat.size }
  } catch {
    return entry
  }
}

/** {@link ByteReader} over one file, read in chunks so a large file never lands in memory at once. */
export function denoByteReader(path: string, chunkSize = 64 * 1024): ByteReader {
  return {
    async *chunks() {
      const file = await Deno.open(path, { read: true })
      try {
        const buffer = new Uint8Array(chunkSize)
        for (;;) {
          const read = await file.read(buffer)
          if (read === null) return
          // Copy: the next read overwrites `buffer`.
          yield buffer.slice(0, read)
        }
      } finally {
        file.close()
      }
    },
  }
}
