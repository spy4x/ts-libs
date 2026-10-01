import type { ObjectFs } from "./ports.ts"

/**
 * In-memory `ObjectFs`. Exported because callers of the local provider need a
 * filesystem substitute to test against, and because this repo's test task has
 * no `--allow-write` grant: every local-provider behaviour is exercised through
 * this fake instead of real disk writes.
 *
 * It behaves like real disk on every rule `object-fs-contract.test.ts` checks,
 * and that suite runs against both: a folder is every path some object sits
 * below, so it exists, and reading or writing it rejects with `IsADirectory`; a
 * path below an object rejects with `NotADirectory`; a doubled slash or a `.`
 * segment names the same object as the plain path; and a write empties the
 * object first, so a stream that fails midway leaves only what it delivered.
 */
export function createMemoryObjectFs(entries: Iterable<[string, Uint8Array]> = []): ObjectFs {
  const store = new Map<string, Uint8Array>()
  for (const [path, data] of entries) store.set(normalize(path), Uint8Array.from(data))

  const isFolder = (path: string) => {
    const prefix = path.endsWith("/") ? path : `${path}/`
    for (const key of store.keys()) if (key.startsWith(prefix)) return true
    return false
  }

  /** Rejects the way the kernel does when a folder on the way to `path` is an object. */
  const checkParents = (path: string) => {
    for (let cut = path.indexOf("/", 1); cut > 0; cut = path.indexOf("/", cut + 1)) {
      if (store.has(path.slice(0, cut))) {
        throw new Deno.errors.NotADirectory(`Not a directory: ${path}`)
      }
    }
  }

  return {
    readObject: (raw) => {
      const path = normalize(raw)
      try {
        checkParents(path)
      } catch (error) {
        return Promise.reject(error)
      }
      const value = store.get(path)
      if (value !== undefined) return Promise.resolve(Uint8Array.from(value))
      if (isFolder(path)) {
        return Promise.reject(new Deno.errors.IsADirectory(`Is a folder: ${path}`))
      }
      return Promise.reject(new Deno.errors.NotFound(`No such object: ${path}`))
    },
    existsObject: (raw) => {
      const path = normalize(raw)
      try {
        checkParents(path)
      } catch (error) {
        return Promise.reject(error)
      }
      return Promise.resolve(store.has(path) || isFolder(path))
    },
    writeObject: async (raw, data) => {
      const path = normalize(raw)
      checkParents(path)
      if (isFolder(path)) throw new Deno.errors.IsADirectory(`Is a folder: ${path}`)
      if (data instanceof Uint8Array) {
        store.set(path, Uint8Array.from(data))
        return data.byteLength
      }
      // Emptied first and grown chunk by chunk, as a truncating open followed by writes would.
      let stored = new Uint8Array()
      store.set(path, stored)
      const reader = data.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const grown = new Uint8Array(stored.byteLength + value.byteLength)
        grown.set(stored)
        grown.set(value, stored.byteLength)
        stored = grown
        store.set(path, stored)
      }
      return stored.byteLength
    },
  }
}

/** Drops empty and `.` segments, as the kernel does when it resolves a path. */
function normalize(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".")
  return `${path.startsWith("/") ? "/" : ""}${segments.join("/")}`
}
