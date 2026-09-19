/**
 * Atomic in-place file rewrite, behind a filesystem port.
 *
 * The publishable idea from `lyrics-populator/src/metadata.ts:164-231`
 * (`writeMetadata`): mutate a *copy*, verify the copy, then rename it over the
 * original, so a writer that dies halfway leaves the original intact. What is
 * not ported is the Vorbis implementation behind it — the extraction issue
 * records that writer as silently corrupting comment bodies over 65,025 bytes.
 *
 * Two things are separated on purpose:
 *
 * - `withAtomicRewrite` orchestrates copy → mutate → write → verify → rename
 *   and touches the filesystem only through `RewriteFileSystem`. The repository
 *   test task grants `--allow-read --allow-env` and no `--allow-write`, so the
 *   port is what makes this module testable at all.
 * - `verdictSizeDelta` is the pure half of the source's verification step: a
 *   rewrite may not lose a quarter of the file or add a megabyte without
 *   somebody looking.
 */

import { basename, dirname, join } from "@std/path"

/** The filesystem operations an atomic rewrite needs. */
export interface RewriteFileSystem {
  copyFile(from: string, to: string): Promise<void>
  writeFile(path: string, bytes: Uint8Array): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  /** Size in bytes. */
  size(path: string): Promise<number>
  exists(path: string): Promise<boolean>
}

/** The result of a verification step. */
export interface VerifyOutcome {
  ok: boolean
  error?: string
}

/** Wiring for one rewrite. */
export interface AtomicRewriteOptions {
  /** The file to rewrite; it is replaced only if every earlier step succeeds. */
  path: string
  /**
   * Produces the replacement bytes from the working copy.
   *
   * Receives the temporary copy's path, because a real tag writer reads the
   * container it is about to modify. A pure transformer ignores the argument
   * and returns bytes, which is how the interesting half is tested.
   */
  mutate(candidatePath: string): Uint8Array | Promise<Uint8Array>
  /**
   * Runs against the working copy before it replaces anything. A rejection
   * discards the rewrite and leaves the original untouched.
   */
  verify?(candidatePath: string, bytes: Uint8Array): Promise<VerifyOutcome>
  /** Keep a one-shot `<path>.bak` copy of the original. Defaults to `false`. */
  keepBackup?: boolean
  /** Token generator for the temporary name. Defaults to a random UUID. */
  tempToken?: () => string
}

/** Outcome of a rewrite. */
export interface AtomicRewriteResult {
  ok: boolean
  error?: string
  /** Path of the kept backup, when one was written. */
  backupPath?: string
  /** Size of the file after the rename. */
  size?: number
  /** Path of the working copy, for diagnostics. */
  tempPath?: string
}

/** Byte bounds a rewrite of `originalSize` may stay within. */
export interface SizeDeltaBounds {
  /** Largest acceptable shrink, in bytes. */
  maxLossBytes: number
  /** Largest acceptable growth, in bytes. */
  maxGainBytes: number
}

/**
 * Tolerance for a rewrite's size delta.
 *
 * Ported from `metadata.ts:515-516`: a quarter of the file, with a 64 KiB floor
 * for small files, and an extra megabyte of headroom for growth because an
 * embedded cover image legitimately adds hundreds of kilobytes.
 */
export function sizeDeltaBounds(originalSize: number): SizeDeltaBounds {
  const quarter = Math.floor(originalSize * 0.25)
  const floor = 64 * 1024
  return {
    maxLossBytes: Math.max(floor, quarter),
    maxGainBytes: Math.max(floor, quarter) + 1024 * 1024,
  }
}

/**
 * Whether a rewrite's size change is small enough to be plausible.
 *
 * A tag edit changes bytes at the front of a file; a rewrite that shrank it by
 * half has lost audio, and one that ballooned it has probably concatenated
 * something. This is a smoke alarm, not a checksum — the caller's `verify`
 * hook is where format-aware checks belong.
 */
export function verdictSizeDelta(originalSize: number, newSize: number): VerifyOutcome {
  const bounds = sizeDeltaBounds(originalSize)
  const delta = newSize - originalSize
  if (delta < -bounds.maxLossBytes || delta > bounds.maxGainBytes) {
    return {
      ok: false,
      error:
        `size delta ${delta} out of range (loss ${bounds.maxLossBytes}, gain ${bounds.maxGainBytes})`,
    }
  }
  return { ok: true }
}

/**
 * Builds the working copy's path.
 *
 * The copy is a sibling of its target, never a system temp directory: `rename`
 * is only atomic within one filesystem, and `/tmp` is frequently a different
 * mount — a cross-device rename fails, and a copy-then-delete fallback leaves a
 * window where the file exists twice or not at all.
 *
 * @throws {TypeError} when `token` is empty or would move the name out of the
 * target's directory. The token can come from configuration, and a token of
 * `"../../etc/passwd"` must not become a writable path.
 */
export function tempSiblingPath(targetPath: string, token: string, suffix = ".tmp"): string {
  if (token === "" || /[/\\\0]/.test(token) || token === "." || token === "..") {
    throw new TypeError(
      `temporary token must be a plain name fragment, received ${JSON.stringify(token)}`,
    )
  }
  return join(dirname(targetPath), `${basename(targetPath)}.${token}${suffix}`)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function removeQuietly(fs: RewriteFileSystem, path: string): Promise<void> {
  try {
    await fs.remove(path)
  } catch {
    // Best effort: the working copy may already be gone, and a failed cleanup
    // must not replace the real error.
  }
}

/**
 * Rewrites a file so that either the whole change lands or none of it does.
 *
 * Steps: copy the target to a sibling working copy, let `mutate` produce the
 * new bytes, write them, run `verify`, optionally keep a `<path>.bak`, then
 * rename the copy over the target. Any failure before the rename removes the
 * copy and reports `{ ok: false }` with the original still in place.
 *
 * `Deno.rename` is atomic on the same filesystem, so a reader sees either the
 * old file or the new one — never a half-written one, which is the failure the
 * source's `copyFile`-to-temp-then-rename order exists to prevent.
 *
 * Failures are returned, not thrown: a tag write that cannot proceed is data,
 * not an exception, and the source's callers checked `result.ok` too
 * (`metadata.ts:202-206`).
 *
 * @returns the outcome; the target is only replaced when `ok` is `true`.
 */
export async function withAtomicRewrite(
  fs: RewriteFileSystem,
  options: AtomicRewriteOptions,
): Promise<AtomicRewriteResult> {
  const token = (options.tempToken ?? (() => crypto.randomUUID()))()
  let tempPath: string
  try {
    tempPath = tempSiblingPath(options.path, token)
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }

  try {
    await fs.copyFile(options.path, tempPath)
  } catch (error) {
    return { ok: false, error: `copy failed: ${messageOf(error)}` }
  }

  try {
    const bytes = await options.mutate(tempPath)
    await fs.writeFile(tempPath, bytes)

    if (options.verify) {
      const verdict = await options.verify(tempPath, bytes)
      if (!verdict.ok) {
        await removeQuietly(fs, tempPath)
        return { ok: false, error: verdict.error ?? "verification failed", tempPath }
      }
    }

    let backupPath: string | undefined
    if (options.keepBackup) {
      const candidate = `${options.path}.bak`
      if (!(await fs.exists(candidate))) {
        await fs.copyFile(options.path, candidate)
        backupPath = candidate
      }
    }

    await fs.rename(tempPath, options.path)

    let size: number | undefined
    try {
      size = await fs.size(options.path)
    } catch {
      // The rename already succeeded; a stat failure must not be reported as a
      // failed rewrite, because the target has been replaced.
      size = undefined
    }
    return { ok: true, backupPath, size, tempPath }
  } catch (error) {
    await removeQuietly(fs, tempPath)
    return { ok: false, error: messageOf(error), tempPath }
  }
}

/** `RewriteFileSystem` on `Deno`, for production wiring. */
export const denoFileSystem: RewriteFileSystem = {
  copyFile: (from: string, to: string): Promise<void> => Deno.copyFile(from, to),
  writeFile: (path: string, bytes: Uint8Array): Promise<void> => Deno.writeFile(path, bytes),
  rename: (from: string, to: string): Promise<void> => Deno.rename(from, to),
  remove: (path: string): Promise<void> => Deno.remove(path),
  size: async (path: string): Promise<number> => (await Deno.stat(path)).size,
  exists: async (path: string): Promise<boolean> => {
    try {
      await Deno.lstat(path)
      return true
    } catch {
      return false
    }
  },
}
