/**
 * {@link runtimeFileSystem}, a `FileSystemPort` for whichever runtime runs it, and
 * {@link nodeFileSystem}, the one for Node and Bun.
 *
 * `node:fs/promises` is imported on the first call on Node or Bun, never at import time, so Deno
 * code that only imports this module never loads it, and its type check never sees Node's types.
 *
 * @example
 * ```ts
 * const fs = runtimeFileSystem
 * const keys = await fs.readText("/run/secrets/vapid.json")
 * const dir = await fs.makeTempDir!("/tmp")
 * try {
 *   await fs.writeBytes!(`${dir}/original`, new Uint8Array([1, 2, 3]))
 * } finally {
 *   await fs.removeTree!(dir)
 * }
 * ```
 *
 * @module
 */

import { join } from "@std/path"

import { currentHost, fileSystemOver } from "./_runtime-host.ts"
import { denoFileSystem } from "./deno-fs.ts"
import type { FileSystemPort, WalkEntry } from "./ports.ts"

/** A `node:fs/promises` file handle, as far as this file uses it. */
interface NodeFileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>
  write(data: Uint8Array): Promise<unknown>
  close(): Promise<void>
}

/** `node:fs/promises`, as far as this file uses it. */
interface NodeFs {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string, encoding: "utf8"): Promise<string>
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: string | Uint8Array, options: { mode?: number }): Promise<void>
  appendFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force?: boolean; recursive?: boolean }): Promise<void>
  mkdir(path: string, options: { recursive: true }): Promise<unknown>
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<{ name: string; isFile(): boolean; isDirectory(): boolean }[]>
  open(path: string, flags: string, mode?: number): Promise<NodeFileHandle>
  mkdtemp(prefix: string): Promise<string>
}

let nodeFsModule: Promise<NodeFs> | undefined

/**
 * Load `node:fs/promises` without letting the type checker resolve it. A literal specifier makes
 * `deno check` pull `@types/node` into every program that imports this module, which retypes
 * `setTimeout` as returning a `Timeout` and breaks code that stores its handle as a `number`
 * (`server/db/testing/node-sqlite-driver.ts` measured the same).
 */
const nodeFs = (): Promise<NodeFs> =>
  nodeFsModule ??= import(["node", "fs/promises"].join(":")) as Promise<NodeFs>

function isNotFound(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "ENOENT"
}

/** `null` instead of a not-found error from `read`. */
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** A plain `Uint8Array` view of a Node `Buffer`, so it compares equal to one. */
function plainBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

/**
 * {@link FileSystemPort} over `node:fs/promises`, for Node and Bun. Every method is a thin wrapper
 * over one documented call, and a missing path maps to `null`, `false` or `[]` as in
 * `denoFileSystem`.
 *
 * `lock` always rejects: neither Node nor Bun has an advisory file lock, and a lock file made
 * with an exclusive create would outlive a crashed holder and lock the job forever.
 */
export const nodeFileSystem: FileSystemPort = {
  async exists(path) {
    const fs = await nodeFs()
    return (await orNull(() => fs.stat(path))) !== null
  },

  async readText(path) {
    const fs = await nodeFs()
    return await orNull(() => fs.readFile(path, "utf8"))
  },

  async writeText(path, content, options) {
    await (await nodeFs()).writeFile(path, content, { mode: options?.mode })
  },

  async appendText(path, content) {
    await (await nodeFs()).appendFile(path, content)
  },

  async rename(from, to) {
    await (await nodeFs()).rename(from, to)
  },

  async remove(path) {
    await (await nodeFs()).rm(path, { force: true })
  },

  async mkdirp(path) {
    await (await nodeFs()).mkdir(path, { recursive: true })
  },

  async readDir(path): Promise<WalkEntry[]> {
    const fs = await nodeFs()
    const entries = await orNull(() => fs.readdir(path, { withFileTypes: true }))
    if (entries === null) return []
    return await Promise.all(entries.map(async (entry): Promise<WalkEntry> => {
      const listed = { name: entry.name, isDirectory: entry.isDirectory(), isFile: entry.isFile() }
      if (!listed.isFile) return listed
      // An entry that vanished mid-listing keeps no size, as in `denoFileSystem`.
      const stat = await fs.stat(join(path, entry.name)).catch(() => null)
      return stat ? { ...listed, size: stat.size } : listed
    }))
  },

  lock() {
    return Promise.reject(new Error("no file lock on Node or Bun: use denoFileSystem on Deno"))
  },

  async readBytes(path) {
    const fs = await nodeFs()
    const data = await orNull(() => fs.readFile(path))
    return data === null ? null : plainBytes(data)
  },

  async writeBytes(path, data, options) {
    await (await nodeFs()).writeFile(path, data, { mode: options?.mode })
  },

  async readStream(path) {
    const fs = await nodeFs()
    const file = await orNull(() => fs.open(path, "r"))
    if (file === null) return null
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const buffer = new Uint8Array(64 * 1024)
          const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null)
          if (bytesRead > 0) return controller.enqueue(buffer.subarray(0, bytesRead))
          await file.close()
          controller.close()
        } catch (error) {
          await file.close().catch(() => {})
          controller.error(error)
        }
      },
      cancel: () => file.close(),
    })
  },

  async writeStream(path, source, options) {
    const fs = await nodeFs()
    const file = await fs.open(path, "w", options?.mode)
    let written = 0
    try {
      for await (const chunk of source) {
        await file.write(chunk)
        written += chunk.byteLength
      }
    } finally {
      await file.close()
    }
    return written
  },

  async makeTempDir(parent) {
    return await (await nodeFs()).mkdtemp(join(parent, "tmp-"))
  },

  async removeTree(path) {
    await (await nodeFs()).rm(path, { recursive: true, force: true })
  },
}

/**
 * The file system of the running runtime: `denoFileSystem` on Deno, {@link nodeFileSystem} on
 * Node and Bun. Every optional method of `FileSystemPort` is there; `lock` works on Deno only.
 *
 * On Deno each call needs the matching `--allow-read` or `--allow-write`.
 */
export const runtimeFileSystem: FileSystemPort = fileSystemOver(currentHost, {
  deno: denoFileSystem,
  node: nodeFileSystem,
})
