import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import {
  type ClientTransport,
  ConnectionLostError,
  RequestTimeoutError,
  TransportStatus,
} from "./client-transport.ts"
import { RealtimeRequestError } from "./errors.ts"
import {
  type AvailableCallPort,
  type CallPort,
  createComposedCallPort,
  createHttpCallPort,
  createSocketCallPort,
  isRetryable,
  sendCommand,
  sendQuery,
  type SocketCallTransport,
  withUnauthorizedHook,
} from "./calls.ts"

/** Compile-time check: a real `ClientTransport` fills the socket port. */
export const asSocketTransport = (transport: ClientTransport): SocketCallTransport => transport

/** What the fake server saw. */
interface Seen {
  name: string
  payload: unknown
  key?: string
  user?: string
}

/** A server whose answers are scripted: an Error is thrown, anything else is the result. */
function fakeServer(answers: unknown[] = []) {
  const seen: Seen[] = []
  const answer = (): unknown => {
    const next = answers.length === 0 ? { ok: true } : answers.shift()
    if (next instanceof Error) throw next
    return next
  }
  return { seen, answer }
}

type Server = ReturnType<typeof fakeServer>

/** A socket transport that talks to the fake server. */
function socketTransport(server: Server, status = TransportStatus.Open): SocketCallTransport {
  return {
    status,
    command(name, payload, options) {
      server.seen.push({ name, payload, key: options?.idempotencyKey })
      return Promise.resolve().then(server.answer)
    },
    query(name, payload) {
      server.seen.push({ name, payload })
      return Promise.resolve().then(server.answer)
    },
  }
}

/** A `fetch` that is the server half of the wire contract, over the fake server. */
function serverFetch(server: Server, status?: number): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    server.seen.push({
      name: decodeURIComponent(String(input).split("/").pop()!),
      payload: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      key: headers.get("Idempotency-Key") ?? undefined,
      user: headers.get("X-Realtime-User") ?? undefined,
    })
    try {
      return Promise.resolve(Response.json({ result: server.answer() }, { status: status ?? 200 }))
    } catch (error) {
      if (error instanceof RealtimeRequestError) {
        const body = { error: { code: error.code, message: error.message, details: error.details } }
        return Promise.resolve(Response.json(body, { status: 400 }))
      }
      return Promise.reject(error)
    }
  }
}

const noSleep = () => Promise.resolve()

type Make = (server: Server, hooks: { onUnauthorized: () => void }) => CallPort

/** The same port, filled three ways. A store passes the contract over each. */
const ports: Record<string, Make> = {
  "the socket port": (server, hooks) =>
    withUnauthorizedHook(createSocketCallPort(socketTransport(server)), hooks.onUnauthorized),
  "the HTTP port": (server, hooks) =>
    createHttpCallPort({
      baseUrl: "https://app.test/api/call",
      userId: "u-1",
      fetch: serverFetch(server),
      onUnauthorized: hooks.onUnauthorized,
    }),
  "the composed port": (server, hooks) =>
    withUnauthorizedHook(
      createComposedCallPort({
        socket: createSocketCallPort(socketTransport(server)),
        http: createHttpCallPort({
          baseUrl: "https://app.test/api/call",
          userId: "u-1",
          fetch: serverFetch(fakeServer([new Error("HTTP must not be used")])),
        }),
      }),
      hooks.onUnauthorized,
    ),
}

for (const [portName, make] of Object.entries(ports)) {
  describe(`${portName}, the calls contract`, () => {
    it("returns a command's result and sends its key", async () => {
      const server = fakeServer([{ id: "g-1" }])
      const port = make(server, { onUnauthorized: () => {} })

      const result = await port.command("group.create", { name: "A" }, { idempotencyKey: "k-1" })

      expect(result).toEqual({ id: "g-1" })
      expect(server.seen[0]).toMatchObject({
        name: "group.create",
        payload: { name: "A" },
        key: "k-1",
      })
    })

    it("returns a query's result", async () => {
      const server = fakeServer([{ groups: [] }])
      const port = make(server, { onUnauthorized: () => {} })

      expect(await port.query("group.list", { limit: 5 })).toEqual({ groups: [] })
      expect(server.seen[0]).toMatchObject({ name: "group.list", payload: { limit: 5 } })
    })

    it("throws the server's code and details as a RealtimeRequestError", async () => {
      const server = fakeServer([
        new RealtimeRequestError("conflict", "busy", { code: "IN_PROGRESS" }),
      ])
      const port = make(server, { onUnauthorized: () => {} })

      const error = await port.command("x", {}, { idempotencyKey: "k" }).catch((e) => e)

      expect(error).toBeInstanceOf(RealtimeRequestError)
      expect(error).toMatchObject({ code: "conflict", details: { code: "IN_PROGRESS" } })
    })

    it("calls the unauthorized hook once and rejects, without sending again", async () => {
      const server = fakeServer([new RealtimeRequestError("unauthorized", "signed out")])
      let hooked = 0
      const port = make(server, { onUnauthorized: () => hooked++ })

      await expect(sendCommand(port, "x", {}, { sleep: noSleep })).rejects.toMatchObject({
        code: "unauthorized",
      })

      expect(hooked).toBe(1)
      expect(server.seen).toHaveLength(1)
    })

    it("rejects with the signal's reason when the call is aborted first", async () => {
      const server = fakeServer()
      const port = make(server, { onUnauthorized: () => {} })
      const controller = new AbortController()
      controller.abort(new Error("page closed"))

      await expect(port.query("x", {}, { signal: controller.signal })).rejects.toThrow(
        "page closed",
      )
    })
  })
}

describe("the HTTP port", () => {
  function recordingFetch(response: Response | Error) {
    const requests: { url: string; init: RequestInit }[] = []
    const fetcher: typeof fetch = (input, init) => {
      requests.push({ url: String(input), init: init! })
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
    }
    return { requests, fetcher }
  }

  const port = (fetcher: typeof fetch, extra: { timeoutMs?: number } = {}) =>
    createHttpCallPort({
      baseUrl: "https://app.test/api/call/",
      userId: "u-7",
      fetch: fetcher,
      ...extra,
    })

  it("posts the payload as JSON to base/name with the user and the key", async () => {
    const { requests, fetcher } = recordingFetch(Response.json({ result: 1 }))

    await port(fetcher).command("note.create", { title: "T" }, { idempotencyKey: "k-9" })

    const { url, init } = requests[0]!
    const headers = new Headers(init.headers)
    expect(url).toBe("https://app.test/api/call/note.create")
    expect(init.method).toBe("POST")
    expect(init.body).toBe(`{"title":"T"}`)
    expect(headers.get("Content-Type")).toBe("application/json")
    expect(headers.get("X-Realtime-User")).toBe("u-7")
    expect(headers.get("Idempotency-Key")).toBe("k-9")
  })

  it("sends a query without an idempotency key and a missing payload as no body", async () => {
    const { requests, fetcher } = recordingFetch(Response.json({ result: [] }))

    await port(fetcher).query("group.list")

    const { init } = requests[0]!
    expect(new Headers(init.headers).has("Idempotency-Key")).toBe(false)
    expect(init.body).toBeUndefined()
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json")
  })

  it("returns a falsy result as it is", async () => {
    const { fetcher } = recordingFetch(Response.json({ result: 0 }))

    expect(await port(fetcher).query("count")).toBe(0)
  })

  it("encodes the call name as one path segment", async () => {
    const { requests, fetcher } = recordingFetch(Response.json({ result: 1 }))

    await port(fetcher).query("a/b c")

    expect(requests[0]!.url).toBe("https://app.test/api/call/a%2Fb%20c")
  })

  it("reads the nested error body, details included", async () => {
    const body = {
      error: { code: "bad_request", message: "name is empty", details: [{ f: "name" }] },
    }
    const { fetcher } = recordingFetch(Response.json(body, { status: 422 }))

    const error = await port(fetcher).command("x", {}).catch((e) => e)

    expect(error).toBeInstanceOf(RealtimeRequestError)
    expect(error).toMatchObject({
      code: "bad_request",
      message: "name is empty",
      details: [{ f: "name" }],
    })
  })

  it("keeps the code of an `internal` answer instead of calling it a lost connection", async () => {
    const body = { error: { code: "internal", message: "Something went wrong" } }
    const { fetcher } = recordingFetch(Response.json(body, { status: 500 }))

    await expect(port(fetcher).query("x")).rejects.toMatchObject({ code: "internal" })
  })

  it("treats a failed fetch as a lost connection", async () => {
    const { fetcher } = recordingFetch(new TypeError("Failed to fetch"))

    const error = await port(fetcher).query("x").catch((e) => e)

    expect(error).toBeInstanceOf(ConnectionLostError)
    expect((error as Error).message).toContain("Failed to fetch")
  })

  it("treats a 5xx without an error body as a lost connection", async () => {
    const { fetcher } = recordingFetch(new Response("<html>Bad gateway</html>", { status: 502 }))

    await expect(port(fetcher).command("x", {})).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("treats a 2xx without a result as a lost connection", async () => {
    const { fetcher } = recordingFetch(new Response("<html>Sign in to Wi-Fi</html>"))

    await expect(port(fetcher).query("x")).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("treats a 2xx JSON body without a result key as a lost connection", async () => {
    const { fetcher } = recordingFetch(Response.json({ ok: true }))

    await expect(port(fetcher).query("x")).rejects.toBeInstanceOf(ConnectionLostError)
  })

  it("gives a 4xx without an error body the code its status stands for", async () => {
    const codes: Record<number, string> = {
      400: "bad_request",
      401: "unauthorized",
      403: "forbidden",
      408: "timeout",
      409: "conflict",
    }
    for (const [status, code] of Object.entries(codes)) {
      const { fetcher } = recordingFetch(new Response("", { status: Number(status) }))

      await expect(port(fetcher).query("x")).rejects.toMatchObject({ code })
    }
  })

  it("treats a proxy's bare 404 or 429 as a lost connection", async () => {
    for (const status of [404, 429]) {
      const { fetcher } = recordingFetch(new Response("404 page not found", { status }))

      await expect(port(fetcher).query("x")).rejects.toBeInstanceOf(ConnectionLostError)
    }
  })

  it("keeps the code of a 404 or 429 that carries the error body", async () => {
    const cases: [number, string][] = [[404, "not_found"], [429, "rate_limited"]]
    for (const [status, code] of cases) {
      const { fetcher } = recordingFetch(
        Response.json({ error: { code, message: "m" } }, { status }),
      )

      await expect(port(fetcher).query("x")).rejects.toMatchObject({ code })
    }
  })

  it("gives up with a lost connection when no answer comes within the timeout", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))
      })

    const error = await port(fetcher, { timeoutMs: 5 }).query("slow").catch((e) => e)

    expect(error).toBeInstanceOf(ConnectionLostError)
    expect((error as Error).message).toContain("within 5 ms")
  })

  it("rejects with the signal's reason, not a lost connection, when the caller aborts", async () => {
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new DOMException("x", "AbortError")))
      })
    const controller = new AbortController()

    const call = port(fetcher).query("slow", undefined, { signal: controller.signal })
    controller.abort(new Error("page closed"))

    await expect(call).rejects.toThrow("page closed")
  })

  it("calls onUnauthorized for a 401 without a body", async () => {
    const { fetcher } = recordingFetch(new Response("", { status: 401 }))
    let hooked = 0
    const http = createHttpCallPort({
      baseUrl: "/api",
      userId: "u",
      fetch: fetcher,
      onUnauthorized: () => hooked++,
    })

    await http.query("x").catch(() => {})

    expect(hooked).toBe(1)
  })
})

describe("withUnauthorizedHook", () => {
  it("does not fire for other server answers or for a lost connection", async () => {
    const answers = [
      new RealtimeRequestError("forbidden", "no"),
      new RealtimeRequestError("conflict", "in use"),
      new ConnectionLostError("closed"),
    ]
    let hooked = 0
    const { port } = scriptedPort(answers.slice())
    const watched = withUnauthorizedHook(port, () => hooked++)

    for (let i = 0; i < answers.length; i++) await watched.query("x").catch(() => {})

    expect(hooked).toBe(0)
  })
})

describe("the composed port", () => {
  function setup(options: { status?: TransportStatus; socketAnswers?: unknown[] } = {}) {
    const socketServer = fakeServer(options.socketAnswers)
    const httpServer = fakeServer(["from http"])
    const port = createComposedCallPort({
      socket: createSocketCallPort(socketTransport(socketServer, options.status)),
      http: createHttpCallPort({ baseUrl: "/api", userId: "u", fetch: serverFetch(httpServer) }),
    })
    return { port, socketServer, httpServer }
  }

  it("uses the socket while it is open", async () => {
    const { port, socketServer, httpServer } = setup({ socketAnswers: ["from socket"] })

    expect(await port.query("x")).toBe("from socket")
    expect(socketServer.seen).toHaveLength(1)
    expect(httpServer.seen).toHaveLength(0)
  })

  it("uses HTTP while the socket is not open", async () => {
    for (
      const status of [
        TransportStatus.Idle,
        TransportStatus.Connecting,
        TransportStatus.Reconnecting,
      ]
    ) {
      const { port, socketServer, httpServer } = setup({ status })

      expect(await port.command("x", {}, { idempotencyKey: "k" })).toBe("from http")
      expect(socketServer.seen).toHaveLength(0)
      expect(httpServer.seen).toHaveLength(1)
    }
  })

  it("sends a command again over HTTP with the same key after the socket is lost", async () => {
    const { port, httpServer } = setup({ socketAnswers: [new ConnectionLostError("closed")] })

    const result = await port.command("group.create", { n: 1 }, { idempotencyKey: "k-5" })

    expect(result).toBe("from http")
    expect(httpServer.seen).toEqual([
      { name: "group.create", payload: { n: 1 }, key: "k-5", user: "u" },
    ])
  })

  it("sends a query again over HTTP after the socket is lost", async () => {
    const { port, httpServer } = setup({ socketAnswers: [new ConnectionLostError("closed")] })

    expect(await port.query("group.list")).toBe("from http")
    expect(httpServer.seen).toHaveLength(1)
  })

  it("does not send a command without a key again, since the socket may have delivered it", async () => {
    const { port, httpServer } = setup({ socketAnswers: [new ConnectionLostError("closed")] })

    await expect(port.command("group.create", {})).rejects.toBeInstanceOf(ConnectionLostError)
    expect(httpServer.seen).toHaveLength(0)
  })

  it("does not ask HTTP again when the server answered over the socket", async () => {
    const { port, httpServer } = setup({
      socketAnswers: [new RealtimeRequestError("forbidden", "no")],
    })

    await expect(port.query("x")).rejects.toMatchObject({ code: "forbidden" })
    expect(httpServer.seen).toHaveLength(0)
  })

  it("does not ask HTTP again after a socket timeout; the retry decides", async () => {
    const { port, httpServer } = setup({ socketAnswers: [new RequestTimeoutError("r-1", 15_000)] })

    await expect(port.query("x")).rejects.toBeInstanceOf(RequestTimeoutError)
    expect(httpServer.seen).toHaveLength(0)
  })
})

describe("the socket port", () => {
  it("is available only while the transport is open", () => {
    const server = fakeServer()
    const states = new Map<TransportStatus, boolean>()
    for (const status of Object.values(TransportStatus).filter((v) => typeof v === "number")) {
      const port: AvailableCallPort = createSocketCallPort(
        socketTransport(server, status as TransportStatus),
      )
      states.set(status as TransportStatus, port.isAvailable())
    }

    expect([...states].filter(([, available]) => available).map(([status]) => status)).toEqual([
      TransportStatus.Open,
    ])
  })

  it("passes the key to the transport and no signal", async () => {
    const received: unknown[] = []
    const transport: SocketCallTransport = {
      status: TransportStatus.Open,
      command: (_name, _payload, options) => {
        received.push(options)
        return Promise.resolve(1)
      },
      query: () => Promise.resolve(1),
    }

    await createSocketCallPort(transport).command("x", {}, {
      idempotencyKey: "k",
      signal: new AbortController().signal,
    })

    expect(received).toEqual([{ idempotencyKey: "k" }])
  })

  it("rejects at once when the signal aborts while the transport still waits", async () => {
    const transport: SocketCallTransport = {
      status: TransportStatus.Open,
      command: () => new Promise(() => {}),
      query: () => new Promise(() => {}),
    }
    const controller = new AbortController()

    const call = createSocketCallPort(transport).query("x", {}, { signal: controller.signal })
    controller.abort(new Error("page closed"))

    await expect(call).rejects.toThrow("page closed")
  })
})

describe("isRetryable", () => {
  it("is true for an unknown outcome and for a command still running", () => {
    expect(isRetryable(new ConnectionLostError("x"))).toBe(true)
    expect(isRetryable(new RequestTimeoutError("r", 1))).toBe(true)
    expect(isRetryable(new RealtimeRequestError("timeout", "slow"))).toBe(true)
    expect(isRetryable(new RealtimeRequestError("conflict", "x", { code: "IN_PROGRESS" }))).toBe(
      true,
    )
  })

  it("is false for an answer that will not change", () => {
    expect(isRetryable(new RealtimeRequestError("conflict", "x", { code: "ID_ALREADY_EXISTS" })))
      .toBe(false)
    expect(isRetryable(new RealtimeRequestError("unauthorized", "x"))).toBe(false)
    expect(isRetryable(new RealtimeRequestError("internal", "x"))).toBe(false)
    expect(isRetryable(new Error("boom"))).toBe(false)
  })
})

interface Sent {
  name: string
  payload: unknown
  key?: string
}

/** A port whose next answers are scripted: an Error rejects, anything else resolves. */
function scriptedPort(answers: unknown[]): { port: CallPort; sent: Sent[] } {
  const sent: Sent[] = []
  const next = (): Promise<unknown> => {
    const answer = answers.shift()
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  return {
    sent,
    port: {
      command(name, payload, options) {
        sent.push({ name, payload, key: options?.idempotencyKey })
        return next()
      },
      query(name, payload) {
        sent.push({ name, payload })
        return next()
      },
    },
  }
}

describe("sendCommand", () => {
  it("sends the command with a key and returns the result", async () => {
    const { port, sent } = scriptedPort([{ ok: 1 }])

    const result = await sendCommand(port, "group.create", { name: "A" }, { newKey: () => "k-1" })

    expect(result).toEqual({ ok: 1 })
    expect(sent).toEqual([{ name: "group.create", payload: { name: "A" }, key: "k-1" }])
  })

  it("retries a dropped connection and a timeout with the same key", async () => {
    const { port, sent } = scriptedPort([
      new ConnectionLostError("closed"),
      new RequestTimeoutError("r-1", 15_000),
      { ok: 1 },
    ])
    let keysMade = 0

    const result = await sendCommand(port, "group.create", {}, {
      sleep: noSleep,
      newKey: () => `k-${++keysMade}`,
    })

    expect(result).toEqual({ ok: 1 })
    expect(keysMade).toBe(1)
    expect(sent.map((frame) => frame.key)).toEqual(["k-1", "k-1", "k-1"])
  })

  it("retries a server timeout and a first try that is still running", async () => {
    const { port, sent } = scriptedPort([
      new RealtimeRequestError("timeout", "too slow"),
      new RealtimeRequestError("conflict", "running", { code: "IN_PROGRESS" }),
      { ok: 1 },
    ])

    await sendCommand(port, "group.create", {}, { sleep: noSleep })

    expect(sent).toHaveLength(3)
  })

  it("does not retry an answer that will not change", async () => {
    const { port, sent } = scriptedPort([
      new RealtimeRequestError("conflict", "in use", { code: "ID_ALREADY_EXISTS" }),
    ])

    await expect(sendCommand(port, "group.create", {}, { sleep: noSleep })).rejects.toMatchObject({
      code: "conflict",
    })
    expect(sent).toHaveLength(1)
  })

  it("gives up after the attempts and rethrows the last error", async () => {
    const { port, sent } = scriptedPort([
      new ConnectionLostError("a"),
      new ConnectionLostError("b"),
      new ConnectionLostError("c"),
    ])

    await expect(sendCommand(port, "x", {}, { attempts: 3, sleep: noSleep })).rejects.toThrow("c")
    expect(sent).toHaveLength(3)
  })

  it("doubles the wait before each further try, from backoffDelay", async () => {
    const { port } = scriptedPort([
      new ConnectionLostError("a"),
      new ConnectionLostError("b"),
      new ConnectionLostError("c"),
      { ok: 1 },
    ])
    const waits: number[] = []

    await sendCommand(port, "x", {}, {
      delayMs: 100,
      random: () => 1,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    expect(waits).toEqual([100, 200, 400])
  })

  it("never waits longer than maxDelayMs", async () => {
    const { port } = scriptedPort([
      new ConnectionLostError("a"),
      new ConnectionLostError("b"),
      new ConnectionLostError("c"),
      { ok: 1 },
    ])
    const waits: number[] = []

    await sendCommand(port, "x", {}, {
      delayMs: 100,
      maxDelayMs: 150,
      random: () => 1,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    expect(waits).toEqual([100, 150, 150])
  })

  it("takes the jitter from the random source, never above the plain wait", async () => {
    const { port } = scriptedPort([new ConnectionLostError("a"), { ok: 1 }])
    const waits: number[] = []

    await sendCommand(port, "x", {}, {
      delayMs: 100,
      jitterRatio: 0.5,
      random: () => 0,
      sleep: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    })

    expect(waits).toEqual([50])
  })

  it("stops waiting and rejects with the reason when the signal aborts between tries", async () => {
    const { port, sent } = scriptedPort([new ConnectionLostError("a"), { ok: 1 }])
    const controller = new AbortController()

    const call = sendCommand(port, "x", {}, {
      signal: controller.signal,
      sleep: () => new Promise(() => {}),
    })
    await Promise.resolve()
    await Promise.resolve()
    controller.abort(new Error("page closed"))

    await expect(call).rejects.toThrow("page closed")
    expect(sent).toHaveLength(1)
  })

  it("passes its signal to the port on every try", async () => {
    const signals: (AbortSignal | undefined)[] = []
    const port: CallPort = {
      command: (_name, _payload, options) => {
        signals.push(options?.signal)
        return signals.length < 2
          ? Promise.reject(new ConnectionLostError("a"))
          : Promise.resolve(1)
      },
      query: () => Promise.resolve(1),
    }
    const controller = new AbortController()

    await sendCommand(port, "x", {}, { signal: controller.signal, sleep: noSleep })

    expect(signals).toEqual([controller.signal, controller.signal])
  })

  it("passes its signal to the port for a query", async () => {
    let received: AbortSignal | undefined
    const port: CallPort = {
      command: () => Promise.resolve(1),
      query: (_name, _payload, options) => {
        received = options?.signal
        return Promise.resolve(1)
      },
    }
    const controller = new AbortController()

    await sendQuery(port, "x", {}, { signal: controller.signal })

    expect(received).toBe(controller.signal)
  })

  it("clears the wait timer when the signal aborts during the wait", async () => {
    const { port } = scriptedPort([new ConnectionLostError("a"), { ok: 1 }])
    const controller = new AbortController()
    const realSet = globalThis.setTimeout
    const realClear = globalThis.clearTimeout
    const pending = new Set<unknown>()
    globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      const id = realSet(handler, ms, ...args)
      if (ms === 20_000) pending.add(id)
      return id
    }) as typeof setTimeout
    globalThis.clearTimeout = ((id?: number) => {
      pending.delete(id)
      realClear(id)
    }) as typeof clearTimeout
    try {
      const call = sendCommand(port, "x", {}, {
        signal: controller.signal,
        delayMs: 20_000,
        random: () => 1,
      })
      await new Promise((resolve) => realSet(resolve, 5))
      expect(pending.size).toBe(1)
      controller.abort(new Error("page closed"))

      await expect(call).rejects.toThrow("page closed")
      expect(pending.size).toBe(0)
    } finally {
      for (const id of pending) realClear(id as number)
      globalThis.setTimeout = realSet
      globalThis.clearTimeout = realClear
    }
  })

  it("repeats a command over HTTP with one key across every try", async () => {
    const calls: (string | null)[] = []
    let n = 0
    const fetcher: typeof fetch = (_input, init) => {
      calls.push(new Headers(init?.headers).get("Idempotency-Key"))
      return ++n < 3
        ? Promise.reject(new TypeError("offline"))
        : Promise.resolve(Response.json({ result: "done" }))
    }
    const http = createHttpCallPort({ baseUrl: "/api", userId: "u", fetch: fetcher })

    const result = await sendCommand(http, "x", {}, { sleep: noSleep, newKey: () => "k-1" })

    expect(result).toBe("done")
    expect(calls).toEqual(["k-1", "k-1", "k-1"])
  })
})

describe("sendQuery", () => {
  it("retries a dropped connection and sends no key", async () => {
    const { port, sent } = scriptedPort([new ConnectionLostError("closed"), { groups: [] }])

    const result = await sendQuery(port, "group.list", { limit: 5 }, { sleep: noSleep })

    expect(result).toEqual({ groups: [] })
    expect(sent).toEqual([
      { name: "group.list", payload: { limit: 5 } },
      { name: "group.list", payload: { limit: 5 } },
    ])
  })
})
