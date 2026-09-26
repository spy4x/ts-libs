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

/**
 * How long {@link RedisKvStore.#openConnection} waits for `Deno.connect`, and then
 * separately for `PING` to answer, before giving up — in both
 * {@link RedisKvStore.connect} and a reconnect.
 *
 * Not configurable, and not exported. Two different hosts hang two different ways,
 * and both needed a bound: `Deno.connect` to a host that is unreachable rather than
 * actively refusing (a firewalled address, a host that stopped answering ARP) hangs
 * for as long as the OS's own connect timeout, on the order of minutes; a host that
 * accepts the TCP connection and then never answers at the Redis protocol level (a
 * frozen Redis, a proxy whose backend is down) would hang the `PING` that follows
 * forever instead, even though `Deno.connect` itself already succeeded. Either way,
 * every caller sharing the reconnect would hang with it. A fixed bound on each step
 * is enough to turn both into an ordinary, catchable
 * {@link RedisKvStoreConnectionError} instead of a hung request; a per-call override
 * would be another parameter on a frozen public interface for a value nothing so far
 * has needed to tune.
 */
const CONNECT_TIMEOUT_MS = 5000

/**
 * How long {@link RedisKvStore.#sendOnce} waits for one command's reply on an open
 * connection before it gives the connection up.
 *
 * A Redis that freezes after the connection is open (`docker pause`, a stuck host) never
 * answers, and no OS timeout bounds a stalled read, so without this bound every call
 * waited for as long as the freeze lasted (#172). The same fixed value as
 * {@link CONNECT_TIMEOUT_MS}, for the same reason: not configurable, not exported.
 */
const COMMAND_TIMEOUT_MS = CONNECT_TIMEOUT_MS

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
 * Thrown when a call cannot get its command answered over a live connection: a fresh
 * connection could not be opened in place of a dead one (Redis is still unreachable,
 * or still refuses `PING`), the one resend after a reconnect failed too, or Redis did
 * not answer within the store's fixed command bound.
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
 * A command that failed on its connection rather than with an error reply from Redis.
 * Internal: {@link RedisKvStore.#send} turns it into {@link RedisKvStoreConnectionError}
 * once it decides not to resend.
 */
class SendFailure {
  constructor(
    readonly cause: unknown,
    /** False when the connection died of a command timeout, which a resend would repeat. */
    readonly resendable: boolean,
  ) {}
}

/** Whether `error` is the `TimeoutError` a {@link COMMAND_TIMEOUT_MS} deadline recorded. */
function isCommandTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError"
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

/** What {@link RedisKvStore.#openConnection} hands back: one live, PING-checked socket. */
interface OpenedConnection {
  connection: Deno.Conn
  client: RedisClient
  connectionError: ConnectionErrorHolder
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
 *
 * **Reconnects itself once its connection dies.** Nothing watches the connection on
 * its own — a dropped socket is noticed only when a call next tries to use it. The
 * call whose command fails on a dead connection (a failed write or read, not an error
 * reply from Redis) reconnects and sends that command once more on the fresh
 * connection (#169): every command this store sends — `GET`, `SET … EX`, `DEL`,
 * `SCAN`, `CLIENT ID` — is safe to send twice, so a Redis restart no longer
 * costs the first call after it. Each call reconnects at most once: a call that
 * already reconnected before its first send, or whose one reconnect fails, throws
 * {@link RedisKvStoreConnectionError}, so while Redis stays unreachable every call
 * fails after one bounded attempt, never a loop. A command that got no reply within
 * {@link COMMAND_TIMEOUT_MS} (#172) closes the connection and throws without a resend:
 * a frozen Redis would only freeze the resend too. A call that finds the connection
 * dead before it sends anything opens a fresh connection the same way {@link connect}
 * does — `Deno.connect`, then a `PING` that must answer `PONG`, each bounded to
 * {@link CONNECT_TIMEOUT_MS} on its own, so neither a host that never answers TCP nor
 * one that accepts the connection and then never answers `PING` (a frozen Redis, a
 * proxy whose backend is down) can hang the caller. That attempt either replaces the
 * dead connection and the call proceeds, or it fails and the call throws
 * {@link RedisKvStoreConnectionError} with the failed reconnect as its `cause`,
 * leaving the store exactly where the next call tries its own reconnect again.
 * Concurrent calls that all find the connection dead share one in-flight reconnect
 * instead of racing to open several sockets.
 */
export class RedisKvStore {
  #closed = false
  #connection: Deno.Conn
  #client: RedisClient
  #connectionError: ConnectionErrorHolder
  #reconnecting: Promise<void> | null = null

  private constructor(
    private readonly hostname: string,
    private readonly port: number,
    private readonly keyPrefix: string,
    opened: OpenedConnection,
  ) {
    this.#connection = opened.connection
    this.#client = opened.client
    this.#connectionError = opened.connectionError
  }

  /**
   * Opens one Redis connection and confirms it with `PING`.
   *
   * Shared by {@link connect} and {@link #doReconnect}, which need the identical
   * steps: connect (bounded by {@link CONNECT_TIMEOUT_MS}, so a host that never
   * answers fails like one that refuses rather than hanging every caller), wrap the
   * writable half so a failed write is recorded rather than an unhandled rejection
   * (see {@link trapWriteErrors}), and confirm the connection actually speaks Redis
   * before handing it back — `PING` is bounded by the same
   * {@link CONNECT_TIMEOUT_MS}, because a server that accepts the TCP connection and
   * then never answers (a frozen Redis, a proxy whose backend is down) would
   * otherwise hang here forever even though `Deno.connect` itself already
   * succeeded. On any failure the socket this function opened is closed before it
   * throws — the ported original never closed here, so a `PING` that threw (an
   * error reply such as `NOAUTH`, or a connection that died before it answered) left
   * a socket open with nothing left holding a reference to it.
   */
  static async #openConnection(hostname: string, port: number): Promise<OpenedConnection> {
    const connection = await Deno.connect({
      hostname,
      port,
      signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
    })
    const connectionError: ConnectionErrorHolder = { current: undefined }
    const client = new RedisClient({
      readable: connection.readable,
      writable: trapWriteErrors(connection.writable, connectionError),
    })
    let reply: Reply
    let timedOut = false
    const deadline = setTimeout(() => {
      timedOut = true
      connection.close()
    }, CONNECT_TIMEOUT_MS)
    try {
      reply = await client.sendCommand(["PING"])
    } catch (error) {
      if (timedOut) {
        throw new DOMException("PING got no reply in time", "TimeoutError")
      }
      connection.close()
      throw error
    } finally {
      clearTimeout(deadline)
    }
    if (reply !== "PONG") {
      connection.close()
      throw new Error(`Failed to connect to KV: ${reply}`)
    }
    return { connection, client, connectionError }
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
    const opened = await RedisKvStore.#openConnection(hostname, port)
    return new RedisKvStore(hostname, port, keyPrefix, opened)
  }

  #prefixed(key: string): string {
    return `${this.keyPrefix}:${key}`
  }

  /**
   * Opens a replacement connection and swaps it in, once per dead connection.
   *
   * Concurrent callers that all find `#connectionError.current` set share this single
   * attempt: the first caller starts it and stores the promise on `#reconnecting`,
   * every other caller awaits that same promise instead of opening its own socket, and
   * the field is cleared once it settles so the *next* dead connection gets its own
   * fresh attempt. `close()` can run while this is in flight; the check right after
   * the new connection opens (with no `await` between it and the field swap below, so
   * nothing else can run in between) is what makes that safe — a store closed mid
   * reconnect gets its brand new socket closed immediately instead of leaked, and
   * throws {@link RedisKvStoreClosedError} rather than pretending the reconnect
   * succeeded.
   */
  #reconnect(): Promise<void> {
    if (!this.#reconnecting) {
      this.#reconnecting = this.#doReconnect().finally(() => {
        this.#reconnecting = null
      })
    }
    return this.#reconnecting
  }

  async #doReconnect(): Promise<void> {
    const opened = await RedisKvStore.#openConnection(this.hostname, this.port)
    if (this.#closed) {
      opened.connection.close()
      throw new RedisKvStoreClosedError()
    }
    try {
      this.#connection.close()
    } catch {
      // The old connection is already gone — that failure is exactly why a
      // reconnect was needed.
    }
    this.#connection = opened.connection
    this.#client = opened.client
    this.#connectionError = opened.connectionError
  }

  /**
   * Opens a fresh connection when the current one is recorded dead; returns whether it
   * did.
   *
   * A recorded connection error (an earlier write failure trapped by
   * {@link trapWriteErrors}, or an earlier failed or timed-out read recorded by
   * {@link #sendOnce}) sends this call through {@link #reconnect}. On failure it throws
   * {@link RedisKvStoreConnectionError} with the reconnect's own error as `cause`, and
   * `#connectionError.current` is still set afterwards, so the next call tries its own
   * reconnect too. `#doReconnect` throws {@link RedisKvStoreClosedError} instead,
   * unwrapped, when `close()` ran during the attempt — that is reported as what it is,
   * not as a connection failure.
   */
  async #reconnectIfDead(): Promise<boolean> {
    if (this.#connectionError.current === undefined) {
      return false
    }
    try {
      await this.#reconnect()
    } catch (error) {
      if (error instanceof RedisKvStoreClosedError) {
        throw error
      }
      throw new RedisKvStoreConnectionError(error)
    }
    return true
  }

  /**
   * Sends one command on the current connection, bounded by {@link COMMAND_TIMEOUT_MS}.
   *
   * `connection`, `client` and `connectionError` are captured into locals before the
   * send, and it is `connectionError` — not `this.#connectionError` — that a failure is
   * recorded on. Reading `this.#connectionError` again inside the `catch` would name
   * whichever holder is current *then*: if a concurrent call's reconnect had already
   * swapped in a new connection by the time this command's own send fails late, that
   * would wrongly mark the brand new connection dead over a failure that happened on
   * the old one.
   *
   * When the reply does not arrive in time, the timer records a `TimeoutError` on the
   * holder and closes the connection, so the pending read — and every command queued
   * behind it on the same connection — fails instead of waiting for a Redis that may
   * never answer. The next call finds the recorded error and reconnects.
   *
   * A `RedisError` — an ordinary error reply from Redis itself, such as `WRONGTYPE` or
   * an out-of-memory refusal — is rethrown unchanged and not recorded: the connection
   * answered fine, only the command was refused. Any other failure is recorded and
   * thrown as a {@link SendFailure}, which says whether the command may be resent.
   */
  async #sendOnce<T extends Reply>(command: Command): Promise<T> {
    const connection = this.#connection
    const client = this.#client
    const connectionError = this.#connectionError
    let deadline: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        const error = new DOMException(
          `Redis did not answer ${command[0]} within ${COMMAND_TIMEOUT_MS} ms`,
          "TimeoutError",
        )
        connectionError.current ??= error
        try {
          connection.close()
        } catch {
          // Already closed from the far end; the recorded error is what matters.
        }
        reject(error)
      }, COMMAND_TIMEOUT_MS)
    })
    try {
      return await Promise.race([client.sendCommand<T>(command), timeout])
    } catch (error) {
      if (error instanceof RedisError) {
        throw error
      }
      connectionError.current ??= error
      throw new SendFailure(error, !isCommandTimeout(connectionError.current))
    } finally {
      clearTimeout(deadline)
    }
  }

  /**
   * Sends one command, reconnecting and resending it at most once when the connection
   * turns out to be dead.
   *
   * `#closed` is checked first, so a call after `close()` never touches the client at
   * all. A connection already recorded dead is replaced before the first send. When the
   * first send then fails on the connection itself — not an error reply, and not a
   * {@link COMMAND_TIMEOUT_MS} timeout — and this call has not reconnected yet, it
   * reconnects (or joins a reconnect already in flight, or finds a concurrent call
   * already swapped a fresh connection in) and sends the command once more (#169).
   * Every command this store sends gives the same result when Redis receives it twice,
   * so a first send that did reach Redis before the socket died is harmless to repeat.
   *
   * No loop: a call reconnects at most once. A call that reconnected before its first
   * send, a call whose one reconnect fails, and a resend that fails again all throw
   * {@link RedisKvStoreConnectionError}. A timeout is not resent, because a frozen
   * Redis would only hold the caller for another full bound; and a call on a store that
   * `close()` closed mid-send is not resent either.
   */
  async #send<T extends Reply = Reply>(command: Command): Promise<T> {
    if (this.#closed) {
      throw new RedisKvStoreClosedError()
    }
    const reconnected = await this.#reconnectIfDead()
    try {
      return await this.#sendOnce<T>(command)
    } catch (error) {
      if (!(error instanceof SendFailure)) {
        throw error
      }
      if (reconnected || !error.resendable || this.#closed) {
        throw new RedisKvStoreConnectionError(error.cause)
      }
    }
    await this.#reconnectIfDead()
    try {
      return await this.#sendOnce<T>(command)
    } catch (error) {
      if (error instanceof SendFailure) {
        throw new RedisKvStoreConnectionError(error.cause)
      }
      throw error
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
   * to kill one exact connection (`CLIENT KILL ID <id>`) to prove this store recovers
   * rather than crashes or stays dead once its connection dies, and must never target
   * a filter broad enough to also match another worktree's connection to the same
   * shared Redis container.
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
   * `#closed`. Calling this while a reconnect is in flight (see {@link #reconnect})
   * still leaves no socket open: `#doReconnect` checks `#closed` right after its new
   * connection opens and closes that socket itself when it finds the store already
   * closed.
   */
  public close(): void {
    if (this.#closed) return
    this.#closed = true
    try {
      this.#connection.close()
    } catch {
      // Already closed from the far end — a killed or reset connection — so there is
      // nothing left for this call to release.
    }
  }
}
