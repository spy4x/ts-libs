/**
 * A Redis-backed key-value store: `GET`/`SET … EX`/`DEL`, plus a scoped `reset`.
 *
 * Ported from `template/libs/server/kv/+index.ts`. That file `implements ICacheStorage`
 * from the template's own cache module; `@ts-libs/platform/cache` is the extraction of
 * that interface, done by a different unit of this wave (issue #75, pull request #125)
 * and not merged when this module was written. This file does not import it — it is not
 * on `main` yet, and the two extractions must not depend on each other's branch.
 * Instead, {@link RedisKvStore} matches that interface's shape structurally:
 * `get(key: string): Promise<string | null>`, `set(key, value: string, ttlSec: number):
 * Promise<void>`, `del(key): Promise<void>`, `reset(): Promise<void>`. TypeScript's
 * structural typing makes an instance assignable to `ICacheStorage` once both land,
 * without either module importing the other.
 */
import { RedisClient } from "@iuioiua/redis"

/** Keys `{@link RedisKvStore.reset}` asks Redis to look at per `SCAN` round trip. */
const SCAN_COUNT = 200

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
 * the kind of shared-resource risk the prefix scoping exists to avoid.
 */
export class RedisKvStore {
  #closed = false

  private constructor(
    private readonly connection: Deno.Conn,
    private readonly client: RedisClient,
    private readonly keyPrefix: string,
  ) {}

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
    const client = new RedisClient(connection)
    const reply = await client.sendCommand(["PING"])
    if (reply !== "PONG") {
      connection.close()
      throw new Error(`Failed to connect to KV: ${reply}`)
    }
    return new RedisKvStore(connection, client, keyPrefix)
  }

  #prefixed(key: string): string {
    return `${this.keyPrefix}:${key}`
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
    return await this.client.sendCommand<string | null>(["GET", this.#prefixed(key)])
  }

  /**
   * Sets a key with an expiration time.
   *
   * `ttlSec` must be a positive integer. The ported original passed `ttlSec` straight
   * through to `SET … EX`; Redis refuses `EX 0` and a negative `EX` with a protocol
   * error (`ERR invalid expire time in 'set' command`), so a caller passing `0` — an
   * easy value to compute by accident from a stale timestamp — got that opaque error
   * instead of one naming the value it passed.
   */
  public async set(key: string, value: string, ttlSec: number): Promise<void> {
    if (!Number.isInteger(ttlSec) || ttlSec <= 0) {
      throw new RangeError(`ttlSec must be a positive integer, got ${ttlSec}`)
    }
    await this.client.sendCommand(["SET", this.#prefixed(key), value, "EX", ttlSec])
  }

  /** Deletes a key. Deleting a key that does not exist is not an error. */
  public async del(key: string): Promise<void> {
    await this.client.sendCommand(["DEL", this.#prefixed(key)])
  }

  /** Deletes every key under this store's prefix, and nothing outside it. */
  public async reset(): Promise<void> {
    const pattern = this.#prefixed("*")
    let cursor = "0"
    do {
      const [nextCursor, keys] = await this.client.sendCommand<[string, string[]]>([
        "SCAN",
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT,
      ])
      cursor = nextCursor
      if (keys.length > 0) {
        await this.client.sendCommand(["DEL", ...keys])
      }
    } while (cursor !== "0")
  }

  /**
   * Closes the connection.
   *
   * Safe to call more than once: the ported original called `this.connection.close()`
   * unconditionally, and `Deno.Conn.close()` throws `BadResource` on a connection
   * already closed — a real risk for a caller that closes on both a normal shutdown
   * path and a signal handler.
   */
  public close(): void {
    if (this.#closed) return
    this.#closed = true
    this.connection.close()
  }
}
