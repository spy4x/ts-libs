/**
 * `RedisKvStore`'s reconnect behaviour, tested against a fake `Deno.connect` instead
 * of a real Redis — the unit tier has no `--allow-net`, so nothing here opens a real
 * socket. `Deno.connect` is reassigned per test (and restored in `finally`) to hand
 * back a minimal RESP-speaking fake connection: enough for `@iuioiua/redis`'s
 * `RedisClient`, which only ever touches `.readable`, `.writable` and, through this
 * module, `.close()`.
 *
 * Everything that needs a real server — the actual `PING`/`GET`/`SET` round trip,
 * `CLIENT KILL` proving a genuinely dead connection recovers — lives in
 * `redis-kv-store.integration.test.ts`. What belongs here is the reconnect
 * *orchestration* that fakes can exercise without a network: one shared attempt for
 * concurrent callers, `close()` racing a reconnect, and a failed reconnect leaving the
 * next call free to try again.
 */
import { assertEquals, assertRejects } from "@std/assert"
import { afterEach, describe, it } from "@std/testing/bdd"
import {
  RedisKvStore,
  RedisKvStoreClosedError,
  RedisKvStoreConnectionError,
} from "./redis-kv-store.ts"

const originalConnect = Deno.connect
const originalAbortTimeout = AbortSignal.timeout
const originalSetTimeout = globalThis.setTimeout

afterEach(() => {
  Deno.connect = originalConnect
  AbortSignal.timeout = originalAbortTimeout
  globalThis.setTimeout = originalSetTimeout
})

/** One line of a RESP reply, as `+OK`, `$-1` (null), `$5\r\nhello`, etc. */
type RespLine = string

function encodeReply(line: RespLine): Uint8Array {
  return new TextEncoder().encode(`${line}\r\n`)
}

/** A fake connection's controls: feed replies in, read what was sent, and see when it closes. */
interface FakeConn {
  conn: Deno.TcpConn
  /** Every command this connection received, most recent last, as its RESP text. */
  readonly writes: string[]
  /** Queues one reply line (see {@link RespLine}) for the next command. */
  reply(line: RespLine): void
  /** Ends the readable side as Redis closing the socket would — the next read fails. */
  breakConnection(): void
  /**
   * Makes this connection's next `write()` reject with `error` instead of
   * succeeding — a write that fails while that same command's read is still
   * pending, the way a half-dead socket does.
   */
  failNextWrite(error: Error): void
  closed: boolean
}

/**
 * A `Deno.TcpConn`-shaped fake: a controllable `readable`/`writable` pair and a
 * `close()` that both flips a flag `RedisKvStore` never inspects here and ends the
 * readable side, the way closing a real socket ends its own read side too — needed
 * so a `close()` called while a read is pending (the `PING` deadline in
 * `#openConnection`, in particular) actually unblocks it instead of leaving it
 * hanging forever. Every other `Deno.TcpConn` member (`rid`, `localAddr`, ...) is
 * unused by `RedisClient` or by this module, so the cast is the honest way to say
 * "only these three matter".
 */
function createFakeConn(): FakeConn {
  let readController: ReadableStreamDefaultController<Uint8Array> | undefined
  let readableSettled = false
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readController = controller
    },
  })
  const writes: string[] = []
  let pendingWriteFailure: Error | undefined
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      writes.push(new TextDecoder().decode(chunk))
      if (pendingWriteFailure) {
        const error = pendingWriteFailure
        pendingWriteFailure = undefined
        return Promise.reject(error)
      }
      return Promise.resolve()
    },
  })
  const state: FakeConn = {
    conn: {
      readable,
      writable,
      close() {
        if (state.closed) return
        state.closed = true
        if (!readableSettled) {
          readableSettled = true
          readController?.error(new Error("fake connection closed locally"))
        }
      },
    } as unknown as Deno.TcpConn,
    writes,
    reply(line) {
      readController?.enqueue(encodeReply(line))
    },
    breakConnection() {
      readableSettled = true
      readController?.error(new Error("fake connection broke"))
    },
    failNextWrite(error) {
      pendingWriteFailure = error
    },
    closed: false,
  }
  return state
}

/** Installs a fake `Deno.connect` that hands out `conns` in order, one call each. */
function stubConnect(conns: FakeConn[]): { calls: number } {
  const state = { calls: 0 }
  Deno.connect = (() => {
    const fake = conns[state.calls]
    state.calls++
    if (!fake) {
      throw new Error(`stubConnect: no fake connection queued for call ${state.calls}`)
    }
    // PONG is queued before the connection is handed back so PING has an answer
    // ready the moment RedisKvStore's own connect logic sends it.
    fake.reply("+PONG")
    return Promise.resolve(fake.conn)
  }) as unknown as typeof Deno.connect
  return state
}

/** Connects a store against a fresh fake connection, consuming the queued PONG. */
async function connectFake(): Promise<
  { store: RedisKvStore; conns: FakeConn[]; calls: { calls: number } }
> {
  const conns = [createFakeConn()]
  const calls = stubConnect(conns)
  const store = await RedisKvStore.connect("fake-host", 6379, "unit_kv")
  return { store, conns, calls }
}

describe("RedisKvStore.connect", () => {
  it("refuses an empty keyPrefix without touching the network", async () => {
    await assertRejects(() => RedisKvStore.connect("127.0.0.1", 0, ""), TypeError)
  })
})

describe("RedisKvStore reconnecting after a dead connection", () => {
  it("shares one reconnect attempt between concurrent callers", async () => {
    const { store, conns } = await connectFake()

    // Kills the first call outright — its own read fails in flight — which is what
    // records the connection error every later call finds.
    conns[0].breakConnection()
    await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)

    // Every reply this replacement will ever hand out is queued up front, in the
    // exact order the two commands below expect: the PING from the reconnect first,
    // then one GET reply per concurrent caller. Queuing them now, rather than having
    // Deno.connect enqueue the PONG lazily when called, is what keeps that order
    // fixed regardless of exactly when the reconnect's Deno.connect call happens.
    const replacement = createFakeConn()
    replacement.reply("+PONG")
    replacement.reply("$-1") // GET "a" -> null
    replacement.reply("$-1") // GET "b" -> null
    let reconnectCalls = 0
    Deno.connect = (() => {
      reconnectCalls++
      return Promise.resolve(replacement.conn)
    }) as unknown as typeof Deno.connect

    const [a, b] = await Promise.all([store.get("a"), store.get("b")])

    assertEquals(a, null)
    assertEquals(b, null)
    // Both concurrent callers found the connection dead, but only one of them opened
    // a socket — the other rode that same in-flight reconnect instead of racing to
    // open a second one.
    assertEquals(reconnectCalls, 1)
    // And the dead socket itself is not just abandoned: the reconnect closed it.
    assertEquals(conns[0].closed, true)

    store.close()
  })

  it("throws when a reconnect fails, and lets the next call try again", async () => {
    const { store, conns } = await connectFake()

    conns[0].breakConnection()
    await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)

    // The reconnect attempt itself fails to open a socket at all.
    Deno.connect =
      (() => Promise.reject(new Error("ECONNREFUSED (fake)"))) as unknown as typeof Deno.connect
    const failure = await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)
    assertEquals((failure.cause as Error).message, "ECONNREFUSED (fake)")

    // The next call gets its own fresh attempt, which this time succeeds. Both
    // replies are queued up front, in order, so the PING inside the reconnect
    // consumes the PONG before the GET below ever reads the second reply.
    const replacement = createFakeConn()
    replacement.reply("+PONG")
    replacement.reply("$-1") // GET "k" -> null
    Deno.connect = (() => Promise.resolve(replacement.conn)) as unknown as typeof Deno.connect
    assertEquals(await store.get("k"), null)

    store.close()
  })

  it("closes the new socket and throws RedisKvStoreClosedError when close() races a reconnect", async () => {
    const { store, conns } = await connectFake()

    conns[0].breakConnection()
    await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)

    // The reconnect's own Deno.connect only resolves once this test lets it, so
    // store.close() below is guaranteed to run while the reconnect is still in
    // flight, not before or after it.
    const replacement = createFakeConn()
    replacement.reply("+PONG") // queued now; the buffered reply waits for PING below
    let resolveConnect: (() => void) | undefined
    Deno.connect = (() =>
      new Promise<Deno.TcpConn>((resolve) => {
        resolveConnect = () => resolve(replacement.conn)
      })) as unknown as typeof Deno.connect

    const pending = store.get("k")
    store.close()
    resolveConnect?.()

    await assertRejects(() => pending, RedisKvStoreClosedError)
    assertEquals(replacement.closed, true)

    // Every call after close() throws the same way, without touching the network.
    await assertRejects(() => store.get("k"), RedisKvStoreClosedError)
  })

  it("does not blame a late failure from the old connection on the new one", async () => {
    const { store, conns } = await connectFake()

    // The old connection's write for the upcoming GET "a" will fail, but its read
    // is left pending — a write failing while that same call's read is still in
    // flight, not a connection that is already fully dead.
    conns[0].failNextWrite(new Error("write boom (fake)"))
    const pendingA = store.get("a")
    // The write is never awaited by RedisClient itself (see trapWriteErrors' own
    // doc comment), so its failure lands on the holder asynchronously; a macrotask
    // tick is enough to let it land before the next call checks for it.
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The second call finds the connection dead (from that write failure) and
    // reconnects onto a fresh one — a real Deno.connect count, isolated from the
    // one connectFake() already made for the initial connect.
    const replacement = createFakeConn()
    replacement.reply("+PONG")
    replacement.reply("$-1") // GET "b" -> null
    replacement.reply("$-1") // GET "c" -> null, read only if a third connect never happens
    let connectCalls = 0
    Deno.connect = (() => {
      connectCalls++
      return Promise.resolve(replacement.conn)
    }) as unknown as typeof Deno.connect
    assertEquals(await store.get("b"), null)
    assertEquals(connectCalls, 1)

    // Only now, well after the reconnect above already swapped in the new
    // connection and a fresh error holder, does the old connection's still-pending
    // read fail late.
    conns[0].breakConnection()
    await assertRejects(() => pendingA, RedisKvStoreConnectionError)

    // The late failure must be recorded on the OLD holder, the one the dead "a"
    // call actually used — not on the store's current one. A third call proceeds
    // straight on the already-reconnected connection instead of opening a socket
    // it does not need.
    assertEquals(await store.get("c"), null)
    assertEquals(connectCalls, 1)

    store.close()
  })

  it("times out and rejects instead of hanging when Deno.connect never settles", async () => {
    const { store, conns } = await connectFake()
    conns[0].breakConnection()
    await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)

    // Stubs AbortSignal.timeout itself instead of waiting out the real 5-second
    // bound: it hands back an already-aborted signal, the same way the real one
    // would once its timer fired, so the reconnect's Deno.connect call below is
    // aborted the instant it is made. FakeTime is not used here: it would pull in
    // @std/testing/time's own dependencies, which this worktree's deno.lock does
    // not have and is not allowed to change.
    AbortSignal.timeout = ((_ms: number) =>
      AbortSignal.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      )) as typeof AbortSignal.timeout

    // A Deno.connect that never resolves on its own — exactly what connecting to
    // an unreachable, rather than a refusing, host looks like — but honours the
    // signal it was given, the same contract the real Deno.connect makes.
    Deno.connect =
      ((options: { signal?: AbortSignal }) =>
        new Promise<Deno.TcpConn>((_resolve, reject) => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason))
        })) as unknown as typeof Deno.connect

    const failure = await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)
    assertEquals((failure.cause as DOMException).name, "TimeoutError")

    store.close()
  })

  it("times out and rejects instead of hanging when PING never answers", async () => {
    const { store, conns } = await connectFake()
    conns[0].breakConnection()
    await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)

    // A connection that accepts the reconnect's Deno.connect just fine but never
    // answers PING at all — a frozen Redis, or a proxy whose backend is down. No
    // reply is ever queued on it.
    const replacement = createFakeConn()
    Deno.connect = (() => Promise.resolve(replacement.conn)) as unknown as typeof Deno.connect

    // Stubs setTimeout itself instead of waiting out the real 5-second bound: the
    // deadline timer #openConnection sets for PING fires on the next tick instead
    // of after CONNECT_TIMEOUT_MS. clearTimeout is untouched, so the normal
    // (PING-answers-in-time) path this stub does not exercise still cancels its
    // deadline exactly as it does outside tests.
    globalThis.setTimeout =
      ((callback: () => void) => originalSetTimeout(callback, 0)) as typeof setTimeout

    const failure = await assertRejects(() => store.get("k"), RedisKvStoreConnectionError)
    assertEquals((failure.cause as DOMException).name, "TimeoutError")

    // The next call makes its own fresh attempt rather than reusing the timed-out
    // connection.
    globalThis.setTimeout = originalSetTimeout
    const secondReplacement = createFakeConn()
    secondReplacement.reply("+PONG")
    secondReplacement.reply("$-1") // GET "k" -> null
    Deno.connect = (() => Promise.resolve(secondReplacement.conn)) as unknown as typeof Deno.connect
    assertEquals(await store.get("k"), null)

    store.close()
  })
})
