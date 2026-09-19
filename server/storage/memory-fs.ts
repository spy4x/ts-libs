import type { ObjectFs } from "./ports.ts"

/**
 * In-memory `ObjectFs`. Exported because callers of the local provider need a
 * filesystem substitute to test against, and because this repo's test task has
 * no `--allow-write` grant: every local-provider behaviour is exercised through
 * this fake instead of real disk writes.
 */
export function createMemoryObjectFs(entries: Iterable<[string, Uint8Array]> = []): ObjectFs {
  const store = new Map<string, Uint8Array>()
  for (const [path, data] of entries) store.set(path, Uint8Array.from(data))

  return {
    readObject: (path) => {
      const value = store.get(path)
      if (value === undefined) {
        return Promise.reject(new Deno.errors.NotFound(`No such object: ${path}`))
      }
      return Promise.resolve(Uint8Array.from(value))
    },
    existsObject: (path) => Promise.resolve(store.has(path)),
    writeObject: async (path, data) => {
      if (data instanceof Uint8Array) {
        store.set(path, Uint8Array.from(data))
        return data.byteLength
      }
      const chunks: Uint8Array[] = []
      let total = 0
      const reader = data.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.byteLength
      }
      const joined = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }
      store.set(path, joined)
      return total
    },
  }
}
