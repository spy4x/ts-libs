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

/**
 * Create the directory holding `filePath`. `Deno.mkdir` with `recursive` makes
 * every missing parent, and an already-existing path is swallowed rather than
 * failing a retried write.
 */
export async function ensureFileDirectory(filePath: string): Promise<void> {
  const parent = parentDirectory(filePath)
  if (parent === undefined) return
  await Deno.mkdir(parent, { recursive: true }).catch(() => {})
}

/**
 * Write a byte array to `filePath` and report how many bytes were written.
 *
 * The whole write path past the filesystem call is one function used by both
 * `ObjectFs` branches, so the byte count, the `write` flags and the
 * closer-on-error path are exercised without needing `--allow-write`.
 */
export async function writeToFile(
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  open: OpenFile = openFileForWrite,
): Promise<number> {
  await ensureFileDirectory(path)
  const file = await open(path)
  if (data instanceof Uint8Array) {
    // Both branches close explicitly on error and on success. The closer is the
    // same tolerance path as the streamed branch, and it is pinned by
    // `closes the handle and rethrows when a whole-buffer write fails`.
    try {
      await file.write(data)
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
          total += chunk.byteLength
          await file.write(chunk)
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

/** Minimal `Deno` surface `createDenoObjectFs` uses. Injected so a test needs no permission. */
export interface DenoFsHost {
  readFile(path: string): Promise<Uint8Array>
  stat(path: string): Promise<unknown>
  writeFile(path: string, data: Uint8Array): Promise<void>
  open(path: string): Promise<WritableFileHandle>
}

/** The real host: every call is a platform call and needs `--allow-read` or `--allow-write`. */
export const denoFsHost: DenoFsHost = {
  readFile: (path) => Deno.readFile(path),
  stat: (path) => Deno.stat(path),
  writeFile: (path, data) => Deno.writeFile(path, data),
  open: (path) => openFileForWrite(path),
}

/**
 * `ObjectFs` backed by `Deno`. Read paths need `--allow-read`; `writeObject`
 * needs `--allow-write`, which the repo test task deliberately does not grant,
 * so the suite drives `writeToFile` with an injected opener and the local
 * provider with an in-memory `ObjectFs` instead.
 *
 * `host` is the one seam that is not covered by a real call in the suite: with
 * `denoFsHost` it is `Deno.readFile`/`stat`/`writeFile`/`open`, i.e. platform
 * calls. Everything around it — the stat-to-boolean decision, both write
 * branches, the byte count and the closer-on-error path — is covered through an
 * injected host.
 */
export function createDenoObjectFs(host: DenoFsHost = denoFsHost): ObjectFs {
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
    writeObject: (path, data) => writeToFile(path, data, (target) => host.open(target)),
  }
}
