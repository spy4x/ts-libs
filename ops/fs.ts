/**
 * Filesystem access, always through a port.
 *
 * The workspace test task grants `--allow-read` and `--allow-env`, so a module
 * that writes a file is untestable here — and a git-hook installer, a log writer
 * and an offline-backup README writer all write files. They take a
 * {@link FileSystem} and the tests get a fake; {@link createDenoFileSystem} is
 * the only implementation that touches the disk.
 *
 * `lstat` is part of the port on purpose. A hook path or an env file that is a
 * symlink has to be detectable *without* following it: writing "through" a
 * symlink puts the content somewhere the caller never named, which is how a
 * repository or a temp directory redirects a privileged write.
 */

/** What a path is, as the callers here need it. */
export interface FileStat {
  /** Regular file. */
  isFile: boolean
  /** Directory. */
  isDirectory: boolean
  /** Block device — an external drive shows up as one under `/dev`. */
  isBlockDevice: boolean
  /** Symlink. Only ever reported by {@link FileSystem.lstat}. */
  isSymlink: boolean
  /** Size in bytes. */
  size: number
  /** Permission bits, e.g. `0o755`, or `null` when the platform reports none. */
  mode: number | null
  /** Modification time, or `null` when the platform does not report one. */
  mtime: Date | null
}

/** One directory entry. */
export interface DirEntry {
  /** Base name, never a path. */
  name: string
  /** Entry is a directory. */
  isDirectory: boolean
  /** Entry is a regular file. */
  isFile: boolean
}

/** Options for {@link FileSystem.mkdir} and {@link FileSystem.remove}. */
export interface PathOptions {
  /** Create missing parents, or remove a tree. */
  recursive?: boolean
}

/**
 * The filesystem port. Every method may reject: a caller that can continue past a
 * missing file catches, and one that cannot lets it propagate.
 */
export interface FileSystem {
  /** Read a file as UTF-8 text. */
  readTextFile(path: string): Promise<string>
  /** Write UTF-8 text, truncating. */
  writeTextFile(path: string, content: string): Promise<void>
  /** Read raw bytes. */
  readFile(path: string): Promise<Uint8Array>
  /** Write raw bytes, truncating. */
  writeFile(path: string, data: Uint8Array): Promise<void>
  /** Follow symlinks. */
  stat(path: string): Promise<FileStat>
  /** Do **not** follow symlinks — the last link is described, not its target. */
  lstat(path: string): Promise<FileStat>
  /** Direct children of a directory. */
  readDir(path: string): Promise<DirEntry[]>
  /** Create a directory. */
  mkdir(path: string, options?: PathOptions): Promise<void>
  /** Remove a file, or a tree when `recursive`. */
  remove(path: string, options?: PathOptions): Promise<void>
  /** Set permission bits, e.g. `0o755`. */
  chmod(path: string, mode: number): Promise<void>
}

/**
 * True for a "no such file" error from any adapter.
 *
 * The real adapter rejects with `Deno.errors.NotFound`; the fake in
 * `ops/testing/filesystem.ts` rejects with an error named `NotFoundError`. Both
 * are tested here, so a caller writes `catch (error) { if (!isNotFound(error)) throw error }`
 * once and it keeps working against either.
 */
export function isNotFound(error: unknown): boolean {
  if (error instanceof Deno.errors.NotFound) return true
  if (error instanceof Deno.errors.NotADirectory) return true
  return typeof error === "object" && error !== null && "name" in error &&
    (error as { name?: unknown }).name === "NotFoundError"
}

function denoStat(stat: Deno.FileInfo): FileStat {
  return {
    isFile: stat.isFile,
    isDirectory: stat.isDirectory,
    isBlockDevice: stat.isBlockDevice ?? false,
    isSymlink: stat.isSymlink ?? false,
    size: stat.size,
    mode: stat.mode,
    mtime: stat.mtime,
  }
}

/**
 * The real adapter, backed by `Deno.*`.
 *
 * Not covered by a test: writing a file needs `--allow-write` and the workspace
 * test task does not grant it. Kept deliberately thin — every decision lives in
 * the callers, which are tested against the fake.
 */
export function createDenoFileSystem(): FileSystem {
  return {
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, content) => Deno.writeTextFile(path, content),
    readFile: (path) => Deno.readFile(path),
    writeFile: (path, data) => Deno.writeFile(path, data),
    stat: async (path) => denoStat(await Deno.stat(path)),
    lstat: async (path) => denoStat(await Deno.lstat(path)),
    readDir: async (path) => {
      const entries: DirEntry[] = []
      for await (const entry of Deno.readDir(path)) {
        entries.push({
          name: entry.name,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
        })
      }
      return entries
    },
    mkdir: (path, options) => Deno.mkdir(path, options),
    remove: (path, options) => Deno.remove(path, options),
    chmod: (path, mode) => Deno.chmod(path, mode),
  }
}
