/**
 * Iterative recursive directory walk.
 *
 * Explicit stack, never recursion: a media tree is deeper and wider than a call stack should be
 * trusted with, and the source scanner's `stack.pop()` version is already iterative — this keeps
 * that property while adding the pieces it lacked.
 *
 * Paths are assembled with `@std/path`'s `join`, so the walker is correct on both separators.
 * Symlinked directories are followed with an inode-free cycle guard: a real path that has been
 * seen before is dropped, which is what stops a `a -> ../a` link from looping forever.
 */

import { isAbsolute, join, relative, resolve, SEPARATOR } from "@std/path"

import type { FileSystemPort, WalkEntry } from "./ports.ts"

/** Directories a scan never descends into. */
export const DEFAULT_SKIP_DIRS: readonly string[] = [
  ".git",
  ".syncthing",
  ".stversions",
  "__MACOSX",
  "System Volume Information",
  "$RECYCLE.BIN",
  "node_modules",
]

/** Options for {@link walkFiles}. */
export interface WalkOptions {
  fs: FileSystemPort
  /** Absolute directory to walk. */
  root: string
  /** Directory names to skip. Defaults to {@link DEFAULT_SKIP_DIRS}. */
  skipDirs?: readonly string[]
  /** Skip entries whose name starts with `.`. Defaults to `true`. */
  skipHidden?: boolean
  /** Resolve a path to its cycle-check key. Defaults to the path itself, unresolved. */
  resolveKey?: (path: string) => string
  /** Called for every entry that is reported; return a reason to skip it. */
  shouldSkipFile?: (path: string, entry: WalkEntry) => string | null
}

/** One file found by the walk. */
export interface WalkedFile {
  /** Absolute path. */
  path: string
  /** Path relative to the walk root, using the platform separator. */
  relativePath: string
  /** Base name. */
  name: string
  /** Extension without the dot, lowercased. Empty when there is none. */
  extension: string
  /** Size in bytes when the platform reported it. */
  size: number | undefined
}

/**
 * Yield every file under `root`, depth-first.
 *
 * Directories are yielded as recursion happens, files in listing order. A directory whose listing
 * throws is skipped rather than aborting the walk: on a media tree one unreadable subdirectory
 * should not cost the whole scan. Filtering a specific file out is the job of
 * {@link WalkOptions.shouldSkipFile}, and skipping a directory subtree is
 * {@link WalkOptions.skipDirs}.
 *
 * **Symlinked directories are not detected, and a symlinked directory that resolves inside the walk
 * root is traversed.** `Deno.DirEntry` reports `isDirectory` / `isFile` / `isSymlink` but not the
 * link target, so "follow it only when its target is inside the root" cannot be decided in the
 * walker. A cycle is still impossible, because the guard below drops any path whose
 * {@link WalkOptions.resolveKey} has been seen — and the Deno adapter supplies `Deno.realPathSync`
 * there, which resolves symlinks. Callers that need containment rather than cycle-safety must
 * enforce it at the root they pass in; {@link isInside} is exported for that.
 */
export async function* walkFiles(
  options: WalkOptions,
): AsyncGenerator<WalkedFile, void, void> {
  const { fs, root } = options
  const skipDirs = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS)
  const skipHidden = options.skipHidden ?? true
  const resolveKey = options.resolveKey ?? ((path: string) => path)
  const absoluteRoot = resolve(root)
  const rootKey = resolveKey(absoluteRoot)

  const seen = new Set<string>([rootKey])
  const stack: string[] = [absoluteRoot]

  while (stack.length > 0) {
    const directory = stack.pop() as string
    let entries: WalkEntry[]
    try {
      entries = await fs.readDir(directory)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (skipHidden && entry.name.startsWith(".")) continue
      const path = join(directory, entry.name)

      if (entry.isDirectory) {
        if (skipDirs.has(entry.name)) continue
        const key = resolveKey(path)
        if (seen.has(key)) continue
        seen.add(key)
        stack.push(path)
        continue
      }

      // Anything that is not a regular file (fifo, socket, device) is not a file to hash.
      if (!entry.isFile) continue

      if (options.shouldSkipFile?.(path, entry)) continue

      yield {
        path,
        relativePath: relative(absoluteRoot, path),
        name: entry.name,
        extension: extensionOf(entry.name),
        size: entry.size,
      }
    }
  }
}

/** Lowercased extension without the dot. A leading dot is a hidden file, not an extension. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return ""
  return name.slice(dot + 1).toLowerCase()
}

/**
 * Whether `target` is `root` itself or below it.
 *
 * Compared with `@std/path`'s `relative`, never by string prefix: `"/music2"` shares a prefix with
 * `"/music"` but is a sibling, and on Windows the separator is `\`, so a hand-built `"/"` would make
 * this return `false` for every path. `relative` returns an absolute path (or a `..`-prefixed one)
 * exactly when the target escapes the root, on both separators.
 */
export function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedRoot) return true
  const path = relative(normalizedRoot, normalizedTarget)
  if (path === "") return true
  if (path === ".." || path.startsWith(`..${SEPARATOR}`)) return false
  return !isAbsolute(path)
}
