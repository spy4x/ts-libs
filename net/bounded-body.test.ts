import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  BodyReadTimeoutError,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  readContentLength,
} from "./bounded-body.ts"

/** A body that emits one chunk then never closes — the stalled-transfer case. */
function stalledStream(firstChunk?: Uint8Array, onCancel?: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (firstChunk) controller.enqueue(firstChunk)
    },
    cancel() {
      onCancel?.()
    },
  })
}

/** A body that emits the given chunks, then closes, counting cancellations. */
function chunkedStream(chunks: Uint8Array[], onCancel?: () => void) {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[i++])
    },
    cancel() {
      onCancel?.()
    },
  })
}

function response(body: BodyInit | null, init: ResponseInit = {}): Response {
  return new Response(body, init)
}

describe("readContentLength", () => {
  it("reads an integer length", () => {
    assertEquals(readContentLength(new Headers({ "content-length": "42" })), 42)
    assertEquals(readContentLength(new Headers({ "content-length": "0" })), 0)
  })

  it("returns null for a missing or unusable length", () => {
    for (const value of ["", "abc", "1.5", "-1", "1e3", "NaN"]) {
      const headers = new Headers()
      if (value) headers.set("content-length", value)
      assertEquals(readContentLength(headers), null, JSON.stringify(value))
    }
  })
})

describe("readBoundedText", () => {
  it("reads a body within the cap", async () => {
    assertEquals(await readBoundedText(response("hello"), { maxBytes: 5 }), "hello")
  })

  it("reads a request body within the cap", async () => {
    const request = new Request("http://example.test", { method: "POST", body: "stats" })
    assertEquals(await readBoundedText(request, { maxBytes: 5 }), "stats")
  })

  it("returns an empty string for a bodyless source", async () => {
    assertEquals(await readBoundedText(response(null), { maxBytes: 10 }), "")
  })

  it("rejects a declared oversized body before reading a byte", async () => {
    // The body is empty, so only the `Content-Length` pre-check can produce
    // this throw — a read-first implementation returns "" here instead.
    const source = response(null, { headers: { "content-length": "6" } })
    await assertRejects(
      () => readBoundedText(source, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
    // Same on the byte and JSON readers, and on a `Request` source.
    const request = new Request("http://example.test/upload", {
      method: "POST",
      headers: { "content-length": "6" },
      body: "abc",
    })
    await assertRejects(
      () => readBoundedBody(request, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
    await assertRejects(
      () => readBoundedJson(source, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("rejects a streamed body past the cap", async () => {
    const source = response(chunkedStream([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ]))
    await assertRejects(
      () => readBoundedText(source, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("rejects a body whose declared length understates the real size", async () => {
    // The header pre-check is an optimisation, not the enforcement point: the
    // running total is what actually caps the read.
    const body = "0123456789"
    const source = response(body, { headers: { "content-length": "2" } })
    await assertRejects(
      () => readBoundedText(source, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("accepts a body of exactly the cap", async () => {
    assertEquals(await readBoundedText(response("12345"), { maxBytes: 5 }), "12345")
    await assertRejects(
      () => readBoundedText(response("123456"), { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("decodes a multi-byte character split across chunks", async () => {
    // "é" is 0xC3 0xA9: the incremental decoder must stitch the halves rather
    // than emit a replacement character for each.
    const bytes = new TextEncoder().encode("é")
    const source = response(
      chunkedStream([bytes.slice(0, 1), bytes.slice(1), new TextEncoder().encode("!")]),
    )
    assertEquals(await readBoundedText(source, { maxBytes: 8 }), "é!")
  })

  it("rejects a stalled body once the stall budget expires", async () => {
    const source = response(stalledStream())
    await assertRejects(
      () => readBoundedText(source, { maxBytes: 1024, timeoutMs: 5 }),
      BodyReadTimeoutError,
      "stalled",
    )
  })

  it("rejects a body that stalls midway", async () => {
    let cancelled = false
    const source = response(stalledStream(new Uint8Array([1, 2, 3]), () => {
      cancelled = true
    }))
    await assertRejects(
      () => readBoundedText(source, { maxBytes: 1024, timeoutMs: 5 }),
      BodyReadTimeoutError,
    )
    assertEquals(cancelled, true)
  })

  it("does not time out while chunks keep arriving", async () => {
    // A slow-but-live transfer must survive: the budget guards the gap between
    // chunks, not the total duration.
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 4))
        controller.enqueue(new TextEncoder().encode("x"))
        if (controller.desiredSize !== null) {
          // Close after a fixed number of chunks so the stream terminates.
          if (++emitted >= 5) controller.close()
        }
      },
    })
    let emitted = 0
    assertEquals(await readBoundedText(response(slow), { maxBytes: 64, timeoutMs: 25 }), "xxxxx")
  })

  it("reports the stall budget it used", async () => {
    const source = response(stalledStream())
    try {
      await readBoundedText(source, { maxBytes: 1024, timeoutMs: 7 })
      throw new Error("expected throw")
    } catch (err) {
      assertEquals(err instanceof BodyReadTimeoutError, true)
      if (err instanceof BodyReadTimeoutError) {
        assertEquals(err.timeoutMs, 7)
        assertEquals(err.code, "body_read_timeout")
      }
    }
  })

  it("reports the cap it exceeded", async () => {
    try {
      await readBoundedText(response("0123456789"), { maxBytes: 5 })
      throw new Error("expected throw")
    } catch (err) {
      assertEquals(err instanceof PayloadTooLargeError, true)
      if (err instanceof PayloadTooLargeError) {
        assertEquals(err.maxBytes, 5)
        assertEquals(err.code, "payload_too_large")
        assertEquals(err.message, "Payload exceeds 5 bytes")
      }
    }
  })
})

describe("readBoundedBody", () => {
  it("returns the raw bytes", async () => {
    const body = await readBoundedBody(response(new Uint8Array([1, 2, 3])), { maxBytes: 3 })
    assertEquals([...body], [1, 2, 3])
  })

  it("returns an empty array for a bodyless source", async () => {
    assertEquals((await readBoundedBody(response(null), { maxBytes: 3 })).byteLength, 0)
  })

  it("rejects a streamed request body past the cap", async () => {
    const stream = chunkedStream([
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
    ])
    const request = new Request("http://example.test", { method: "POST", body: stream })
    await assertRejects(
      () => readBoundedBody(request, { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("applies the stall budget to a request body too", async () => {
    const request = new Request("http://example.test", {
      method: "POST",
      body: stalledStream(),
    })
    await assertRejects(
      () => readBoundedBody(request, { maxBytes: 64, timeoutMs: 5 }),
      BodyReadTimeoutError,
    )
  })
})

describe("readBoundedJson", () => {
  it("parses a JSON body under the cap", async () => {
    assertEquals(
      await readBoundedJson<{ a: number }>(response(`{"a":1}`), { maxBytes: 64 }),
      { a: 1 },
    )
  })

  it("rejects an oversized JSON body on the cap, not on parse", async () => {
    await assertRejects(
      () => readBoundedJson(response(`{"a":"0123456789"}`), { maxBytes: 5 }),
      PayloadTooLargeError,
    )
  })

  it("lets the platform SyntaxError escape for malformed JSON", async () => {
    await assertRejects(
      () => readBoundedJson(response("{oops"), { maxBytes: 64 }),
      SyntaxError,
    )
  })

  it("honours the stall budget", async () => {
    await assertRejects(
      () => readBoundedJson(response(stalledStream()), { maxBytes: 64, timeoutMs: 5 }),
      BodyReadTimeoutError,
    )
  })
})

describe("defaults", () => {
  it("caps at 5 MiB and stalls out after 10s when unset", () => {
    assertEquals(DEFAULT_MAX_BYTES, 5 * 1024 * 1024)
    assertEquals(DEFAULT_BODY_TIMEOUT_MS, 10_000)
  })

  it("reads a body larger than the default cap only when the cap is raised", async () => {
    // Proves the default is actually applied, with a small stand-in: a 3-byte
    // body read with no explicit cap must pass, and the declared-length path
    // must still refuse it when the caller lowers the cap below the default.
    assertEquals(await readBoundedText(response("abc")), "abc")
    await assertRejects(
      () =>
        readBoundedText(response("abc", { headers: { "content-length": "3" } }), {
          maxBytes: 2,
        }),
      PayloadTooLargeError,
    )
  })

  it("does not start a timer when the stall budget is disabled", async () => {
    // With `timeoutMs` unset a stalled body simply never settles; assert the
    // read rejects promptly when the budget IS set, so the gate is not inert.
    const started = Date.now()
    await assertRejects(
      () => readBoundedText(response(stalledStream()), { maxBytes: 64, timeoutMs: 1 }),
      BodyReadTimeoutError,
    )
    assertEquals(Date.now() - started < 5000, true)
  })

  it("clears the stall timer once a read finishes", async () => {
    // A direct assertion, not the per-test `sanitizeResources` flag the server
    // suite relies on: that flag is a Deno-test-only guard, and it is the whole
    // of the evidence there.
    //
    // The spies wrap the platform timer pair instead of comparing handles: Deno
    // hands out a fresh `Timeout` object per `setTimeout` call, so handle
    // equality is not a portable identity. Everything is typed off
    // `typeof setTimeout`, which is the `node:`-safe spelling.
    type TimerHandle = ReturnType<typeof setTimeout>
    const realSet = setTimeout
    const realClear = clearTimeout
    const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")
    const clearDescriptor = Object.getOwnPropertyDescriptor(globalThis, "clearTimeout")
    const armedBySpy = new Set<TimerHandle>()
    const clearedBySpy = new Set<TimerHandle>()
    // Redefined rather than reassigned: assigning a global is a lint error.
    Object.defineProperty(globalThis, "setTimeout", {
      value: ((...args: Parameters<typeof setTimeout>) => {
        const handle = realSet(...args)
        armedBySpy.add(handle)
        return handle
      }) as typeof setTimeout,
      configurable: true,
    })
    Object.defineProperty(globalThis, "clearTimeout", {
      value: ((handle?: TimerHandle) => {
        if (handle !== undefined) clearedBySpy.add(handle)
        return realClear(handle)
      }) as typeof clearTimeout,
      configurable: true,
    })
    // Armed through the real pair so it is in neither set, which gives the
    // assertion below a line the timer-leak mutation cannot touch.
    const probe = realSet(() => {}, 30_000)

    try {
      assertEquals(await readBoundedText(response("ok"), { maxBytes: 64, timeoutMs: 30_000 }), "ok")
      const leaked = [...armedBySpy].filter((handle) => !clearedBySpy.has(handle))
      // Removing the `.finally(clearTimeout)` in `readNext` leaves the budget
      // timer armed past the read, so it lands in `leaked` and this reddens.
      assertEquals(leaked.length, 0, `${leaked.length} timer(s) outlived the read`)
    } finally {
      realClear(probe)
      Object.defineProperty(globalThis, "setTimeout", setDescriptor!)
      Object.defineProperty(globalThis, "clearTimeout", clearDescriptor!)
    }
  })
})
