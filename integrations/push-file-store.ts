/**
 * A push subscription store for an app with no database: every subscription lives in one JSON
 * file, next to any small named state the app wants to keep with it.
 *
 * It is the {@link PushSubscriptionStore} that `createWebPushSender` reads, plus `save` to add a
 * device. What it promises:
 *
 *  - A write never leaves a half-written file: the new document goes to a temporary file that is
 *    then renamed over the old one. Writes of one store run one after another, so two requests at
 *    the same moment lose nothing. One store per file and one process per file: nothing here
 *    locks the file against a second process.
 *  - The file is created readable and writable by its owner only (`0o600`). It holds endpoints
 *    and keys, which let their holder's server push to a device.
 *  - A missing file means "no subscriptions". A file that is not JSON, or not this module's
 *    document, is reported with a {@link PushFileStoreError} on every call and is never
 *    overwritten: repair or remove it by hand.
 *  - A user keeps at most `maxPerUser` subscriptions (20 by default). Saving one more drops the
 *    one saved longest ago, so a signed-in script cannot grow the file without bound.
 *  - Saving an endpoint the user already has replaces that entry, and counts as the newest.
 *  - `save` checks the subscription against `pushSubscriptionSchema` and takes an `https:`
 *    endpoint only: the browser chose it, not the app. The sender checks again that the address
 *    is public before it connects.
 *  - No error message carries an endpoint, a key or any content of the file.
 *
 * The store has no `Deno.*`: file access goes through a `FileSystemPort`, such as
 * `denoFileSystem` from `@spy4x/platform/server/deno-fs`.
 *
 * @example
 * ```ts
 * import { denoFileSystem } from "@spy4x/platform/server/deno-fs"
 *
 * const store = createFilePushSubscriptionStore({ fs: denoFileSystem, path: "/data/push.json" })
 * await store.save(userId, subscription) // the body of the subscribe request
 * const sender = await createWebPushSender({ vapidKeys, subject: "mailto:me@example.com", store })
 * ```
 * @module
 */
import { type } from "arktype"
import type { PushSubscriptionJson } from "@spy4x/platform/model"
import { pushSubscriptionSchema } from "@spy4x/platform/model"
import { atomicWriteJson, readJsonFile } from "@spy4x/platform/server/atomic-json"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import { AsyncMutex } from "@spy4x/platform/universal/concurrency"
import type { PushSubscriptionStore } from "./push.ts"

/** How many subscriptions one user keeps unless `maxPerUser` says otherwise. */
export const DEFAULT_MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20

/** The permission bits the file is created with: its owner reads and writes, nobody else. */
const OWNER_ONLY = 0o600
const MAX_NAME_CHARS = 256

/**
 * Why a call on the store failed: the file cannot be read as this module's document (`corrupt`),
 * or an argument was refused (`invalid-subscription`, `invalid-user`, `invalid-name`).
 */
export type PushFileStoreErrorCode =
  | "corrupt"
  | "invalid-subscription"
  | "invalid-user"
  | "invalid-name"

/** A failure of {@link FilePushSubscriptionStore}, safe to log: it carries no endpoint or key. */
export class PushFileStoreError extends Error {
  /** What went wrong. */
  readonly code: PushFileStoreErrorCode

  constructor(code: PushFileStoreErrorCode, message: string) {
    super(message)
    this.name = "PushFileStoreError"
    this.code = code
  }
}

/** Options of {@link createFilePushSubscriptionStore}. */
export interface FilePushSubscriptionStoreOptions {
  /** File access, such as `denoFileSystem`. */
  fs: FileSystemPort
  /** Where the JSON file lives. Its folder is created when missing. */
  path: string
  /** Most subscriptions one user keeps; the oldest goes first. Default 20. */
  maxPerUser?: number
}

/** One named value kept in the store's file; see {@link FilePushSubscriptionStore.state}. */
export interface FileStateSlot {
  /** The stored value as it was saved, or `null` when nothing was saved. Validate what you read. */
  load(): Promise<unknown>
  /** Replaces the stored value. It must survive `JSON.stringify`. */
  save(value: unknown): Promise<void>
}

/** A {@link PushSubscriptionStore} kept in one JSON file. */
export interface FilePushSubscriptionStore extends PushSubscriptionStore {
  /**
   * Adds this device's subscription to `userId`, or replaces the entry with the same endpoint.
   *
   * @throws {PushFileStoreError} `invalid-subscription` when it is not a subscription with an
   * `https:` endpoint, `invalid-user` for an empty or oversized id, `corrupt` for a bad file.
   */
  save(userId: string | number, subscription: PushSubscriptionJson): Promise<void>
  /**
   * A named value in the same file, for a little state that belongs with the subscriptions, such
   * as what a reminder runner already sent. Writes share the store's queue, so they never race a
   * `save`.
   *
   * @throws {PushFileStoreError} `invalid-name` for an empty or oversized name.
   */
  state(name: string): FileStateSlot
}

const documentSchema = type({
  "+": "reject",
  version: "1",
  // Each user's subscriptions, in the order they were saved: the first is the oldest.
  users: type.Record("string", pushSubscriptionSchema.array()),
  state: "Record<string, unknown>",
})

/** The file's content, with maps in place of objects so no key can reach a prototype. */
interface StoreDocument {
  users: Map<string, PushSubscriptionJson[]>
  state: Map<string, unknown>
}

function userKey(userId: string | number): string {
  const key = String(userId)
  if (
    (typeof userId !== "string" && !Number.isSafeInteger(userId)) || key === "" ||
    key.length > MAX_NAME_CHARS
  ) {
    throw new PushFileStoreError("invalid-user", "the user id is empty, too long or not an id")
  }
  return key
}

function checkedSubscription(value: unknown): PushSubscriptionJson {
  const parsed = pushSubscriptionSchema(value)
  // The validator's own message would quote the value, so it is not passed on.
  if (parsed instanceof type.errors) {
    throw new PushFileStoreError("invalid-subscription", "not a push subscription")
  }
  let protocol = ""
  try {
    protocol = new URL(parsed.endpoint).protocol
  } catch {
    // Not a URL: refused below.
  }
  if (protocol !== "https:") {
    throw new PushFileStoreError(
      "invalid-subscription",
      "a push subscription needs an https endpoint",
    )
  }
  return parsed
}

/**
 * Builds the store. Nothing is read or written until the first call.
 *
 * @throws {RangeError} when `maxPerUser` is not a whole number of at least 1.
 */
export function createFilePushSubscriptionStore(
  options: FilePushSubscriptionStoreOptions,
): FilePushSubscriptionStore {
  const { fs, path } = options
  const maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PUSH_SUBSCRIPTIONS_PER_USER
  if (!Number.isSafeInteger(maxPerUser) || maxPerUser < 1) {
    throw new RangeError("maxPerUser must be a whole number of at least 1")
  }
  const writes = new AsyncMutex()
  // Sets this store's temporary files apart from another process's; no runtime-specific pid.
  const instance = crypto.getRandomValues(new Uint32Array(1))[0]
  let sequence = 0

  const corrupt = (what: string) =>
    new PushFileStoreError("corrupt", `the push subscription file ${what}; it was left as it is`)

  async function read(): Promise<StoreDocument> {
    const file = await readJsonFile<unknown>(fs, path)
    if (file.kind === "missing") return { users: new Map(), state: new Map() }
    if (file.kind === "invalid") throw corrupt("is not JSON")
    const document = documentSchema(file.value)
    if (document instanceof type.errors) throw corrupt("is not a subscription document")
    return {
      users: new Map(Object.entries(document.users)),
      state: new Map(Object.entries(document.state)),
    }
  }

  async function write(document: StoreDocument): Promise<void> {
    await atomicWriteJson(
      fs,
      path,
      {
        version: 1,
        users: Object.fromEntries(document.users),
        state: Object.fromEntries(document.state),
      },
      { pid: instance, sequence: ++sequence },
      2,
      { mode: OWNER_ONLY },
    )
  }

  /** Reads the document, lets `change` edit it, and writes it back when `change` says it did. */
  function update(change: (document: StoreDocument) => boolean): Promise<void> {
    return writes.runExclusive(async () => {
      const document = await read()
      if (change(document)) await write(document)
    })
  }

  return {
    async listByUser(userId) {
      return (await read()).users.get(userKey(userId)) ?? []
    },

    deleteByEndpoint(userId, endpoint) {
      const key = userKey(userId)
      return update((document) => {
        const stored = document.users.get(key) ?? []
        const kept = stored.filter((entry) => entry.endpoint !== endpoint)
        if (kept.length === stored.length) return false
        if (kept.length === 0) document.users.delete(key)
        else document.users.set(key, kept)
        return true
      })
    },

    async save(userId, subscription) {
      const key = userKey(userId)
      const checked = checkedSubscription(subscription)
      await update((document) => {
        const kept = (document.users.get(key) ?? []).filter((entry) =>
          entry.endpoint !== checked.endpoint
        )
        kept.push(checked)
        document.users.set(key, kept.slice(-maxPerUser))
        return true
      })
    },

    state(name) {
      if (typeof name !== "string" || name === "" || name.length > MAX_NAME_CHARS) {
        throw new PushFileStoreError("invalid-name", "the state name is empty or too long")
      }
      return {
        async load() {
          const document = await read()
          return document.state.has(name) ? document.state.get(name) : null
        },
        save(value) {
          return update((document) => {
            document.state.set(name, value)
            return true
          })
        },
      }
    },
  }
}
