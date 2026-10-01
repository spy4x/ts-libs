// The `ManagedSocket` contract, written once and run against both implementations:
// `testing.test.ts` runs it on `FakeSocket` in the unit tier, and
// `web-socket-adapter.integration.test.ts` runs it on the real adapter over a real loopback
// WebSocket server. `ClientTransport` and `ConnectionRegistry` are tested through `FakeSocket`, so a
// case it gets wrong here is a case their tests get wrong too.
//
// Not a test file in itself: it is named `*.test.ts` only so the root `publish.exclude` pattern keeps
// it out of the published package, and it registers no tests until a caller runs
// `describeSocketContract`.

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { type ManagedSocket, type SocketCloseInfo, SocketState } from "./socket-port.ts"

/** The other end of a socket: what a test does as the server. */
export interface SocketPeer {
  /** The peer accepts the connection. Resolves once it has; the socket then opens by itself. */
  accept(): Promise<void>
  /** Resolves with the first `count` frames the socket sent, once that many arrived. */
  received(count: number): Promise<string[]>
  /** The peer sends one text frame. */
  send(data: string): void
  /** The peer closes the connection with a code and a reason. */
  close(code: number, reason: string): void
}

/** A still-connecting socket, its peer, and how to dispose of both. */
export interface SocketFixture {
  socket: ManagedSocket
  peer: SocketPeer
  close(): Promise<void>
}

/** Opens a fresh fixture for one case. The socket must still be `Connecting`. */
export type OpenSocket = () => Promise<SocketFixture>

async function withFixture(
  open: OpenSocket,
  body: (socket: ManagedSocket, peer: SocketPeer) => Promise<void>,
): Promise<void> {
  const fixture = await open()
  try {
    await body(fixture.socket, fixture.peer)
  } finally {
    await fixture.close()
  }
}

/** Resolves on the next open event. Register before the event can fire. */
function nextOpen(socket: ManagedSocket): Promise<void> {
  return new Promise((resolve) => {
    const off = socket.onOpen(() => {
      off()
      resolve()
    })
  })
}

/** Resolves with the first close event. Register before the event can fire. */
function nextClose(socket: ManagedSocket): Promise<SocketCloseInfo> {
  return new Promise((resolve) => {
    const off = socket.onClose((info) => {
      off()
      resolve(info)
    })
  })
}

/** Resolves with the next `count` messages. */
function nextMessages(socket: ManagedSocket, count: number): Promise<string[]> {
  const got: string[] = []
  return new Promise((resolve) => {
    const off = socket.onMessage((data) => {
      got.push(data)
      if (got.length === count) {
        off()
        resolve(got)
      }
    })
  })
}

/** Accepts the connection and waits until the socket reports it open. */
async function openSocket(socket: ManagedSocket, peer: SocketPeer): Promise<void> {
  const opened = nextOpen(socket)
  await peer.accept()
  await opened
}

/** Lets pending events run, for asserting that something did not happen. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50))

/** Registers the contract suite for one implementation. */
export function describeSocketContract(name: string, open: OpenSocket): void {
  describe(`${name} (socket contract)`, () => {
    it("starts Connecting and becomes Open when the peer accepts", async () => {
      await withFixture(open, async (socket, peer) => {
        expect(socket.state).toBe(SocketState.Connecting)
        await openSocket(socket, peer)
        expect(socket.state).toBe(SocketState.Open)
      })
    })

    it("is already Open inside the open handler", async () => {
      await withFixture(open, async (socket, peer) => {
        const seen = new Promise<SocketState>((resolve) => {
          socket.onOpen(() => resolve(socket.state))
        })
        await peer.accept()
        expect(await seen).toBe(SocketState.Open)
      })
    })

    it("throws on send while Connecting", async () => {
      await withFixture(open, (socket) => {
        expect(() => socket.send("early")).toThrow()
        return Promise.resolve()
      })
    })

    it("delivers sent frames to the peer, in order", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        socket.send("one")
        socket.send("two")
        expect(await peer.received(2)).toEqual(["one", "two"])
      })
    })

    it("delivers frames from the peer to every message handler, in order", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const first = nextMessages(socket, 2)
        const second = nextMessages(socket, 2)
        peer.send("a")
        peer.send("b")
        expect(await first).toEqual(["a", "b"])
        expect(await second).toEqual(["a", "b"])
      })
    })

    it("stops calling a message handler after its unsubscribe", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const seen: string[] = []
        const off = socket.onMessage((data) => seen.push(data))
        const kept = nextMessages(socket, 1)
        peer.send("kept")
        await kept
        off()
        const probe = nextMessages(socket, 1)
        peer.send("dropped")
        await probe
        expect(seen).toEqual(["kept"])
      })
    })

    it("is Closing right after close and Closed once the close event fires", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const states: SocketState[] = []
        const closed = new Promise<void>((resolve) => {
          socket.onClose(() => {
            states.push(socket.state)
            resolve()
          })
        })
        socket.close(1000, "done")
        expect(socket.state).toBe(SocketState.Closing)
        await closed
        expect(states).toEqual([SocketState.Closed])
        expect(socket.state).toBe(SocketState.Closed)
      })
    })

    it("reports a clean close the local side asked for with its code and reason", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const closed = nextClose(socket)
        socket.close(4001, "bye")
        expect(await closed).toEqual({ code: 4001, reason: "bye", abnormal: false })
      })
    })

    it("reports a close the peer started with the peer's code and reason", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const closed = nextClose(socket)
        peer.close(4002, "go away")
        const info = await closed
        expect(info.code).toBe(4002)
        expect(info.reason).toBe("go away")
        expect(info.abnormal).toBe(false)
        expect(socket.state).toBe(SocketState.Closed)
      })
    })

    it("throws on send while Closing and after Closed", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        const closed = nextClose(socket)
        socket.close()
        expect(() => socket.send("late")).toThrow()
        await closed
        expect(() => socket.send("later")).toThrow()
      })
    })

    it("fires the close handler once, even if close is called again", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        let calls = 0
        socket.onClose(() => calls++)
        const closed = nextClose(socket)
        socket.close(1000, "first")
        socket.close(4003, "second")
        await closed
        await settle()
        expect(calls).toBe(1)
      })
    })

    it("does not call a close handler after its unsubscribe", async () => {
      await withFixture(open, async (socket, peer) => {
        await openSocket(socket, peer)
        let calls = 0
        const off = socket.onClose(() => calls++)
        off()
        const closed = nextClose(socket)
        socket.close()
        await closed
        expect(calls).toBe(0)
      })
    })

    it("fires the open handler once and no message before it", async () => {
      await withFixture(open, async (socket, peer) => {
        const order: string[] = []
        socket.onOpen(() => order.push(`open:${socket.state}`))
        const got = nextMessages(socket, 1)
        socket.onMessage(() => order.push(`message:${socket.state}`))
        await peer.accept()
        peer.send("hello")
        await got
        await settle()
        expect(order).toEqual([`open:${SocketState.Open}`, `message:${SocketState.Open}`])
      })
    })

    it("closes straight from Connecting without ever opening", async () => {
      await withFixture(open, async (socket) => {
        let opened = false
        socket.onOpen(() => opened = true)
        const closed = nextClose(socket)
        socket.close()
        expect(socket.state).toBe(SocketState.Closing)
        await closed
        expect(opened).toBe(false)
        expect(socket.state).toBe(SocketState.Closed)
      })
    })
  })
}
