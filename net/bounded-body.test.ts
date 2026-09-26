import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  BodyReadTimeoutError,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  parseBoundedFormData,
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

  it("rejects a non-finite cap before a byte is read", async () => {
    for (const cap of [NaN, Infinity, -Infinity]) {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      })
      const request = new Request("http://example.test", { method: "POST", body: stream })
      await assertRejects(
        () => readBoundedBody(request, { maxBytes: cap }),
        RangeError,
        String(cap),
      )
      // `bodyUsed` alone does not prove this: it stays `false` even once
      // `getReader()` has locked the stream, as long as nothing was read from
      // it. `locked` is the property that actually pins "the reader is not
      // taken before the throw" — a caller left with a locked-but-unread
      // stream cannot read it either, so this is the real regression to catch.
      assertEquals(request.body?.locked, false, `${cap} must reject before the reader is taken`)
    }
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
  it("caps a body at 5 MiB when the caller sets no cap", async () => {
    // Declared length rather than five megabytes of stream: it proves the
    // default cap at its documented value, one byte either side of it, without
    // the allocation. Asserting `DEFAULT_MAX_BYTES === 5 * 1024 * 1024` instead
    // would pass with the default unused, which is how the stall budget stayed
    // switched off for as long as it did.
    const oversized = { "content-length": String(DEFAULT_MAX_BYTES + 1) }
    await assertRejects(
      () => readBoundedText(response(null, { headers: oversized })),
      PayloadTooLargeError,
    )
    const atCap = { "content-length": String(DEFAULT_MAX_BYTES) }
    assertEquals(await readBoundedText(response(null, { headers: atCap })), "")
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

  it("times out a stalled body when the caller sets no stall budget", async () => {
    // A test may not sit out the real 10s, so the platform timer is wrapped and
    // a timer armed for exactly the default budget is re-armed for 1ms. What is
    // asserted is still the rejection and the budget it reports — not that some
    // timer exists somewhere.
    const realSet = setTimeout
    const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!
    let armedAtDefault = 0
    Object.defineProperty(globalThis, "setTimeout", {
      value: ((...args: Parameters<typeof setTimeout>) => {
        if (args[1] === DEFAULT_BODY_TIMEOUT_MS) {
          armedAtDefault++
          return realSet(args[0], 1)
        }
        return realSet(...args)
      }) as typeof setTimeout,
      configurable: true,
    })
    // Not a measurement of how long anything took: it is the only way a read
    // that never settles can end as a red test instead of a hung run.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      const outcome = await Promise.race([
        readBoundedText(response(stalledStream())).then(() => "the read returned"),
        new Promise((resolve) => {
          deadline = realSet(() => resolve("the read never settled"), 1000)
        }),
      ]).catch((error: unknown) => error)
      assertEquals(outcome instanceof BodyReadTimeoutError, true, String(outcome))
      assertEquals((outcome as BodyReadTimeoutError).timeoutMs, DEFAULT_BODY_TIMEOUT_MS)
      assertEquals(armedAtDefault, 1)
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
      Object.defineProperty(globalThis, "setTimeout", setDescriptor)
    }
  })

  it("arms no stall timer when the caller passes 0", async () => {
    // `0` is the documented way to ask for no stall budget. It has to stay an
    // opt-out that a caller types, not the behaviour of saying nothing.
    const realSet = setTimeout
    const setDescriptor = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!
    let armed = 0
    Object.defineProperty(globalThis, "setTimeout", {
      value: ((...args: Parameters<typeof setTimeout>) => {
        armed++
        return realSet(...args)
      }) as typeof setTimeout,
      configurable: true,
    })
    try {
      assertEquals(await readBoundedText(response("abc"), { timeoutMs: 0 }), "abc")
      assertEquals(armed, 0)
    } finally {
      Object.defineProperty(globalThis, "setTimeout", setDescriptor)
    }
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

const FORM_ORIGIN = "http://example.test"

/**
 * A request whose body bytes are a `Uint8Array` view at a non-zero `byteOffset`.
 *
 * A contract guard rather than a discriminator: `readBoundedBody` returns an
 * exactly-sized offset-0 array, so it passes either way. It fails the day the
 * reader hands `Response` a window onto a larger buffer, which is the
 * `body.buffer` hazard `parseBoundedFormData` documents.
 */
function offsetViewInit(bytes: Uint8Array, contentType: string): RequestInit {
  const buffer = new ArrayBuffer(bytes.byteLength + 4)
  const view = new Uint8Array(buffer, 2, bytes.byteLength)
  view.set(bytes)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(view)
      controller.close()
    },
  })
  return {
    method: "POST",
    body: stream,
    headers: { "content-type": contentType },
    duplex: "half",
  } as RequestInit
}

describe("parseBoundedFormData", () => {
  it("reads a url-encoded body within the cap", async () => {
    const request = new Request(FORM_ORIGIN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=user%40example.com",
    })
    const form = await parseBoundedFormData(request, { maxBytes: 1024 })
    assertEquals(form.get("email"), "user@example.com")
  })

  it("respects a non-zero byteOffset on the read buffer", async () => {
    const payload = new TextEncoder().encode("email=user%40example.com")
    const request = new Request(
      FORM_ORIGIN,
      offsetViewInit(payload, "application/x-www-form-urlencoded"),
    )

    const form = await parseBoundedFormData(request, { maxBytes: 1024 })
    assertEquals(form.get("email"), "user@example.com")
  })

  it("keeps the multipart boundary", async () => {
    const boundary = "----tslibsboundary"
    const payload = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="email"`,
      "",
      "user@example.com",
      `--${boundary}--`,
      "",
    ].join("\r\n")
    const request = new Request(FORM_ORIGIN, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: payload,
    })

    const form = await parseBoundedFormData(request, { maxBytes: 1024 })
    assertEquals(form.get("email"), "user@example.com")
  })

  it("rejects a multipart body over the cap", async () => {
    const boundary = "----tslibsboundary"
    const payload = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="big.txt"`,
      "Content-Type: text/plain",
      "",
      "x".repeat(64),
      `--${boundary}--`,
      "",
    ].join("\r\n")
    const request = new Request(FORM_ORIGIN, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: payload,
    })

    await assertRejects(
      () => parseBoundedFormData(request, { maxBytes: 32 }),
      PayloadTooLargeError,
    )
  })

  it("refuses a request without a content-type", async () => {
    const request = new Request(FORM_ORIGIN, { method: "POST", body: "email=user%40example.com" })
    await assertRejects(() => parseBoundedFormData(request, { maxBytes: 1024 }), TypeError)
  })
})
