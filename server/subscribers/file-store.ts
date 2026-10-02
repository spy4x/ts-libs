import { type } from "arktype"
import { atomicWriteJson, readJsonFile } from "@spy4x/platform/server/atomic-json"
import { denoFileSystem } from "@spy4x/platform/server/deno-fs"
import { FileLock, LockUnavailableError } from "@spy4x/platform/server/file-lock"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import { sleep } from "@spy4x/platform/universal/async"
import type { SubscriptionCrypto } from "./crypto.ts"
import type {
  AddSubscriberInput,
  AddSubscriberResult,
  RemoveSubscriberInput,
  Subscriber,
  SubscriberStore,
} from "./store.ts"

/** A list or unsubscribe record on disk that this store cannot use. */
export class SubscriberFileError extends Error {
  override readonly name = "SubscriberFileError"
}

/** Options for {@link createFileSubscriberStore}. */
export interface FileSubscriberStoreOptions {
  /** The list, for example `data/subscribers.json`. `<path>.lock`, `<path>.invalid`,
   * `<path>.unsubscribed` and `<path>.unsubscribed.invalid` sit next to it. */
  path: string
  /** Defaults to the real filesystem. */
  fs?: FileSystemPort
  /** Where a damaged file is reported. Defaults to `console`. */
  log?: { error(...args: unknown[]): void }
  /** How many times to try the lock another process holds before giving up with a
   * `LockUnavailableError`. Defaults to 100. */
  lockAttempts?: number
  /** Milliseconds between those tries. Defaults to 20, so the default wait is about two seconds. */
  lockRetryMs?: number
}

/** A {@link SubscriberStore} on disk, plus the one-time key backfill. */
export interface FileSubscriberStore extends SubscriberStore {
  /**
   * Gives every row that has no `key` its `crypto.subscriberKey`, under the lock, and returns how
   * many rows it changed. Run it once on a list written before keys existed, such as the
   * antonshubin.com file: only a version 1 unsubscribe link can find a row without a key. Running it
   * again changes nothing and writes nothing.
   */
  backfillKeys(crypto: Pick<SubscriptionCrypto, "subscriberKey">): Promise<number>
}

/** One row as stored: the site's shape, plus an optional `key`. */
const storedRows = type({ email: "string", subscribedAt: "string", "key?": "string" }).array()
const storedMarks = type({ mark: "string", at: "string" }).array()

interface Mark {
  mark: string
  /** Unix milliseconds. */
  at: number
}

/** One queue per file path, shared by every store in this process. */
const queues = new Map<string, Promise<unknown>>()

/** Runs `task` after every earlier task for `key` has settled. */
function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  const settled = run.then(() => {}, () => {})
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}

let writeSequence = 0

function copy(row: Subscriber): Subscriber {
  return { ...row, subscribedAt: new Date(row.subscribedAt) }
}

/**
 * A {@link SubscriberStore} in a JSON file, for a single server or a few processes on one disk.
 *
 * Every change is one read-change-write under two locks: an in-process queue orders this process's
 * calls, and `<path>.lock` keeps another process out, so no concurrent calls lose a write. A write
 * replaces the file atomically (a temp file, then a rename), so a failed write leaves the old list
 * whole. Reads take no lock: they see the list before or after a change, never half of one.
 *
 * A file that does not parse as a list is an error, never an empty list: the first unparseable text
 * is kept in `<path>.invalid` (a later one does not replace it), the file itself stays as it is, and
 * every call fails with a {@link SubscriberFileError} until a person repairs it.
 *
 * Unsubscribes are recorded in `<path>.unsubscribed` as `{ mark, at }`. A change that writes both
 * files writes the record first, so a crash in between never leaves the address removed without
 * its record. An unreadable record is kept in `<path>.unsubscribed.invalid`, logged, and treated as
 * empty so the list stays usable.
 *
 * The files stay compatible with antonshubin.com: its `subscribers.json` and `.unsubscribed` load
 * unchanged, and the store writes the same shape, plus `key` on rows that have one.
 */
export function createFileSubscriberStore(
  options: FileSubscriberStoreOptions,
): FileSubscriberStore {
  const fs = options.fs ?? denoFileSystem
  const log = options.log ?? console
  const path = options.path
  const marksPath = `${path}.unsubscribed`
  const attempts = options.lockAttempts ?? 100
  const retryMs = options.lockRetryMs ?? 20

  /** Keeps the first unparseable copy of `file` in `<file>.invalid`; says what happened. */
  async function setAside(file: string, raw: string): Promise<string> {
    const invalid = `${file}.invalid`
    try {
      if (await fs.exists(invalid)) {
        return `an earlier copy is already kept in ${invalid}, so this text was not kept`
      }
      await fs.writeText(invalid, raw)
      return `its text is kept in ${invalid}`
    } catch (error) {
      log.error("[SUBSCRIBERS] could not keep the unparseable file:", error)
      return `its text could not be kept in ${invalid}`
    }
  }

  async function load(): Promise<Subscriber[]> {
    const read = await readJsonFile<unknown>(fs, path)
    if (read.kind === "missing") return []
    if (read.kind === "invalid") return await refuse(read.reason, read.raw)
    const checked = storedRows(read.value)
    if (checked instanceof type.errors) {
      return await refuse(checked.summary, JSON.stringify(read.value))
    }
    const rows: Subscriber[] = []
    for (const row of checked) {
      const subscribedAt = new Date(row.subscribedAt)
      if (Number.isNaN(subscribedAt.getTime())) {
        return await refuse(
          `${JSON.stringify(row.subscribedAt)} is not a date`,
          JSON.stringify(read.value),
        )
      }
      rows.push(
        row.key === undefined
          ? { email: row.email, subscribedAt }
          : { email: row.email, key: row.key, subscribedAt },
      )
    }
    return rows
  }

  async function refuse(reason: string, raw: string): Promise<never> {
    const aside = await setAside(path, raw)
    const error = new SubscriberFileError(
      `${path} is not a subscriber list (${reason}); ${aside}; nothing is written until it is repaired`,
    )
    log.error("[SUBSCRIBERS]", error.message)
    throw error
  }

  async function loadMarks(): Promise<Mark[]> {
    const read = await readJsonFile<unknown>(fs, marksPath)
    if (read.kind === "missing") return []
    if (read.kind === "ok") {
      const checked = storedMarks(read.value)
      if (!(checked instanceof type.errors)) {
        return checked.map(({ mark, at }) => ({ mark, at: Date.parse(at) }))
          .filter((m) => !Number.isNaN(m.at))
      }
    }
    const raw = read.kind === "invalid" ? read.raw : JSON.stringify(read.value)
    const aside = await setAside(marksPath, raw)
    log.error("[SUBSCRIBERS]", `${marksPath} is not an unsubscribe record; ${aside}`)
    return []
  }

  /** Takes `<path>.lock`, waiting for another process, and runs `task` under it. */
  async function withFileLock<T>(task: () => Promise<T>): Promise<T> {
    const lock = new FileLock({ fs, path: `${path}.lock` })
    for (let attempt = 1; !(await lock.tryAcquire()); attempt++) {
      if (attempt >= attempts) throw new LockUnavailableError(`${path}.lock`)
      await sleep(retryMs)
    }
    try {
      return await task()
    } finally {
      await lock.release()
    }
  }

  function locked<T>(task: () => Promise<T>): Promise<T> {
    return enqueue(path, () => withFileLock(task))
  }

  const nextTemp = () => ({ pid: Deno.pid, sequence: ++writeSequence })

  async function writeRows(rows: Subscriber[]): Promise<void> {
    const stored = rows.map((row) => ({
      email: row.email,
      subscribedAt: row.subscribedAt.toISOString(),
      ...(row.key === undefined ? {} : { key: row.key }),
    }))
    await atomicWriteJson(fs, path, stored, nextTemp())
  }

  return {
    async list() {
      return (await load()).map(copy)
    },

    async findByKey(key) {
      const row = (await load()).find((candidate) => candidate.key === key)
      return row && copy(row)
    },

    async count() {
      return (await load()).length
    },

    add(input: AddSubscriberInput): Promise<AddSubscriberResult> {
      return locked(async () => {
        const rows = await load()
        if (rows.some((row) => row.email === input.email)) return "known"
        const unsubscribedAt = (await loadMarks()).find((m) => m.mark === input.mark)?.at
        if (unsubscribedAt !== undefined && unsubscribedAt >= input.issuedAt) return "replay"
        rows.push({ email: input.email, key: input.key, subscribedAt: new Date(input.at) })
        await writeRows(rows)
        return "added"
      })
    },

    remove(input: RemoveSubscriberInput): Promise<boolean> {
      return locked(async () => {
        const rows = await load()
        const oldest = input.pruneBefore.getTime()
        const marks = (await loadMarks()).filter((m) => m.mark !== input.mark && m.at >= oldest)
        marks.push({ mark: input.mark, at: input.at.getTime() })
        // The record goes first: a crash between the two writes must not leave the address removed
        // without its mark.
        await atomicWriteJson(
          fs,
          marksPath,
          marks.map((m) => ({ mark: m.mark, at: new Date(m.at).toISOString() })),
          nextTemp(),
        )
        const kept = rows.filter((row) => row.email !== input.email)
        if (kept.length === rows.length) return false
        await writeRows(kept)
        return true
      })
    },

    backfillKeys(crypto) {
      return locked(async () => {
        const rows = await load()
        let changed = 0
        for (const row of rows) {
          if (row.key !== undefined) continue
          row.key = await crypto.subscriberKey(row.email)
          changed++
        }
        if (changed > 0) await writeRows(rows)
        return changed
      })
    },
  }
}
