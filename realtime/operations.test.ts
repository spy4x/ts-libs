/**
 * The operations table and its two adapters.
 *
 * The first suite is the acceptance test of the issue: one scenario table runs through the socket
 * server and the HTTP call handler and must get the same results and error codes from both. The
 * rest pin every refusal: `handle` must not have been called.
 */

import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"

import { REALTIME_ERROR_CODES, type RealtimeErrorCode, RealtimeRequestError } from "./errors.ts"
import {
  CALL_ERROR_STATUS,
  type CallHandlerOptions,
  createCallHandler,
  createOperationDispatcher,
  DEFAULT_MAX_CALL_BYTES,
  IDEMPOTENCY_KEY_HEADER,
  isBoundToUser,
  type OperationCall,
  type Operations,
  REALTIME_USER_HEADER,
} from "./operations.ts"
import { ConnectionRegistry } from "./registry.ts"
import { drainMicrotasks, FakeClock, FakeSocketFactory } from "./testing.ts"

interface Actor {
  userId: number
}

class AppError extends Error {}

const ALICE: Actor = { userId: 7 }

/** A table that records every call that reached a handler. */
function createTable(): { operations: Operations<Actor>; calls: OperationCall<Actor>[] } {
  const calls: OperationCall<Actor>[] = []
  const record = (call: OperationCall<Actor>) => {
    calls.push(call)
  }
  const operations: Operations<Actor> = {
    "note.create": {
      kind: "command",
      handle: (call) => {
        record(call)
        return { created: call.payload, by: call.actor.userId, key: call.idempotencyKey }
      },
    },
    "note.list": {
      kind: "query",
      handle: (call) => {
        record(call)
        return { notes: [], filter: call.payload ?? null }
      },
    },
    "note.touch": {
      kind: "command",
      handle: (call) => {
        record(call)
      },
    },
    "note.stale": {
      kind: "command",
      handle: (call) => {
        record(call)
        throw new RealtimeRequestError("conflict", "stale version", { currentVersion: 3 })
      },
    },
    "note.locked": {
      kind: "query",
      handle: (call) => {
        record(call)
        throw new AppError("the note is locked")
      },
    },
    "note.crash": {
      kind: "query",
      handle: (call) => {
        record(call)
        throw new Error("password=hunter2 in SQL")
      },
    },
    "note.secret": {
      kind: "query",
      handle: (call) => {
        record(call)
        throw new RealtimeRequestError("internal", "password=hunter2 in SQL", { dsn: "hunter2" })
      },
    },
    "note.count": {
      kind: "query",
      handle: (call) => {
        record(call)
        return { total: 10n }
      },
    },
  }
  return { operations, calls }
}

function mapError(error: unknown): RealtimeRequestError | null {
  return error instanceof AppError ? new RealtimeRequestError("forbidden", error.message) : null
}

interface CallInput {
  name?: string
  path?: string
  method?: string
  body?: BodyInit | null
  payload?: unknown
  user?: string | null
  key?: string | null
  contentType?: string | null
  headers?: Record<string, string>
}

function callRequest(input: CallInput = {}): Request {
  const headers = new Headers(input.headers)
  const contentType = input.contentType === undefined ? "application/json" : input.contentType
  if (contentType !== null) headers.set("Content-Type", contentType)
  const user = input.user === undefined ? "7" : input.user
  if (user !== null) headers.set(REALTIME_USER_HEADER, user)
  if (input.key !== undefined && input.key !== null) headers.set(IDEMPOTENCY_KEY_HEADER, input.key)
  const method = input.method ?? "POST"
  const body = input.body !== undefined
    ? input.body
    : input.payload !== undefined
    ? JSON.stringify(input.payload)
    : null
  const path = input.path ?? `/api/call/${input.name ?? "note.create"}`
  return new Request(`https://api.example.test${path}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body }),
  })
}

interface HttpHarness {
  calls: OperationCall<Actor>[]
  errors: unknown[]
  call(input?: CallInput): Promise<{ status: number; body: unknown; response: Response }>
}

function createHttp(overrides: Partial<CallHandlerOptions<Actor>> = {}): HttpHarness {
  const { operations, calls } = createTable()
  const errors: unknown[] = []
  const handler = createCallHandler(operations, {
    basePath: "/api/call",
    authenticate: () => ALICE,
    userIdOf: (actor) => actor.userId,
    mapError,
    onError: (error) => errors.push(error),
    ...overrides,
  })
  return {
    calls,
    errors,
    async call(input) {
      const response = await handler(callRequest(input))
      return { status: response.status, body: await response.json(), response }
    },
  }
}

function errorBody(code: RealtimeErrorCode, message: string, details?: unknown): unknown {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } }
}

interface SocketHarness {
  calls: OperationCall<Actor>[]
  errors: unknown[]
  /** Sends one request frame and returns the server's answer frame. */
  send(frame: Record<string, unknown>): Promise<Record<string, unknown>>
}

function createSocket(
  authenticate: () => Actor | null = () => ALICE,
  attachedUserId = "7",
): SocketHarness {
  const { operations, calls } = createTable()
  const errors: unknown[] = []
  const factory = new FakeSocketFactory({ autoOpen: true })
  const registry = new ConnectionRegistry({
    clock: new FakeClock(),
    onRequestError: (error) => errors.push(error),
  })
  registry.onRequest(
    createOperationDispatcher(operations, {
      authenticate,
      userIdOf: (actor) => actor.userId,
      mapError,
    }),
  )
  registry.attach(attachedUserId, factory.open("wss://api.example.test/ws"))
  let next = 0
  return {
    calls,
    errors,
    async send(frame) {
      const id = `r${++next}`
      const before = factory.latest.sent.length
      factory.latest.receive(JSON.stringify({ id, ...frame }))
      await drainMicrotasks(64)
      const answers = factory.latest.frames().slice(before) as Record<string, unknown>[]
      if (answers.length !== 1) throw new Error(`expected one answer, got ${answers.length}`)
      return answers[0]
    },
  }
}

interface Scenario {
  title: string
  kind: "command" | "query"
  name: string
  payload?: unknown
  idempotencyKey?: string
  /** The result both transports must answer with, or the error code both must refuse with. */
  expected: { result: unknown } | { code: RealtimeErrorCode; details?: unknown }
  /** Whether a handler must have run. */
  handled: boolean
}

const SCENARIOS: readonly Scenario[] = [
  {
    title: "a command with a payload and a key",
    kind: "command",
    name: "note.create",
    payload: { text: "milk" },
    idempotencyKey: "k1",
    expected: { result: { created: { text: "milk" }, by: 7, key: "k1" } },
    handled: true,
  },
  {
    title: "a query with a payload",
    kind: "query",
    name: "note.list",
    payload: { tag: "home" },
    expected: { result: { notes: [], filter: { tag: "home" } } },
    handled: true,
  },
  {
    title: "a query with no payload",
    kind: "query",
    name: "note.list",
    expected: { result: { notes: [], filter: null } },
    handled: true,
  },
  {
    title: "a command that returns nothing",
    kind: "command",
    name: "note.touch",
    idempotencyKey: "k2",
    expected: { result: null },
    handled: true,
  },
  {
    title: "an unknown name",
    kind: "query",
    name: "note.nope",
    expected: { code: "not_found" },
    handled: false,
  },
  {
    title: "a name that only Object.prototype has",
    kind: "query",
    name: "constructor",
    expected: { code: "not_found" },
    handled: false,
  },
  {
    title: "a command without an idempotency key",
    kind: "command",
    name: "note.create",
    payload: { text: "milk" },
    expected: { code: "bad_request" },
    handled: false,
  },
  {
    title: "a typed error with details",
    kind: "command",
    name: "note.stale",
    idempotencyKey: "k3",
    expected: { code: "conflict", details: { currentVersion: 3 } },
    handled: true,
  },
  {
    title: "an app error the mapper knows",
    kind: "query",
    name: "note.locked",
    expected: { code: "forbidden" },
    handled: true,
  },
  {
    title: "an unexpected exception",
    kind: "query",
    name: "note.crash",
    expected: { code: "internal" },
    handled: true,
  },
  {
    title: "a typed error that names itself internal",
    kind: "query",
    name: "note.secret",
    expected: { code: "internal" },
    handled: true,
  },
  {
    title: "a result that cannot be encoded",
    kind: "query",
    name: "note.count",
    expected: { code: "internal" },
    handled: true,
  },
]

/** One transport's answer, in the shape the scenario table states. */
interface Outcome {
  result?: unknown
  code?: unknown
  details?: unknown
  message?: unknown
}

async function overSocket(scenario: Scenario): Promise<{ outcome: Outcome; handled: number }> {
  const socket = createSocket()
  const frame = await socket.send({
    kind: `client.${scenario.kind}`,
    name: scenario.name,
    ...(scenario.payload !== undefined ? { payload: scenario.payload } : {}),
    ...(scenario.idempotencyKey !== undefined ? { idempotencyKey: scenario.idempotencyKey } : {}),
  })
  const outcome: Outcome = frame.kind === "server.result"
    ? { result: frame.payload ?? null }
    : { code: frame.code, details: frame.details, message: frame.message }
  return { outcome, handled: socket.calls.length }
}

async function overHttp(scenario: Scenario): Promise<{ outcome: Outcome; handled: number }> {
  const http = createHttp()
  const { status, body } = await http.call({
    name: scenario.name,
    payload: scenario.payload,
    key: scenario.idempotencyKey,
  })
  const answer = body as { result?: unknown; error?: Outcome }
  const outcome: Outcome = status === 200 ? { result: answer.result } : {
    code: answer.error?.code,
    details: answer.error?.details,
    message: answer.error?.message,
  }
  return { outcome, handled: http.calls.length }
}

describe("one operations table over the socket and over HTTP", () => {
  for (const scenario of SCENARIOS) {
    it(`answers ${scenario.title} the same over both`, async () => {
      const socket = await overSocket(scenario)
      const http = await overHttp(scenario)

      for (const { outcome, handled } of [socket, http]) {
        if ("result" in scenario.expected) {
          expect(outcome).toEqual({ result: scenario.expected.result })
        } else {
          expect(outcome.code).toBe(scenario.expected.code)
          expect(outcome.details).toEqual(scenario.expected.details)
        }
        expect(handled).toBe(scenario.handled ? 1 : 0)
      }
      expect(http.outcome.code).toBe(socket.outcome.code)
      expect(http.outcome.result).toEqual(socket.outcome.result)
      if (
        scenario.expected && "code" in scenario.expected && scenario.expected.code === "internal"
      ) {
        expect(socket.outcome.message).toBe("internal error")
        expect(http.outcome.message).toBe("internal error")
      }
    })
  }
})

describe("isBoundToUser", () => {
  it("accepts the id of the authenticated user, as text or as a number", () => {
    expect(isBoundToUser("7", 7)).toBe(true)
    expect(isBoundToUser("user-7", "user-7")).toBe(true)
  })

  it("refuses the id of another user", () => {
    expect(isBoundToUser("8", 7)).toBe(false)
    expect(isBoundToUser("user-8", "user-7")).toBe(false)
  })

  it("refuses a call that sent no id", () => {
    expect(isBoundToUser(null, 7)).toBe(false)
    expect(isBoundToUser(undefined, 7)).toBe(false)
    expect(isBoundToUser("", "")).toBe(false)
  })

  it("refuses an id that only looks like the user's number", () => {
    expect(isBoundToUser("07", 7)).toBe(false)
    expect(isBoundToUser("7.0", 7)).toBe(false)
    expect(isBoundToUser(" 7", 7)).toBe(false)
  })

  it("refuses an authenticated id that is not a safe integer", () => {
    expect(isBoundToUser("NaN", Number.NaN)).toBe(false)
    expect(isBoundToUser("1.5", 1.5)).toBe(false)
    expect(isBoundToUser("Infinity", Number.POSITIVE_INFINITY)).toBe(false)
  })

  it("refuses a claim longer than 128 characters even when it matches", () => {
    const long = "u".repeat(129)
    expect(isBoundToUser(long, long)).toBe(false)
    expect(isBoundToUser("u".repeat(128), "u".repeat(128))).toBe(true)
  })
})

describe("createCallHandler", () => {
  it("hands the operation the actor, the parsed payload, the key, a request id and the signal", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ payload: { text: "milk" }, key: "k1" })

    expect(status).toBe(200)
    expect(body).toEqual({ result: { created: { text: "milk" }, by: 7, key: "k1" } })
    expect(http.calls).toHaveLength(1)
    expect(http.calls[0].actor).toBe(ALICE)
    expect(http.calls[0].requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(http.calls[0].signal).toBeInstanceOf(AbortSignal)
  })

  it("does not pass a query the idempotency key its caller sent", async () => {
    const http = createHttp()

    await http.call({ name: "note.list", key: "k1" })

    expect(http.calls).toHaveLength(1)
    expect("idempotencyKey" in http.calls[0]).toBe(false)
  })

  it("answers as JSON that must not be cached or sniffed", async () => {
    const { response } = await createHttp().call({ name: "note.list" })

    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })

  it("accepts a JSON content type that carries a charset", async () => {
    const { status } = await createHttp().call({
      name: "note.list",
      contentType: "Application/JSON; charset=utf-8",
    })

    expect(status).toBe(200)
  })

  it("refuses a caller nobody is signed in as, even for an unknown name", async () => {
    const http = createHttp({ authenticate: () => null })

    const known = await http.call({ payload: {}, key: "k1" })
    const unknown = await http.call({ name: "note.nope" })

    expect(known.status).toBe(401)
    expect(known.body).toEqual(errorBody("unauthorized", "not signed in"))
    expect(unknown.body).toEqual(known.body)
    expect(http.calls).toHaveLength(0)
  })

  it("refuses a call that names another user than the session's", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ payload: {}, key: "k1", user: "8" })

    expect(status).toBe(401)
    expect(body).toEqual(errorBody("unauthorized", "the session belongs to another user"))
    expect(http.calls).toHaveLength(0)
  })

  it("refuses a call that does not say which user it is for", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ payload: {}, key: "k1", user: null })

    expect(status).toBe(401)
    expect((body as { error: { code: string } }).error.code).toBe("unauthorized")
    expect(http.calls).toHaveLength(0)
  })

  it("does not read the body of a call it refuses", async () => {
    const { operations, calls } = createTable()
    const request = callRequest({ payload: { text: "milk" }, key: "k1", user: "8" })
    const handler = createCallHandler(operations, {
      basePath: "/api/call",
      authenticate: () => ALICE,
      userIdOf: (actor) => actor.userId,
    })

    const response = await handler(request)

    expect(response.status).toBe(401)
    expect(request.bodyUsed).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("answers internal, and reports the error, when authentication itself fails", async () => {
    const http = createHttp({
      authenticate: () => {
        throw new Error("redis at 10.0.0.5 is down")
      },
    })

    const { status, body, response } = await http.call({ payload: {}, key: "k1" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
    expect((http.errors[0] as Error).message).toContain("redis")
    expect(http.calls).toHaveLength(0)
  })

  it("refuses an unknown name", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ name: "note.nope" })

    expect(status).toBe(404)
    expect(body).toEqual(errorBody("not_found", "unknown operation"))
    expect(http.calls).toHaveLength(0)
  })

  it("refuses the names every object inherits", async () => {
    const http = createHttp()

    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const { status } = await http.call({ name, key: "k1" })
      expect([name, status]).toEqual([name, 404])
    }
    expect(http.errors).toHaveLength(0)
  })

  it("refuses an operation the table only inherits", async () => {
    const calls: unknown[] = []
    const inherited: Operations<Actor> = Object.create({
      "note.inherited": { kind: "query", handle: () => calls.push(1) },
    })
    const handler = createCallHandler(inherited, {
      basePath: "/api/call",
      authenticate: () => ALICE,
      userIdOf: (actor) => actor.userId,
    })

    const response = await handler(callRequest({ name: "note.inherited" }))

    expect(response.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it("refuses a path that is not one name under the base path", async () => {
    const http = createHttp()
    const paths = [
      "/api/call",
      "/api/call/",
      "/api/call/note.list/extra",
      "/api/callnote.list",
      "/other/note.list",
      "/api/cart/note.list",
      "/api/call/%E0%A4%A",
      `/api/call/${"n".repeat(129)}`,
    ]

    for (const path of paths) {
      const { status, body } = await http.call({ path })
      expect([path, status]).toEqual([path, 404])
      expect(body).toEqual(errorBody("not_found", "unknown operation"))
    }
    expect(http.calls).toHaveLength(0)
  })

  it("serves a base path given with a trailing slash", async () => {
    const http = createHttp({ basePath: "/api/call/" })

    expect((await http.call({ name: "note.list" })).status).toBe(200)
  })

  it("refuses a command without an idempotency key", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ payload: { text: "milk" } })

    expect(status).toBe(400)
    expect(body).toEqual(errorBody("bad_request", "a command needs an idempotency key"))
    expect(http.calls).toHaveLength(0)
  })

  it("refuses an idempotency key longer than 256 characters", async () => {
    const http = createHttp()

    const long = await http.call({ payload: {}, key: "k".repeat(257) })
    const longest = await http.call({ payload: {}, key: "k".repeat(256) })

    expect(long.status).toBe(400)
    expect(long.body).toEqual(errorBody("bad_request", "the idempotency key is too long"))
    expect(longest.status).toBe(200)
    expect(http.calls).toHaveLength(1)
  })

  it("refuses a body over the cap while it is still arriving", async () => {
    const http = createHttp({ maxBodyBytes: 32 })

    const { status, body } = await http.call({
      body: JSON.stringify({ text: "m".repeat(64) }),
      key: "k1",
    })

    expect(status).toBe(413)
    expect(body).toEqual(errorBody("bad_request", "the body is too large"))
    expect(http.calls).toHaveLength(0)
  })

  it("serves a body exactly at the cap", async () => {
    const text = JSON.stringify({ text: "m".repeat(20) })
    const http = createHttp({ maxBodyBytes: new TextEncoder().encode(text).byteLength })

    expect((await http.call({ body: text, key: "k1" })).status).toBe(200)
  })

  it("caps a body at 64 KiB by default", async () => {
    const http = createHttp()

    const { status } = await http.call({
      body: JSON.stringify("m".repeat(DEFAULT_MAX_CALL_BYTES)),
      key: "k1",
    })

    expect(DEFAULT_MAX_CALL_BYTES).toBe(65_536)
    expect(status).toBe(413)
    expect(http.calls).toHaveLength(0)
  })

  it("refuses a body that is not declared as JSON", async () => {
    const http = createHttp()

    for (
      const contentType of [
        null,
        "text/plain",
        "application/x-www-form-urlencoded",
        "application/jsonp",
      ]
    ) {
      const { status, body } = await http.call({ body: `{"text":"milk"}`, key: "k1", contentType })
      expect([contentType, status]).toEqual([contentType, 415])
      expect(body).toEqual(errorBody("bad_request", "the body must be application/json"))
    }
    expect(http.calls).toHaveLength(0)
  })

  it("refuses a body that is not valid JSON", async () => {
    const http = createHttp()

    for (const text of [`{"text":`, "milk", "[".repeat(20_000)]) {
      const { status, body } = await http.call({ body: text, key: "k1" })
      expect(status).toBe(400)
      expect(body).toEqual(errorBody("bad_request", "the body is not valid JSON"))
    }
    expect(http.calls).toHaveLength(0)
    expect(http.errors).toHaveLength(0)
  })

  it("refuses a body that stops arriving", async () => {
    const http = createHttp({ bodyTimeoutMs: 5 })
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`{"text":`))
      },
    })

    const { status, body } = await http.call({ body: stalled, key: "k1" })

    expect(status).toBe(408)
    expect(body).toEqual(errorBody("bad_request", "the body took too long to arrive"))
    expect(http.calls).toHaveLength(0)
  })

  it("refuses a method that is not POST", async () => {
    const http = createHttp()

    for (const method of ["GET", "PUT", "DELETE"]) {
      const { status, body, response } = await http.call({ name: "note.list", method })
      expect(status).toBe(405)
      expect(response.headers.get("Allow")).toBe("POST")
      expect(body).toEqual(errorBody("bad_request", "a call is a POST"))
    }
    expect(http.calls).toHaveLength(0)
  })

  it("answers a typed error with its code, message and details", async () => {
    const { status, body } = await createHttp().call({ name: "note.stale", key: "k1" })

    expect(status).toBe(409)
    expect(body).toEqual(errorBody("conflict", "stale version", { currentVersion: 3 }))
  })

  it("answers each error code with its own status", async () => {
    const statuses: Record<string, number> = {}
    for (const code of REALTIME_ERROR_CODES) {
      const handler = createCallHandler<Actor>({
        "note.fail": {
          kind: "query",
          handle: () => {
            throw new RealtimeRequestError(code, "refused")
          },
        },
      }, { basePath: "/api/call", authenticate: () => ALICE, userIdOf: (actor) => actor.userId })
      statuses[code] = (await handler(callRequest({ name: "note.fail" }))).status
    }

    expect(statuses).toEqual({
      bad_request: 400,
      unauthorized: 401,
      forbidden: 403,
      not_found: 404,
      conflict: 409,
      rate_limited: 429,
      internal: 500,
      timeout: 504,
    })
    expect(statuses).toEqual({ ...CALL_ERROR_STATUS })
  })

  it("answers an app error through the mapper", async () => {
    const { status, body } = await createHttp().call({ name: "note.locked" })

    expect(status).toBe(403)
    expect(body).toEqual(errorBody("forbidden", "the note is locked"))
  })

  it("answers an unexpected exception as internal without leaking its text", async () => {
    const http = createHttp()

    const { status, body, response } = await http.call({ name: "note.crash" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
    expect(JSON.stringify([...response.headers])).not.toContain("hunter2")
    expect((http.errors[0] as Error).message).toContain("hunter2")
  })

  it("keeps the message and details of an error that names itself internal on the server", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ name: "note.secret" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
    expect(http.errors).toHaveLength(1)
  })

  it("answers internal when the error mapper itself throws", async () => {
    const http = createHttp({
      mapError: () => {
        throw new Error("mapper bug: hunter2")
      },
    })

    const { status, body } = await http.call({ name: "note.locked" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
    expect(http.errors[0]).toBeInstanceOf(AppError)
  })

  it("answers internal when a result cannot be encoded", async () => {
    const http = createHttp()

    const { status, body } = await http.call({ name: "note.count" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
    expect(http.errors).toHaveLength(1)
  })

  it("answers internal when an error's details cannot be encoded", async () => {
    const handler = createCallHandler<Actor>({
      "note.fail": {
        kind: "query",
        handle: () => {
          throw new RealtimeRequestError("conflict", "stale", { version: 3n })
        },
      },
    }, { basePath: "/api/call", authenticate: () => ALICE, userIdOf: (actor) => actor.userId })

    const response = await handler(callRequest({ name: "note.fail" }))

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual(errorBody("internal", "internal error"))
  })

  it("still answers when the error hook throws", async () => {
    const http = createHttp({
      onError: () => {
        throw new Error("logger is down")
      },
    })

    const { status, body } = await http.call({ name: "note.crash" })

    expect(status).toBe(500)
    expect(body).toEqual(errorBody("internal", "internal error"))
  })

  it("tells the error hook which operation and request failed", async () => {
    const seen: unknown[] = []
    const http = createHttp({ onError: (_error, context) => seen.push(context) })

    await http.call({ name: "note.crash" })

    expect(seen).toEqual([{ name: "note.crash", requestId: http.calls[0].requestId }])
  })

  it("refuses an entry of the table that is not an operation", async () => {
    const broken = {
      "note.broken": { kind: "mutation", handle: () => 1 },
    } as unknown as Operations<
      Actor
    >
    const handler = createCallHandler(broken, {
      basePath: "/api/call",
      authenticate: () => ALICE,
      userIdOf: (actor) => actor.userId,
    })

    const response = await handler(callRequest({ name: "note.broken", key: "k1" }))

    expect(response.status).toBe(404)
  })

  it("rejects a cap or a base path it could not enforce when it is created", () => {
    const create = (overrides: Partial<CallHandlerOptions<Actor>>) => () => createHttp(overrides)

    expect(create({ maxBodyBytes: Number.NaN })).toThrow(RangeError)
    expect(create({ maxBodyBytes: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(create({ maxBodyBytes: 0 })).toThrow(RangeError)
    expect(create({ basePath: "api/call" })).toThrow(RangeError)
  })
})

describe("createOperationDispatcher", () => {
  const command = { kind: "client.command", name: "note.create", payload: {}, idempotencyKey: "k1" }

  it("hands the operation the actor, the frame's id and its key", async () => {
    const socket = createSocket()

    const frame = await socket.send(command)

    expect(frame.kind).toBe("server.result")
    expect(socket.calls).toHaveLength(1)
    expect(socket.calls[0].actor).toBe(ALICE)
    expect(socket.calls[0].requestId).toBe(frame.requestId)
    expect(socket.calls[0].idempotencyKey).toBe("k1")
  })

  it("refuses a request whose session may no longer act", async () => {
    const socket = createSocket(() => null)

    const frame = await socket.send(command)

    expect(frame).toMatchObject({ kind: "server.error", code: "unauthorized" })
    expect(socket.calls).toHaveLength(0)
  })

  it("refuses a request whose session now belongs to another user than the socket's", async () => {
    const socket = createSocket(() => ({ userId: 8 }))

    const frame = await socket.send(command)

    expect(frame).toMatchObject({
      kind: "server.error",
      code: "unauthorized",
      message: "the session belongs to another user",
    })
    expect(socket.calls).toHaveLength(0)
  })

  it("refuses a query frame that names a command", async () => {
    const socket = createSocket()

    const frame = await socket.send({ kind: "client.query", name: "note.create", payload: {} })

    expect(frame).toMatchObject({ kind: "server.error", code: "not_found" })
    expect(socket.calls).toHaveLength(0)
  })

  it("reports an unexpected exception to the registry instead of the client", async () => {
    const socket = createSocket()

    const frame = await socket.send({ kind: "client.query", name: "note.crash" })

    expect(frame).toEqual({
      kind: "server.error",
      requestId: frame.requestId,
      code: "internal",
      message: "internal error",
    })
    expect((socket.errors[0] as Error).message).toContain("hunter2")
  })
})
