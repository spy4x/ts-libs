/**
 * An outgoing TCP connection as a pair of web streams, on Deno, Node and Bun: `Deno.connect` on
 * Deno, `node:net` on Node and Bun.
 *
 * @module
 */

/** What {@link connectTcp} opens. */
export interface TcpConnectOptions {
  hostname: string
  port: number
  /** Aborts a connect that is still pending; the promise rejects with the signal's reason. */
  signal?: AbortSignal
}

/** An open TCP connection, narrowed to what a protocol client needs. */
export interface TcpConnection {
  /** Bytes from the peer. Ends when the peer closes; errors when the connection is closed here. */
  readonly readable: ReadableStream<Uint8Array>
  /** Bytes to the peer. A write on a closed connection rejects. */
  readonly writable: WritableStream<Uint8Array>
  /** Releases the socket at once. A pending read fails. */
  close(): void
}

/** A function that opens a {@link TcpConnection}. */
export type TcpConnect = (options: TcpConnectOptions) => Promise<TcpConnection>

/** One `node:net` socket, as far as {@link nodeTcpConnect} uses it. */
export interface NodeSocket {
  on(event: "data", listener: (chunk: Uint8Array) => void): unknown
  on(event: "end" | "close", listener: () => void): unknown
  on(event: "error", listener: (error: Error) => void): unknown
  once(event: "connect", listener: () => void): unknown
  off(event: "connect", listener: () => void): unknown
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): unknown
  end(callback: () => void): unknown
  pause(): unknown
  resume(): unknown
  destroy(): unknown
}

/** `node:net`, as far as {@link nodeTcpConnect} uses it. */
export interface NodeNet {
  createConnection(options: { host: string; port: number }): NodeSocket
}

async function loadNodeNet(): Promise<NodeNet> {
  // A computed specifier keeps `deno check` from pulling in `@types/node`.
  return await import(["node", "net"].join(":")) as NodeNet
}

/**
 * A {@link TcpConnect} over `node:net`, for Node and Bun. It behaves like `Deno.connect`: an abort
 * or a failed connect destroys the socket and rejects, a socket error errors the readable half, and
 * `close()` errors a pending read instead of leaving it waiting.
 */
export function nodeTcpConnect(load: () => Promise<NodeNet> = loadNodeNet): TcpConnect {
  return async ({ hostname, port, signal }) => {
    signal?.throwIfAborted()
    const net = await load()
    signal?.throwIfAborted()
    const socket = net.createConnection({ host: hostname, port })
    let failure: Error | undefined
    let onError: (error: Error) => void = (error) => failure ??= error
    // Always one `error` listener: an `error` event with none crashes the process.
    socket.on("error", (error) => onError(error))
    await new Promise<void>((resolve, reject) => {
      const fail = (reason: unknown) => {
        signal?.removeEventListener("abort", onAbort)
        socket.off("connect", onConnect)
        socket.destroy()
        reject(reason)
      }
      const onAbort = () => fail(signal?.reason)
      const onConnect = () => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }
      onError = fail
      signal?.addEventListener("abort", onAbort, { once: true })
      socket.once("connect", onConnect)
    })

    let done = false
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        const finish = (error?: Error) => {
          if (done) return
          done = true
          if (error) controller.error(error)
          else controller.close()
        }
        onError = (error) => finish(error)
        if (failure) finish(failure)
        socket.on("data", (chunk) => {
          if (done) return
          // A copy: Node's `Buffer` is a view into a shared pool, and its `slice` does not copy.
          controller.enqueue(new Uint8Array(chunk))
          if ((controller.desiredSize ?? 1) <= 0) socket.pause()
        })
        socket.on("end", () => finish())
        socket.on("close", () => finish(new Error("TCP connection closed")))
      },
      pull() {
        socket.resume()
      },
      cancel() {
        done = true
        socket.destroy()
      },
    })
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) =>
        new Promise<void>((resolve, reject) =>
          socket.write(chunk, (error) => error ? reject(error) : resolve())
        ),
      close: () => new Promise<void>((resolve) => socket.end(resolve)),
      abort: () => {
        socket.destroy()
      },
    })
    return { readable, writable, close: () => socket.destroy() }
  }
}

/**
 * Opens a TCP connection to `hostname:port`: `Deno.connect` on Deno, {@link nodeTcpConnect} on
 * Node and Bun. The runtime is checked on each call, not at import.
 *
 * @example
 * ```ts
 * const connection = await connectTcp({ hostname: "127.0.0.1", port: 6379 })
 * connection.close()
 * ```
 */
export const connectTcp: TcpConnect = (options) =>
  "Deno" in globalThis ? Deno.connect(options) : nodeTcpConnect()(options)
