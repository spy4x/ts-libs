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

afterEach(() => {
  Deno.connect = originalConnect
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
  closed: boolean
}

/**
 * A `Deno.TcpConn`-shaped fake: a controllable `readable`/`writable` pair and a
 * `close()` that only ever flips a flag `RedisKvStore` never inspects here. Every
 * other `Deno.TcpConn` member (`rid`, `localAddr`, ...) is unused by `RedisClient` or
 * by this module, so the cast is the honest way to say "only these three matter".
 */
function createFakeConn(): FakeConn {
  let readController: ReadableStreamDefaultController<Uint8Array> | undefined
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readController = controller
    },
  })
  const writes: string[] = []
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      writes.push(new TextDecoder().decode(chunk))
    },
  })
  const state: FakeConn = {
    conn: {
      readable,
      writable,
      close() {
        state.closed = true
      },
    } as unknown as Deno.TcpConn,
    writes,
    reply(line) {
      readController?.enqueue(encodeReply(line))
    },
    breakConnection() {
      readController?.error(new Error("fake connection broke"))
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
})
