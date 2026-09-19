/**
 * Fixtures shared by the `ai/` suites.
 *
 * No test in this package may reach the network, sleep on the wall clock or read
 * a real credential, so every seam the client exposes is faked here: the
 * fetcher, the timer and the logger. Keys are obviously fake and base URLs use
 * the RFC 2606 example domain.
 */

import type { Logger, Timer } from "./chat.ts"

/** Obvious fake key. Never a real one, in any fixture. */
export const FAKE_API_KEY: string = "sk-test-not-a-real-key"

/** RFC 2606 base URL. No request in this suite leaves the process. */
export const FAKE_BASE_URL: string = "https://api.example.com/v1"

/** What a recorded call looks like to an assertion. */
export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
  /** Whether the request carried an `AbortSignal`. */
  signalled: boolean
}

/** Queue of replies, plus the recorded requests. */
export interface FakeFetcher {
  fetcher: typeof fetch
  requests: RecordedRequest[]
  /** Index of the next queued reply. */
  calls: () => number
  /** Replies still unclaimed. */
  remaining: () => number
  /**
   * Resolves once the fetcher has been called `count` times.
   *
   * A test that has to act *while* a request is in flight needs this: awaiting a
   * bare microtask instead would be a race against the client's own async
   * plumbing, and `{ hangs: true }` gives the reply that waits to be aborted.
   */
  whenCalled: (count?: number) => Promise<void>
}

/** One queued reply: a status, a JSON body, or a transport failure. */
export type FakeReply =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { status?: number; text: string; headers?: Record<string, string> }
  | { networkError: Error }
  | { hangs: true }

/**
 * A `fetch` that replays queued replies and records what it was called with.
 *
 * Records only the request, never the response: an assertion about what the
 * client sent is the point, and a fixture that also captured the reply would
 * tempt a test into comparing whole payloads.
 */
export function createFakeFetcher(replies: FakeReply[]): FakeFetcher {
  const requests: RecordedRequest[] = []
  let index = 0
  let notify: (() => void) | undefined
  let reached = 0

  const awaitCalls = (target: number) => {
    if (requests.length >= target) return Promise.resolve()
    return new Promise<void>((resolve) => {
      reached = target
      notify = resolve
    })
  }

  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value
    }
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : {},
      signalled: init?.signal !== undefined && init.signal !== null,
    })

    if (notify && requests.length >= reached) {
      const resolve = notify
      notify = undefined
      resolve()
    }
    const reply = replies[index++]
    if (!reply) throw new Error(`fake fetcher ran out of replies after ${index - 1} call(s)`)
    if ("networkError" in reply) return Promise.reject(reply.networkError)
    if ("hangs" in reply) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    }
    if ("text" in reply) {
      return Promise.resolve(
        new Response(reply.text, { status: reply.status ?? 200, headers: reply.headers }),
      )
    }
    return Promise.resolve(
      Response.json(reply.body, { status: reply.status ?? 200, headers: reply.headers }),
    )
  }) as typeof fetch

  return {
    fetcher,
    requests,
    calls: () => requests.length,
    remaining: () => replies.length - index,
    whenCalled: (count = 1) => awaitCalls(count),
  }
}

/**
 * A promise whose settlement the test controls.
 *
 * It exists because the client races its request against the timer's wait: a
 * fake that resolved instantly would report every request as timed out, and a
 * fake whose settlement the client could not observe could not be raced at all.
 */
interface Controlled {
  promise: Promise<void>
  settle: () => void
  fail: (reason: unknown) => void
}

export function controlled(): Controlled {
  let settle: () => void = () => {}
  let fail: (reason: unknown) => void = () => {}
  const promise = new Promise<void>((ok, no) => {
    settle = ok
    fail = no
  })
  void promise.catch(() => {})
  return { promise, settle, fail }
}

/** The opaque token a fake wait resolves to, matched by identity in `cancel`. */
interface FakeWait extends PromiseLike<void> {
  ms: number
  kind: "deadline" | "backoff"
  settle: () => void
}

/**
 * A timer whose clock only moves when a test moves it.
 *
 * A **backoff** wait resolves on a microtask: the client awaits those directly,
 * so the duration never reaches the wall clock. A **deadline** wait is raced
 * against a request, so it stays outstanding until a test calls `advance` — a
 * fake that elapsed instantly would report every request as timed out. Releasing
 * a deadline with `cancel` is what the client does when the request wins.
 *
 * `waits` records every wait the client asked for, in order, so an assertion
 * reads the same list whether a wait was released, elapsed, or is outstanding.
 */
export interface FakeTimer extends Timer {
  /** Sum of every delay the client asked to wait for. */
  slept: () => number
  /** Every wait the client asked for, in order, as millisecond delays. */
  delays: () => number[]
  /** Only the retry backoff waits, which are the time the call chose to spend. */
  backoffs: () => number[]
  /** Waits the client released before elapsing. */
  cancelled: Array<{ ms: number; kind: "deadline" | "backoff" }>
  /** Clock as the client sees it. */
  elapsed: () => number
  /** Let every outstanding deadline elapse, as if the clock had run out. */
  advance: (ms: number) => void
}

export function createFakeTimer(): FakeTimer {
  let clock = 1_000
  const waits: FakeWait[] = []
  const cancelled: Array<{ ms: number; kind: "deadline" | "backoff" }> = []
  const live = new Map<FakeWait, Controlled>()

  return {
    cancelled,
    cancel: (token) => {
      // Matched by identity, so two attempts racing cannot release each other's
      // deadline. Releasing settles the wait, which is exactly what a cancelled
      // deadline does to a request that is awaiting it.
      const wait = token as FakeWait
      console.log("DBG cancel", wait?.ms, "live", live.size, "kind", wait?.kind)
      const control = live.get(wait)
      if (!control) return
      live.delete(wait)
      cancelled.push({ ms: wait.ms, kind: wait.kind })
      control.fail(new Error(`wait of ${wait.ms}ms was released`))
    },
    now: () => clock,
    sleep: (ms, signal, kind) => {
      if (signal?.aborted) return Promise.reject(signal.reason)
      const control = controlled()
      // The wait carries the token identity *and* is the promise the client
      // awaits, so a release can be matched by the same object the client holds.
      const wait = Object.assign(control.promise, {
        ms,
        kind: kind ?? "backoff",
        settle: () => control.settle(),
      }) as unknown as FakeWait
      waits.push(wait)
      if (wait.kind === "deadline") {
        live.set(wait, control)
      } else {
        // A backoff is awaited directly, so it can resolve at once.
        queueMicrotask(() => control.settle())
      }
      return Promise.resolve(wait as never)
    },
    advance: (ms) => {
      clock += ms
      for (const [wait, control] of [...live]) {
        live.delete(wait)
        control.settle()
      }
    },
    slept: () => waits.reduce((total, wait) => total + wait.ms, 0),
    delays: () => waits.map((wait) => wait.ms),
    backoffs: () => waits.filter((wait) => wait.kind === "backoff").map((wait) => wait.ms),
    elapsed: () => clock - 1_000,
  }
}

/** One captured log line. */
export interface LogLine {
  message: string
  fields: Record<string, unknown>
}

/** Logger that records instead of writing, so a leak test can inspect it. */
export function createRecordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  return {
    logger: {
      warn: (message, fields) => {
        lines.push({ message, fields: fields ?? {} })
      },
    },
    lines,
  }
}

/** A minimal well-formed completion body. */
export function completionBody(
  content: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    model: "fake-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    ...extra,
  }
}

/**
 * Fields an error *surfaces* to a caller: its own enumerable properties, plus
 * `name` and `message`.
 *
 * `stack` is deliberately excluded — it exists on any `Error` and is not part of
 * what this package hands back. A test asserts separately that nothing in here
 * reads like a stack frame, a file path or a module name, and that the JSON
 * serialisation of the error (the shape a route would put on the wire) holds no
 * credential either.
 */
export function surfacedStrings(value: unknown, seen: unknown[] = []): string[] {
  if (typeof value === "string") return [value]
  if (typeof value !== "object" || value === null) return []
  if (seen.includes(value)) return []
  seen.push(value)

  const found: string[] = []
  if (value instanceof Error) found.push(value.name, value.message)
  for (const entry of Object.getOwnPropertyNames(value)) {
    if (entry === "stack") continue
    found.push(...surfacedStrings((value as Record<string, unknown>)[entry], seen))
  }
  return found
}

/**
 * Frame-shaped text: what a stack trace's frames look like, whichever way the
 * runtime formatted them.
 *
 * `at fn (path:line:col)`, `at path:line:col`, and a bare `file.ts:12:3` all
 * match, so a message that had a stack appended, or a path quoted into it, is
 * caught either way.
 */
const FRAME_PATTERN = /(?:^|\s)at\s+\S|\.[cm]?tsx?:\d+:\d+/

/** Whether a string carries stack-frame text or a source-file path. */
export function hasFrameText(value: string): boolean {
  return FRAME_PATTERN.test(value)
}

/**
 * Everything a route could put on the wire for an error, as one string.
 *
 * `Object.getOwnPropertyNames` alone is not enough: `message` on an `Error` is
 * not enumerable, so a mutation that appends a stack to the message would slip
 * past a payload built from enumerable keys only. `stack` is still excluded —
 * it is the runtime's own addition and this package never copies it — so the
 * assertion stays about what the library surfaces.
 */
export function serialized(error: unknown): string {
  const record: Record<string, unknown> = {}
  for (const entry of Object.getOwnPropertyNames(error)) {
    if (entry === "stack") continue
    record[entry] = (error as Record<string, unknown>)[entry]
  }
  if (error instanceof Error) {
    record.name = error.name
    record.message = error.message
  }
  return JSON.stringify(record)
}
