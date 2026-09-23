/**
 * A Redis-backed key-value store: `GET`/`SET … EX`/`DEL`, plus a scoped `reset`.
 *
 * Ported from `template/libs/server/kv/+index.ts`. That file `implements ICacheStorage`
 * from the template's own cache module; `@spy4x/platform/cache` is the extraction of
 * that interface (#125). This file does not import it — the two were extracted in
 * parallel and neither depends on the other's branch. Instead {@link RedisKvStore}
 * matches that interface's shape structurally: `get(key: string): Promise<string |
 * null>`, `set(key, value: string, ttlSec: number): Promise<void>`, `del(key):
 * Promise<void>`, `reset(): Promise<void>`. TypeScript's structural typing makes an
 * instance assignable to `ICacheStorage` without either module importing the other.
 */
import { type Command, RedisClient, RedisError, type Reply } from "@iuioiua/redis"

/** Keys `{@link RedisKvStore.reset}` asks Redis to look at per `SCAN` round trip. */
const SCAN_COUNT = 200

/** Redis's `SCAN MATCH` glob metacharacters: escaped so a prefix is matched literally. */
const GLOB_METACHARACTERS = /[\\*?[\]]/g

/**
 * Escapes `\`, `*`, `?`, `[` and `]` with a backslash, so `value` is matched as a
 * literal string rather than a glob pattern by `SCAN`'s `MATCH`.
 */
function escapeGlob(value: string): string {
  return value.replace(GLOB_METACHARACTERS, "\\$&")
}

/** Thrown by every method once {@link RedisKvStore.close} has been called. */
export class RedisKvStoreClosedError extends Error {
  constructor() {
    super("RedisKvStore is closed")
    this.name = "RedisKvStoreClosedError"
  }
}

/**
 * Thrown once this store's connection has failed — a write rejected, or a read did,
 * most often because the connection was closed by Redis rather than by this store.
 *
 * Never thrown for an ordinary error reply from Redis itself (`WRONGTYPE`, an
 * out-of-memory refusal, `READONLY`, `BUSY`): that is a `RedisError` from
 * `@iuioiua/redis`, the socket is fine, and {@link RedisKvStore.#send} rethrows it
 * unchanged instead of treating the connection as dead.
 */
export class RedisKvStoreConnectionError extends Error {
  constructor(cause: unknown) {
    super("RedisKvStore's connection is no longer usable", { cause })
    this.name = "RedisKvStoreConnectionError"
  }
}

/** Mutable box a trapped writable and its store share, so either side can record a failure. */
interface ConnectionErrorHolder {
  current: unknown
}

/**
 * Wraps a connection's writable half so a failed write is recorded instead of becoming
 * an unhandled rejection.
 *
 * `RedisClient.sendCommand` calls `this.#writer.write(...)` without awaiting it (see
 * `@iuioiua/redis`'s source), so a write that rejects — a closed or reset socket —
 * becomes an unhandled promise rejection, which crashes the whole Deno process even
 * from inside a caller's `try`/`catch`. This wrapper's `write` never rejects: it
 * records the failure on `holder` instead, and `#send` checks `holder.current` before
 * every command, and records a failed read in its own `catch`, so the failure
 * surfaces as an ordinary rejected promise from the next call rather than as a crash.
 */
function trapWriteErrors(
  writable: WritableStream<Uint8Array>,
  holder: ConnectionErrorHolder,
): WritableStream<Uint8Array> {
  const writer = writable.getWriter()
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk)
      } catch (error) {
        holder.current ??= error
      }
    },
    async close() {
      try {
        await writer.close()
      } catch {
        // The connection is already gone; nothing left to close.
      }
    },
    async abort(reason) {
      try {
        await writer.abort(reason)
      } catch {
        // Same as close(): nothing left to abort.
      }
    },
  })
}

/**
 * A key-value store scoped to one Redis connection and one key prefix.
 *
 * **The prefix, and why `reset` needs one.** The ported original's `reset()` sent
 * `FLUSHDB`, which deletes every key in the database — including keys another
 * application, or another test run, put there. That is not a safe operation for a
 * shared library to offer: this store instead takes a mandatory `keyPrefix` at
 * {@link connect} and every key it touches is scoped under it (`<prefix>:<key>`), so
 * `reset()` can delete "this store's keys" with `SCAN`/`DEL` and never reach anything
 * outside that prefix. `SCAN` is used rather than the simpler `KEYS`, because `KEYS`
 * blocks the whole server for the duration of the scan on a large database — exactly
 * the kind of shared-resource risk the prefix scoping exists to avoid. A prefix is a
 * plain string match, not a namespace: a store prefixed `app` also reaches a store
 * prefixed `app:sub`'s keys, since `app`'s own key `sub:k` and `app:sub`'s own key `k`
 * are the same Redis key, `app:sub:k`.
 */
export class RedisKvStore {
  #closed = false
  readonly #connectionError: ConnectionErrorHolder

  private constructor(
    private readonly connection: Deno.Conn,
    private readonly client: RedisClient,
    private readonly keyPrefix: string,
    connectionError: ConnectionErrorHolder,
  ) {
    this.#connectionError = connectionError
  }

  /**
   * Connects to Redis and scopes every key this store touches under `keyPrefix`.
   *
   * `keyPrefix` must be non-empty: a store with an empty prefix would make
   * {@link reset} equivalent to the `FLUSHDB` this module deliberately does not send.
   */
  public static async connect(
    hostname: string,
    port: number,
    keyPrefix: string,
  ): Promise<RedisKvStore> {
    if (keyPrefix.length === 0) {
      throw new TypeError("keyPrefix must be a non-empty string")
    }
    const connection = await Deno.connect({ hostname, port })
    const connectionError: ConnectionErrorHolder = { current: undefined }
    const client = new RedisClient({
      readable: connection.readable,
      writable: trapWriteErrors(connection.writable, connectionError),
    })
    let reply: Reply
    try {
      reply = await client.sendCommand(["PING"])
    } catch (error) {
      // The ported original never closed here: a PING that throws (an error reply
      // such as NOAUTH, or a connection that dies before it answers) left the socket
      // open with nothing left holding a reference to it.
      connection.close()
      throw error
    }
    if (reply !== "PONG") {
      connection.close()
      throw new Error(`Failed to connect to KV: ${reply}`)
    }
    return new RedisKvStore(connection, client, keyPrefix, connectionError)
  }

  #prefixed(key: string): string {
    return `${this.keyPrefix}:${key}`
  }

  /**
   * Sends one command, after checking this store is still usable.
   *
   * `#closed` is checked first, so a call after `close()` never touches the client at
   * all. A recorded connection error (from an earlier write failure trapped by
   * {@link trapWriteErrors}, or an earlier read failure caught below) is checked next,
   * so a store whose connection has already died fails the same way on every later
   * call instead of trying again. A read failure — the server closing the connection,
   * for example — surfaces here directly, because `sendCommand` awaits its own read;
   * it is wrapped the same way a write failure is, so every failure after this
   * connection dies looks the same to a caller: a catchable
   * {@link RedisKvStoreConnectionError}, never an unhandled rejection.
   *
   * A `RedisError` — an ordinary error reply from Redis itself, such as `WRONGTYPE` or
   * an out-of-memory refusal — is neither recorded nor wrapped. The connection answered
   * fine; only the command was refused, and a store that treated every refused command
   * as a dead connection would disable itself for good the first time a caller sent
   * one bad command, or Redis briefly refused writes.
   */
  async #send<T extends Reply = Reply>(command: Command): Promise<T> {
    if (this.#closed) {
      throw new RedisKvStoreClosedError()
    }
    if (this.#connectionError.current !== undefined) {
      throw new RedisKvStoreConnectionError(this.#connectionError.current)
    }
    try {
      return await this.client.sendCommand<T>(command)
    } catch (error) {
      if (error instanceof RedisError) {
        throw error
      }
      this.#connectionError.current ??= error
      throw new RedisKvStoreConnectionError(error)
    }
  }

  /**
   * Gets a value, or `null` when the key does not exist.
   *
   * The ported original was `get<T extends Reply>(key): Promise<null | T>`, letting
   * every caller pick its own return type for a command whose reply is always a bulk
   * string or `null` — an unchecked cast dressed up as a generic. `GET` never returns
   * anything else, so the return type is fixed to what the protocol actually sends.
   */
  public async get(key: string): Promise<string | null> {
    return await this.#send<string | null>(["GET", this.#prefixed(key)])
  }

  /**
   * Sets a key with an expiration time.
   *
   * `ttlSec` must be a positive integer. The ported original passed `ttlSec` straight
   * through to `SET … EX`; Redis refuses `EX 0`, a negative `EX` and a fractional `EX`
   * with a protocol error (`ERR invalid expire time in 'set' command`), and `EX NaN`
   * or `EX Infinity` fail the same way once stringified — `Number.isInteger` rejects
   * all of them up front with a message naming the value, rather than an opaque
   * protocol error or a request Redis never sees a sane reply to.
   */
  public async set(key: string, value: string, ttlSec: number): Promise<void> {
    if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
      throw new RangeError(`ttlSec must be a positive integer, got ${ttlSec}`)
    }
    await this.#send(["SET", this.#prefixed(key), value, "EX", ttlSec])
  }

  /** Deletes a key. Deleting a key that does not exist is not an error. */
  public async del(key: string): Promise<void> {
    await this.#send(["DEL", this.#prefixed(key)])
  }

  /**
   * This store's own Redis connection id, as `CLIENT ID` reports it.
   *
   * Not needed by an ordinary caller — it exists for the integration tier, which has
   * to kill one exact connection (`CLIENT KILL ID <id>`) to prove this store rejects
   * rather than crashes once its connection dies, and must never target a filter
   * broad enough to also match another worktree's connection to the same shared
   * Redis container.
   */
  public async clientId(): Promise<number> {
    return await this.#send<number>(["CLIENT", "ID"])
  }

  /**
   * Deletes every key under this store's prefix, and nothing outside it.
   *
   * The prefix is escaped before it is used as `SCAN`'s `MATCH` pattern: without
   * escaping, a prefix containing `*`, `?`, `[` or `]` is a glob, not a literal
   * string, and could match another store's keys that merely look similar (a prefix
   * `app*` matching a sibling store's `app2:...` keys, for example).
   */
  public async reset(): Promise<void> {
    const pattern = `${escapeGlob(this.keyPrefix)}:*`
    let cursor = "0"
    do {
      const [nextCursor, keys] = await this.#send<[string, string[]]>([
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT,
      ])
      cursor = nextCursor
      if (keys.length > 0) {
        await this.#send(["DEL", ...keys])
      }
    } while (cursor !== "0")
  }

  /**
   * Closes the connection.
   *
   * Safe to call more than once: the ported original called `this.connection.close()`
   * unconditionally, and `Deno.Conn.close()` throws `BadResource` on a connection
   * already closed — a real risk for a caller that closes on both a normal shutdown
   * path and a signal handler. It also throws `BadResource` on a connection the far
   * end already killed, which is why this is wrapped rather than only guarded by
   * `#closed`.
   */
  public close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.connection.close()
    } catch {
      // Already closed from the far end — a killed or reset connection — so there is
      // nothing left for this call to release.
    }
  }
}
