/**
 * In-memory {@link FileSystem} for tests.
 *
 * Test support, not API: it is not listed in `ops/deno.json` and nothing in the
 * package imports it outside a `*.test.ts`. It exists so a test can assert what a
 * module *wrote* (content, mode bits, order) without `--allow-write`, which the
 * workspace test task does not grant.
 *
 * Deliberately boring: a flat map of path to node, `readDir` derived by prefix,
 * and "not found" reported as an error named `NotFoundError` so
 * `isNotFound()` recognises it exactly as it recognises `Deno.errors.NotFound`.
 */

import type { DirEntry, FileStat, FileSystem, PathOptions } from "../fs.ts"

/** What a seeded path is. */
export type FakeNodeKind = "file" | "directory" | "symlink"

/** A seeded or written node. */
export interface FakeNode {
  /** Kind of node. */
  kind: FakeNodeKind
  /** File content. Empty for a directory, unused for a symlink. */
  content: Uint8Array
  /** Permission bits as last set. Files default to `0o644`, directories to `0o755`. */
  mode: number
  /** Reported modification time. */
  mtime: Date | null
  /** Symlink target, for `kind: "symlink"`. */
  target?: string
}

/** Options accepted by the `seed*` helpers. */
export interface FakeSeedOptions {
  /** Permission bits. */
  mode?: number
  /** Modification time. */
  mtime?: Date
}

function notFound(path: string): Error {
  const error = new Error(`no such file or directory: ${path}`)
  error.name = "NotFoundError"
  return error
}

function normalize(path: string): string {
  const trimmed = path.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/")
  if (index <= 0) return "/"
  return path.slice(0, index)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * A filesystem in a `Map`.
 *
 * Reads are recorded as well as writes: `readPaths` lets a test assert that an
 * idempotent installer *read before it wrote*, which is the behaviour that keeps
 * a hook from being rewritten on every run.
 */
export class FakeFileSystem implements FileSystem {
  /** Every node, keyed by normalised absolute path. */
  readonly nodes = new Map<string, FakeNode>()
  /** Paths passed to `writeTextFile`/`writeFile`, in call order. */
  readonly writes: string[] = []
  /** Paths passed to `readTextFile`/`readFile`/`stat`/`lstat`/`readDir`, in call order. */
  readonly reads: string[] = []
  /** `[path, mode]` pairs passed to `chmod`, in call order. */
  readonly chmods: Array<[string, number]> = []
  /** Paths passed to `mkdir`, in call order. */
  readonly mkdirs: string[] = []

  /** Add a file. */
  seed(path: string, content = "", options: FakeSeedOptions = {}): this {
    this.nodes.set(normalize(path), {
      kind: "file",
      content: encoder.encode(content),
      mode: options.mode ?? 0o644,
      mtime: options.mtime ?? null,
    })
    return this
  }

  /** Add a directory. Parents are not created — seed them explicitly. */
  seedDirectory(path: string, options: FakeSeedOptions = {}): this {
    this.nodes.set(normalize(path), {
      kind: "directory",
      content: new Uint8Array(),
      mode: options.mode ?? 0o755,
      mtime: options.mtime ?? null,
    })
    return this
  }

  /** Add a symlink. */
  seedSymlink(
    path: string,
    target: string,
    options: FakeSeedOptions = {},
  ): this {
    this.nodes.set(normalize(path), {
      kind: "symlink",
      content: new Uint8Array(),
      mode: options.mode ?? 0o777,
      mtime: options.mtime ?? null,
      target,
    })
    return this
  }

  /** True when the path exists, symlink included. */
  has(path: string): boolean {
    return this.nodes.has(normalize(path))
  }

  /** Content of a file as text. Throws when the path is missing. */
  text(path: string): string {
    const node = this.require(normalize(path))
    return decoder.decode(node.content)
  }

  /** Mode bits of a node. Throws when the path is missing. */
  modeOf(path: string): number {
    return this.require(normalize(path)).mode
  }

  /** Base names of a directory's direct children. */
  names(path: string): string[] {
    const prefix = normalize(path) === "/" ? "/" : `${normalize(path)}/`
    const names: string[] = []
    for (const key of this.nodes.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest === "" || rest.includes("/")) continue
      names.push(rest)
    }
    return names.sort()
  }

  private require(path: string): FakeNode {
    const node = this.nodes.get(path)
    if (node === undefined) throw notFound(path)
    return node
  }

  private resolve(path: string): FakeNode {
    let node = this.require(path)
    let current = path
    for (let hop = 0; node.kind === "symlink" && hop < 8; hop++) {
      const target = node.target ?? ""
      current = target.startsWith("/")
        ? normalize(target)
        : normalize(`${parentOf(current)}/${target}`)
      node = this.require(current)
    }
    return node
  }

  private toStat(node: FakeNode): FileStat {
    return {
      isFile: node.kind === "file",
      isDirectory: node.kind === "directory",
      isBlockDevice: false,
      isSymlink: node.kind === "symlink",
      size: node.kind === "file" ? node.content.byteLength : 0,
      mode: node.mode,
      mtime: node.mtime,
    }
  }

  readTextFile(path: string): Promise<string> {
    this.reads.push(normalize(path))
    return Promise.resolve(
      decoder.decode(this.resolve(normalize(path)).content),
    )
  }

  writeTextFile(path: string, content: string): Promise<void> {
    return this.writeFile(path, encoder.encode(content))
  }

  readFile(path: string): Promise<Uint8Array> {
    this.reads.push(normalize(path))
    return Promise.resolve(this.resolve(normalize(path)).content)
  }

  writeFile(path: string, data: Uint8Array): Promise<void> {
    const key = normalize(path)
    this.writes.push(key)
    const existing = this.nodes.get(key)
    this.nodes.set(key, {
      kind: "file",
      content: data.slice(),
      mode: existing?.mode ?? 0o644,
      mtime: existing?.mtime ?? null,
    })
    return Promise.resolve()
  }

  stat(path: string): Promise<FileStat> {
    this.reads.push(normalize(path))
    return Promise.resolve(this.toStat(this.resolve(normalize(path))))
  }

  lstat(path: string): Promise<FileStat> {
    this.reads.push(normalize(path))
    return Promise.resolve(this.toStat(this.require(normalize(path))))
  }

  readDir(path: string): Promise<DirEntry[]> {
    const key = normalize(path)
    this.reads.push(key)
    const node = this.resolve(key)
    if (node.kind !== "directory") throw notFound(key)
    const entries: DirEntry[] = this.names(key).map((name) => {
      const child = this.nodes.get(
        name.startsWith("/") ? name : `${key}/${name}`,
      )
      return {
        name,
        isDirectory: child?.kind === "directory",
        isFile: child?.kind === "file",
      }
    })
    return Promise.resolve(entries)
  }

  mkdir(path: string, options: PathOptions = {}): Promise<void> {
    const key = normalize(path)
    this.mkdirs.push(key)
    if (options.recursive) {
      let current = key
      const chain: string[] = []
      while (current !== "/" && !this.nodes.has(current)) {
        chain.push(current)
        current = parentOf(current)
      }
      for (const directory of chain.reverse()) {
        this.nodes.set(directory, {
          kind: "directory",
          content: new Uint8Array(),
          mode: 0o755,
          mtime: null,
        })
      }
      return Promise.resolve()
    }
    if (this.nodes.has(key)) throw new Error(`file exists: ${key}`)
    if (!this.nodes.has(parentOf(key))) throw notFound(parentOf(key))
    this.nodes.set(key, {
      kind: "directory",
      content: new Uint8Array(),
      mode: 0o755,
      mtime: null,
    })
    return Promise.resolve()
  }

  remove(path: string, options: PathOptions = {}): Promise<void> {
    const key = normalize(path)
    const node = this.require(key)
    if (node.kind === "directory") {
      const children = this.names(key)
      if (children.length > 0 && !options.recursive) {
        throw new Error(`directory not empty: ${key}`)
      }
      for (const existing of [...this.nodes.keys()]) {
        if (existing === key || existing.startsWith(`${key}/`)) {
          this.nodes.delete(existing)
        }
      }
      return Promise.resolve()
    }
    this.nodes.delete(key)
    return Promise.resolve()
  }

  chmod(path: string, mode: number): Promise<void> {
    const key = normalize(path)
    this.chmods.push([key, mode])
    this.require(key).mode = mode
    return Promise.resolve()
  }
}
