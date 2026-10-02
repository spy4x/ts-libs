import { atomicWriteJson, readJsonFile } from "@spy4x/platform/server/atomic-json"
import { denoFileSystem } from "@spy4x/platform/server/deno-fs"
import { FileLock } from "@spy4x/platform/server/file-lock"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import type { SendLog, SendLogEntry } from "./send-log.ts"

/** Options for {@link createFileSendLog}. */
export interface FileSendLogOptions {
  /** The JSON file, such as `data/newsletter-log.json`. Its folder is created on the first write.
   * The send lock is the file `<path>.lock` beside it. */
  path: string
  /** Defaults to the real disk; a test passes a fake. */
  fs?: FileSystemPort
}

/** One entry as the file holds it: antonshubin.com's `newsletter-log.json`, keyed by `slug`. */
interface StoredEntry {
  slug: string
  subject: string
  startedAt: string
  audience?: string[]
  recipients?: string[]
  sent?: number
  failed?: number
  completedAt?: string
}

function fromStored(row: StoredEntry): SendLogEntry {
  const { slug, startedAt, completedAt, ...rest } = row
  return {
    ...rest,
    issue: slug,
    startedAt: new Date(startedAt),
    ...(completedAt !== undefined && { completedAt: new Date(completedAt) }),
  }
}

/**
 * A {@link SendLog} kept in one JSON file, ported from antonshubin.com's `lib/newsletter-log.ts`
 * and reading its `newsletter-log.json` unchanged: an array with one object per issue, keyed by
 * `slug`.
 *
 * - The send lock is an exclusive lock on `<path>.lock`, held by the OS, so a crashed run frees it.
 *   It covers the whole file, so only one issue sends at a time.
 * - Each change reads the file, edits it and writes it back through a temp file and a rename, so a
 *   crash or a full disk never leaves a torn log. Changes made by one log object queue behind each
 *   other. Take {@link SendLog.lock} before sending: two processes that change the file without it
 *   can lose a recipient.
 * - A file that does not parse, or is not an array, is never overwritten: the call throws and the
 *   file stays for a person to repair. A corrupt log must stop a send, not allow a second one.
 */
export function createFileSendLog(options: FileSendLogOptions): SendLog {
  const { path } = options
  const fs = options.fs ?? denoFileSystem
  let sequence = 0
  let queue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<StoredEntry[]> {
    const result = await readJsonFile<unknown>(fs, path)
    if (result.kind === "missing") return []
    if (result.kind === "invalid") {
      throw new Error(`${path} does not parse (${result.reason}); fix it by hand before sending`)
    }
    if (!Array.isArray(result.value)) {
      throw new Error(`${path} is not a JSON array; fix it by hand before sending`)
    }
    return result.value as StoredEntry[]
  }

  /** Runs `change` on the loaded entries, one call at a time, and writes them back when it says
   * so. */
  function update<T>(change: (rows: StoredEntry[]) => { value: T; save: boolean }): Promise<T> {
    const run = queue.then(async () => {
      const rows = await load()
      const { value, save } = change(rows)
      if (save) await atomicWriteJson(fs, path, rows, { pid: Deno.pid, sequence: ++sequence })
      return value
    })
    queue = run.catch(() => {})
    return run
  }

  const stored = (rows: StoredEntry[], issue: string): StoredEntry => {
    const row = rows.find((r) => r.slug === issue)
    if (row === undefined) throw new Error(`send log: issue ${issue} was never started`)
    return row
  }

  return {
    async lock(_issue) {
      const lock = new FileLock({ fs, path: `${path}.lock` })
      if (!(await lock.tryAcquire())) return undefined
      return { release: () => lock.release() }
    },

    async find(issue) {
      const rows = await queue.then(load)
      const row = rows.find((r) => r.slug === issue)
      return row && fromStored(row)
    },

    start({ issue, subject, audience, at }) {
      return update((rows) => {
        const row = rows.find((r) => r.slug === issue)
        if (row === undefined) {
          const created: StoredEntry = {
            slug: issue,
            subject,
            startedAt: at.toISOString(),
            audience: [...audience],
            recipients: [],
          }
          rows.push(created)
          return { value: fromStored(created), save: true }
        }
        if (row.recipients !== undefined && row.audience === undefined) {
          row.audience = [...audience]
          return { value: fromStored(row), save: true }
        }
        return { value: fromStored(row), save: false }
      })
    },

    record(issue, mark) {
      return update((rows) => {
        const row = stored(rows, issue)
        const recipients = row.recipients ??= []
        if (recipients.includes(mark)) return { value: undefined, save: false }
        recipients.push(mark)
        return { value: undefined, save: true }
      })
    },

    finish({ issue, failed, at }) {
      return update((rows) => {
        const row = stored(rows, issue)
        row.sent = row.recipients?.length ?? 0
        row.failed = failed
        if (failed === 0) row.completedAt = at.toISOString()
        return { value: undefined, save: true }
      })
    },
  }
}
