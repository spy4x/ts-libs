/**
 * Atomic JSON persistence: read a document, and replace one without ever leaving a half-written
 * file behind.
 *
 * "Atomic" here means the target path is only ever replaced by `rename`, which is atomic within
 * one filesystem — a reader sees either the old document or the new one, never a partial write.
 * The temporary file carries the pid so two processes sharing a directory cannot collide on it.
 *
 * Everything goes through a {@link FileSystemPort}, so all of this is testable with an in-memory
 * fake under the root test task's `--allow-read --allow-env` grant.
 */

import { dirname } from "@std/path"

import type { FileSystemPort } from "./ports.ts"

/** Result of reading a JSON document. */
export type ReadJsonResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "missing" }
  | { kind: "invalid"; raw: string; reason: string }

/**
 * Read and parse a JSON document.
 *
 * A missing file is `{ kind: "missing" }`, not an error: a first run has no state yet. Unparseable
 * content is `{ kind: "invalid" }` and keeps the raw text, so a caller can quarantine or repair it
 * instead of silently starting from scratch.
 */
export async function readJsonFile<T>(
  fs: FileSystemPort,
  path: string,
): Promise<ReadJsonResult<T>> {
  const raw = await fs.readText(path)
  if (raw === null) return { kind: "missing" }
  try {
    return { kind: "ok", value: JSON.parse(raw) as T }
  } catch (error) {
    return {
      kind: "invalid",
      raw,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Where a temporary file should live, given the document it will replace. */
export interface TempPathOptions {
  /** Uniquifier, normally the process id. */
  pid: number
  /** Uniquifier, normally a monotonic counter. */
  sequence: number
}

/**
 * Build the temp path for an atomic write: `<path>.<pid>.<sequence>.tmp`.
 *
 * The suffix is appended rather than prepended so the file stays in the target directory (a
 * rename across filesystems is not atomic) and remains visible to a `*.json` cleanup glob.
 */
export function tempPathFor(path: string, options: TempPathOptions): string {
  return `${path}.${options.pid}.${options.sequence}.tmp`
}

/**
 * Serialise `value` and replace `path` with it atomically.
 *
 * Write-temp-then-rename, with the temp removed if either step throws so a failed write does not
 * leave litter next to the real document.
 *
 * @returns the temp path that was renamed away.
 */
export async function atomicWriteJson(
  fs: FileSystemPort,
  path: string,
  value: unknown,
  options: TempPathOptions,
  /** Indentation passed to `JSON.stringify`. `0` for compact. */
  space = 2,
): Promise<string> {
  const temp = tempPathFor(path, options)
  try {
    await fs.mkdirp(dirname(path))
    await fs.writeText(temp, JSON.stringify(value, null, space))
    await fs.rename(temp, path)
  } catch (error) {
    await fs.remove(temp).catch(() => {})
    throw error
  }
  return temp
}
