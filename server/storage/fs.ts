import { denoFileSystem } from "@spy4x/platform/server/deno-fs"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import { uuidV7 } from "@spy4x/platform/universal/uuid"
import type { ObjectFs } from "./ports.ts"

/**
 * Directory that must exist before writing `filePath`, or `undefined` when
 * nothing has to be created.
 *
 * **This is not a sanitiser.** A `..` segment is preserved as given
 * (`"../../evil/x.png"` → `"../../evil"`), and so is a percent-encoded one,
 * because resolving an object key is `paths.ts`'s job: every bucket and key that
 * reaches here has already been validated to be relative and `..`-free, so the
 * only paths this sees are ones a caller produced. A caller that feeds it an
 * unvalidated string gets an unvalidated path — that is the documented contract,
 * not an oversight.
 *
 * Pure, and exported for testing, because the naive form
 * `filePath.slice(0, filePath.lastIndexOf("/"))` is wrong for a bare filename:
 * `lastIndexOf` returns `-1` and `slice(0, -1)` silently drops the last
 * character, so `"out.png"` produced the stray directory `out.pn`. Callers must
 * treat `undefined` as "no directory to create" and never mkdir it.
 */
export function parentDirectory(filePath: string): string | undefined {
  if (filePath === "") return undefined
  const normalized = filePath.replaceAll("\\", "/")
  const cut = normalized.lastIndexOf("/")
  if (cut < 0) return undefined
  const leading = normalized.startsWith("/")
  const parts = normalized
    .slice(leading ? 1 : 0, cut)
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  if (parts.length === 0) return leading ? "/" : undefined
  const parent = parts.join("/")
  return leading ? `/${parent}` : parent
}

/** Creates a directory and every missing parent. Injected so a test needs no `--allow-write`. */
export type MakeDirectory = (path: string) => Promise<void>

/** The real `MakeDirectory`: `Deno.mkdir` with `recursive`, which needs `--allow-write`. */
function makeDirectoryRecursive(path: string): Promise<void> {
  return Deno.mkdir(path, { recursive: true })
}

/**
 * Create the directory holding `filePath`, with every missing parent.
 *
 * Only `AlreadyExists` is swallowed: a file already sits where the directory
 * should be, and the write that follows fails with the precise error
 * (`NotADirectory`). Any other failure, such as a denied permission or a full
 * disk, is thrown, so the caller sees the real cause instead of a later
 * `NotFound` from opening a file in a directory that was never made.
 */
export async function ensureFileDirectory(
  filePath: string,
  makeDirectory: MakeDirectory = makeDirectoryRecursive,
): Promise<void> {
  const parent = parentDirectory(filePath)
  if (parent === undefined) return
  try {
    await makeDirectory(parent)
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error
  }
}

/** What {@link replaceFile} needs besides the write itself. */
interface ReplaceSteps {
  makeDirectory: MakeDirectory
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
}

/**
 * A fresh path in the same directory as `filePath`, so a `rename` onto
 * `filePath` stays on one filesystem and is atomic. The name does not repeat
 * the target's own name, so a long object name cannot push it past the
 * filesystem's name limit.
 */
function temporarySibling(filePath: string): string {
  const parent = parentDirectory(filePath)
  const name = `.${uuidV7()}.part`
  if (parent === undefined) return name
  return parent === "/" ? `/${name}` : `${parent}/${name}`
}

/**
 * Write to a temporary file beside `filePath`, then rename it over `filePath`.
 *
 * A download cut off midway, or any other failed write, leaves the object that
 * was there untouched instead of a truncated one, and the temporary file is
 * removed. The removal is best effort: its own failure never hides the write's
 * error.
 */
async function replaceFile(
  filePath: string,
  write: (path: string) => Promise<number>,
  steps: ReplaceSteps,
): Promise<number> {
  await ensureFileDirectory(filePath, steps.makeDirectory)
  const temporary = temporarySibling(filePath)
  try {
    const count = await write(temporary)
    await steps.rename(temporary, filePath)
    return count
  } catch (error) {
    await steps.remove(temporary).catch(() => {})
    throw error
  }
}

/**
 * `ObjectFs` over a platform `FileSystemPort`: reads with `readBytes`, writes
 * with `writeBytes` or `writeStream`, and checks with `exists`.
 *
 * A write goes to a temporary file in the same directory and is renamed into
 * place, so a write that fails midway (a download whose connection drops)
 * leaves the old object as it was. Reading a missing object rejects with
 * `Deno.errors.NotFound`, as every `ObjectFs` does.
 *
 * @param fs Defaults to `denoFileSystem` of `@spy4x/platform/server/deno-fs`.
 * @throws {TypeError} When `fs` lacks `readBytes`, `writeBytes` or
 * `writeStream`, which the port leaves optional.
 */
export function createObjectFs(fs: FileSystemPort = denoFileSystem): ObjectFs {
  const { readBytes, writeBytes, writeStream } = fs
  if (readBytes === undefined || writeBytes === undefined || writeStream === undefined) {
    throw new TypeError(
      "createObjectFs needs a FileSystemPort with readBytes, writeBytes and writeStream",
    )
  }
  const steps: ReplaceSteps = {
    makeDirectory: (path) => fs.mkdirp(path),
    rename: (from, to) => fs.rename(from, to),
    remove: (path) => fs.remove(path),
  }
  return {
    readObject: async (path) => {
      const bytes = await readBytes.call(fs, path)
      if (bytes === null) throw new Deno.errors.NotFound(`No such object: ${path}`)
      return bytes
    },
    existsObject: (path) => fs.exists(path),
    writeObject: (path, data) =>
      replaceFile(path, async (target) => {
        if (!(data instanceof Uint8Array)) return await writeStream.call(fs, target, data)
        await writeBytes.call(fs, target, data)
        return data.byteLength
      }, steps),
  }
}

/**
 * Write a byte array to `filePath` and report how many bytes were written.
 *
 * The whole write path past the filesystem call is one function used by both
 * `ObjectFs` branches, so the byte count, the `write` flags and the
 * closer-on-error path are exercised without needing `--allow-write`.
 *
 * Every buffer and every streamed chunk is written in full: a handle may write
 * only part of what it is given (a nearly full disk, or a buffer over the
 * kernel's per-call cap), so `writeFully` keeps writing the remainder. A write
 * that makes no progress rejects with `Deno.errors.WriteZero` instead of
 * looping forever or reporting bytes that never landed.
 */
export async function writeToFile(
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  open: OpenFile = openFileForWrite,
  makeDirectory: MakeDirectory = makeDirectoryRecursive,
): Promise<number> {
  await ensureFileDirectory(path, makeDirectory)
  const file = await open(path)
  if (data instanceof Uint8Array) {
    // Both branches close explicitly on error and on success. The closer is the
    // same tolerance path as the streamed branch, and it is pinned by
    // `closes the handle and rethrows when a whole-buffer write fails`.
    try {
      await writeFully(file, data)
    } catch (error) {
      closeQuietly(file)
      throw error
    }
    closeQuietly(file)
    return data.byteLength
  }
  let total = 0
  try {
    await data.pipeTo(
      new WritableStream<Uint8Array>({
        async write(chunk) {
          await writeFully(file, chunk)
          total += chunk.byteLength
        },
      }),
    )
  } catch (error) {
    closeQuietly(file)
    throw error
  }
  closeQuietly(file)
  return total
}

/**
 * Write every byte of `data`, advancing by the count each `write` returns.
 * `@std/io`'s `writeAll` is not in the import map, so this is the small loop;
 * unlike a bare loop it also rejects a `write` that returns 0.
 */
async function writeFully(file: WritableFileHandle, data: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < data.byteLength) {
    const written = await file.write(data.subarray(offset))
    if (written <= 0) {
      throw new Deno.errors.WriteZero(
        `write made no progress after ${offset} of ${data.byteLength} bytes`,
      )
    }
    offset += written
  }
}

/** Minimal file handle `writeToFile` needs. A `Deno.FsFile` satisfies it. */
export interface WritableFileHandle {
  write(data: Uint8Array): Promise<number>
  close(): void
}

/** Opens `path` for writing. Injected so a test needs no filesystem permission. */
export type OpenFile = (path: string) => Promise<WritableFileHandle>

/**
 * Default opener: create or truncate, and let the caller build the directory.
 *
 * This is the only statement in this module the suite cannot reach: it is a
 * platform call that needs `--allow-write`. The flags it passes are what
 * `Deno.open` is asserted against in the docs, not in a test.
 */
function openFileForWrite(path: string): Promise<WritableFileHandle> {
  return Deno.open(path, { create: true, write: true, truncate: true })
}

/** Close a file handle, ignoring a handle that a failed write already closed. */
function closeQuietly(file: WritableFileHandle): void {
  try {
    file.close()
  } catch {
    // Already closed. The original write error is the one worth propagating.
  }
}

/**
 * Minimal `Deno` surface `createDenoObjectFs` uses. Injected so a test needs no permission.
 *
 * A new caller injects a `FileSystemPort` into {@link createObjectFs} instead.
 */
export interface DenoFsHost {
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<unknown>
  writeFile(path: string, data: Uint8Array): Promise<void>
  open(path: string): Promise<WritableFileHandle>
  /** Creates a directory and its parents. Without it, `Deno.mkdir` is used. */
  mkdir?(path: string): Promise<void>
  /**
   * Renames a file over another. With it, a write goes to a temporary file and
   * is renamed into place; without it, the write truncates the target first.
   */
  rename?(from: string, to: string): Promise<void>
  /** Removes the temporary file of a failed write. */
  remove?(path: string): Promise<void>
}

/** The real host: every call is a platform call and needs `--allow-read` or `--allow-write`. */
export const denoFsHost: DenoFsHost = {
  readFile: (path) => Deno.readFile(path),
  stat: (path) => Deno.stat(path),
  writeFile: (path, data) => Deno.writeFile(path, data),
  open: (path) => openFileForWrite(path),
  mkdir: (path) => makeDirectoryRecursive(path),
  rename: (from, to) => Deno.rename(from, to),
  remove: (path) => Deno.remove(path),
}

/**
 * `ObjectFs` backed by `Deno`. Read paths need `--allow-read`; `writeObject`
 * needs `--allow-write`.
 *
 * Without `host` it is {@link createObjectFs} over the platform's
 * `denoFileSystem`, and the integration tier runs the `ObjectFs` contract
 * against it. With `host`, every call goes through that host, which is how the
 * unit tier drives the stat-to-boolean decision, both write branches, the byte
 * count and the closer-on-error path without `--allow-write`. Either way a
 * write is renamed into place when it can be: always without `host`, and with
 * a host that has `rename`.
 */
export function createDenoObjectFs(host?: DenoFsHost): ObjectFs {
  if (host === undefined) return createObjectFs(denoFileSystem)
  const makeDirectory = host.mkdir === undefined ? makeDirectoryRecursive : host.mkdir.bind(host)
  const rename = host.rename?.bind(host)
  const remove = host.remove?.bind(host) ?? (() => Promise.resolve())
  return {
    readObject: (path) => host.readFile(path),
    existsObject: async (path) => {
      try {
        await host.stat(path)
        return true
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false
        // A denied or otherwise-failed stat is not "missing": rethrowing lets
        // `doesExist` tell the two apart instead of reading a permission error
        // as an absent object.
        throw error
      }
    },
    writeObject: (path, data) => {
      const write = (target: string) =>
        writeToFile(target, data, (file) => host.open(file), makeDirectory)
      if (rename === undefined) return write(path)
      return replaceFile(path, write, { makeDirectory, rename, remove })
    },
  }
}
