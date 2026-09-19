import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
import {
  BodyReadTimeoutError as NetBodyReadTimeoutError,
  PayloadTooLargeError as NetPayloadTooLargeError,
} from "@ts-libs/net/bounded-body"
import {
  type BoundedBodyTimeout,
  parseBoundedFormData,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedText,
  readContentLength,
} from "./bounded-body.ts"

const ORIGIN = "http://example.test"

/** A `RequestInit` for a stream body: Deno requires the half-duplex flag. */
function streamInit(body: ReadableStream<Uint8Array>, headers?: HeadersInit): RequestInit {
  return { method: "POST", body, headers, duplex: "half" } as RequestInit
}

/**
 * A body whose bytes are a `Uint8Array` view at a non-zero `byteOffset`.
 *
 * A contract guard rather than a discriminator: both the pre-collapse reader and
 * the canonical one return an exactly-sized offset-0 array, so it passes either
 * way. It fails the day a reader hands `Response` a window onto a larger buffer,
 * which is the `body.buffer` hazard this path documents.
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
  return streamInit(stream, { "content-type": contentType })
}

/** A body that never produces a chunk, so only the stall budget can settle it. */
function stalledStream(onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {})
    },
    cancel() {
      onCancel?.()
    },
  })
}

/** A live body that emits one chunk per `gapMs`, so the wall clock is the test's. */
function dripStream(chunk: Uint8Array, count: number, gapMs: number): ReadableStream<Uint8Array> {
  let emitted = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (emitted >= count) {
        controller.close()
        return
      }
      emitted++
      await new Promise((resolve) => setTimeout(resolve, gapMs))
      controller.enqueue(chunk)
    },
  })
}

Deno.test("readBoundedBody returns a body one byte under the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "abcd" })
  assertEquals(await readBoundedBody(request, { maxBytes: 5 }), new TextEncoder().encode("abcd"))
})

Deno.test("readBoundedBody accepts a body exactly at the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "abcde" })
  const body = await readBoundedBody(request, { maxBytes: 5 })
  assertEquals(body.byteLength, 5)
  assertEquals(new TextDecoder().decode(body), "abcde")
})

Deno.test("readBoundedBody falls back to the default cap when none is given", async () => {
  // `maxBytes` is optional in the canonical module (5 MiB), and the server
  // surface is the canonical one — the old copy required it.
  const request = new Request(ORIGIN, { method: "POST", body: "abc" })
  assertEquals(await readBoundedBody(request), new TextEncoder().encode("abc"))
})

Deno.test("readBoundedBody returns an empty array for a bodyless request", async () => {
  const request = new Request(ORIGIN)
  assertEquals(await readBoundedBody(request, { maxBytes: 5 }), new Uint8Array())
})

Deno.test("readBoundedBody throws PayloadTooLargeError one byte over the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "abcdef" })
  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
})

Deno.test("readBoundedBody aborts a multi-chunk stream when the cap is crossed", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]))
      controller.enqueue(new Uint8Array([4, 5, 6]))
      controller.close()
    },
  })
  const request = new Request(ORIGIN, streamInit(body))
  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
})

Deno.test("readBoundedBody rejects an oversized declared content-length before reading", async () => {
  // The streamed body is itself inside the cap, so only the declared-length
  // pre-check can produce this throw: a read-first implementation answers with
  // the bytes instead. The lock assertion catches one that takes a reader before
  // consulting the header.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]))
      controller.close()
    },
  })
  const request = new Request(
    ORIGIN,
    streamInit(body, { "content-length": "999999" }),
  )

  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
  assertStrictEquals(
    request.body?.locked,
    false,
    "a reader was taken on a body that was never read",
  )
})

Deno.test("readBoundedBody leaves an unread rejected body to the server to drain", async () => {
  // The canonical reader rejects the declared length before taking a reader, so
  // there is no lock to release and nothing here to cancel: an unread request
  // body belongs to the server, which drains or cancels it once the handler has
  // answered. The pre-collapse copy cancelled it at this point instead.
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {})
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request(
    ORIGIN,
    streamInit(body, { "content-length": "999999" }),
  )

  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
  assertStrictEquals(cancelled, false, "the rejected body was cancelled despite never being read")
})

Deno.test("readBoundedBody rejects a stalled body once the stall budget expires", async () => {
  let cancelled = false
  const request = new Request(
    ORIGIN,
    streamInit(stalledStream(() => {
      cancelled = true
    })),
  )

  const rejection = await assertRejects(
    () => readBoundedBody(request, { maxBytes: 64, timeoutMs: 25 }),
    NetBodyReadTimeoutError,
    "Body read stalled for 25ms",
  )
  assertStrictEquals(rejection instanceof NetBodyReadTimeoutError, true)
  assertEquals(cancelled, true, "the stalled reader was left open after the stall budget expired")
})

Deno.test("readBoundedBody keeps a slow-but-live read alive past the budget", async () => {
  // 8 chunks x 15ms is ~120ms of wall clock against a 60ms budget: a single
  // overall deadline would abort at 60ms, so this pins the per-chunk stall
  // budget the canonical module documents and this package inherits.
  const request = new Request(ORIGIN, streamInit(dripStream(new Uint8Array([7]), 8, 15)))

  const body = await readBoundedBody(request, { maxBytes: 64, timeoutMs: 60 })
  assertEquals(body.byteLength, 8)
})

Deno.test({
  name: "readBoundedBody clears its stall timer when a live read finishes",
  // The assertion is the resources sanitizer: a timer armed for the stall budget
  // and never cleared is reported as a leaked timer. The pre-collapse copy armed
  // four and cleared one.
  sanitizeResources: true,
  fn: async () => {
    const request = new Request(ORIGIN, streamInit(dripStream(new Uint8Array([1]), 3, 1)))

    const body = await readBoundedBody(request, { maxBytes: 64, timeoutMs: 5000 })
    assertEquals([...body], [1, 1, 1])
  },
})

Deno.test("readBoundedBody cancels the reader when the cap is crossed mid-stream", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request(ORIGIN, streamInit(body))

  await assertRejects(() => readBoundedBody(request, { maxBytes: 4 }), PayloadTooLargeError)
  assertEquals(cancelled, true, "oversized reader was not cancelled")
})

Deno.test("readBoundedBody propagates the reader's error instead of reporting too-large", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("connection reset"))
    },
  })
  const request = new Request(ORIGIN, streamInit(body))

  const rejection = await assertRejects(() => readBoundedBody(request, { maxBytes: 1024 }))
  assertStrictEquals(rejection instanceof PayloadTooLargeError, false)
  assertStrictEquals(rejection instanceof Error, true)
  assertEquals((rejection as Error).message, "connection reset")
})

Deno.test("readBoundedBody reports the read error even when cancel rejects", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new TypeError("connection reset"))
    },
    cancel() {
      // `warthunder-stats` awaited this inside the catch block unguarded, so a
      // rejecting cancel replaced the error that actually explains the failure.
      return Promise.reject(new Error("cancel failed"))
    },
  })
  const request = new Request(ORIGIN, streamInit(body))

  const rejection = await assertRejects(() => readBoundedBody(request, { maxBytes: 1024 }))
  assertStrictEquals(rejection instanceof Error, true)
  assertEquals((rejection as Error).message, "connection reset")
})

Deno.test("readBoundedBody rejects a negative cap instead of reading", async () => {
  // The canonical reader has no `RangeError` branch: a non-positive cap simply
  // cannot be satisfied, so the read fails closed on the same error a real
  // over-cap body raises.
  const request = new Request(ORIGIN, { method: "POST", body: "abc" })
  await assertRejects(() => readBoundedBody(request, { maxBytes: -1 }), PayloadTooLargeError)
})

Deno.test("PayloadTooLargeError names itself and carries the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "abcdef" })
  const error = await assertRejects(
    () => readBoundedBody(request, { maxBytes: 5 }),
    PayloadTooLargeError,
  )
  assertEquals(error.name, "PayloadTooLargeError")
  assertEquals(error.maxBytes, 5)
  assertEquals(error.message, "Payload exceeds 5 bytes")
  assertStrictEquals(error instanceof Error, true)
})

Deno.test("readBoundedText decodes a body within the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "stats" })
  assertEquals(await readBoundedText(request, { maxBytes: 5 }), "stats")
})

Deno.test("readBoundedText throws PayloadTooLargeError over the cap", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "stats!" })
  await assertRejects(() => readBoundedText(request, { maxBytes: 5 }), PayloadTooLargeError)
})

Deno.test("readBoundedText decodes a multi-byte body at the cap", async () => {
  // "é" is two UTF-8 bytes, so "aé" is exactly at a 3-byte cap.
  const request = new Request(ORIGIN, { method: "POST", body: "aé" })
  assertEquals(await readBoundedText(request, { maxBytes: 3 }), "aé")
})

Deno.test("readContentLength reads a bare decimal length and ignores anything else", () => {
  assertEquals(readContentLength(new Headers({ "content-length": "42" })), 42)
  assertEquals(readContentLength(new Headers({ "content-length": "0" })), 0)
  assertEquals(readContentLength(new Headers()), null)
  // RFC 9110 §8.6 makes the field 1*DIGIT. `Number()` alone also accepts every
  // value below, which is the leniency the pre-collapse copy shipped: a cap
  // pre-check that reads `1e3` as 1000 can be argued out of rejecting a body.
  for (const value of ["1e3", "0x10", "+5", "12.5", "-1", "12abc"]) {
    assertEquals(readContentLength(new Headers({ "content-length": value })), null, value)
  }
})

Deno.test("parseBoundedFormData reads a url-encoded body within the cap", async () => {
  const request = new Request(ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "email=user%40example.com",
  })
  const form = await parseBoundedFormData(request, { maxBytes: 1024 })
  assertEquals(form.get("email"), "user@example.com")
})

Deno.test("parseBoundedFormData respects a non-zero byteOffset on the read buffer", async () => {
  const payload = new TextEncoder().encode("email=user%40example.com")
  const request = new Request(ORIGIN, offsetViewInit(payload, "application/x-www-form-urlencoded"))

  const form = await parseBoundedFormData(request, { maxBytes: 1024 })
  assertEquals(form.get("email"), "user@example.com")
})

Deno.test("parseBoundedFormData keeps the multipart boundary", async () => {
  const boundary = "----tslibsboundary"
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="email"`,
    "",
    "user@example.com",
    `--${boundary}--`,
    "",
  ].join("\r\n")
  const request = new Request(ORIGIN, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: payload,
  })

  const form = await parseBoundedFormData(request, { maxBytes: 1024 })
  assertEquals(form.get("email"), "user@example.com")
})

Deno.test("parseBoundedFormData rejects a multipart body over the cap", async () => {
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
  const request = new Request(ORIGIN, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: payload,
  })

  await assertRejects(
    () => parseBoundedFormData(request, { maxBytes: 32 }),
    PayloadTooLargeError,
  )
})

Deno.test("parseBoundedFormData refuses a request without a content-type", async () => {
  const request = new Request(ORIGIN, { method: "POST", body: "email=user%40example.com" })
  await assertRejects(() => parseBoundedFormData(request, { maxBytes: 1024 }), TypeError)
})

// The tests below pin class identity and the public surface after the collapse
// into `net/bounded-body.ts`. They are not the only tests a local
// `class PayloadTooLargeError` breaks: it also reddens the seven
// `assertRejects(..., PayloadTooLargeError)` call sites above, which report the
// bug as "Expected error to be instance of X, but was X" — ten failures in all.

Deno.test("PayloadTooLargeError is the same class object as the canonical one", () => {
  assertStrictEquals(PayloadTooLargeError, NetPayloadTooLargeError)
})

Deno.test("a streamed over-cap body throws the canonical class through the entry point", async () => {
  // The declared-length path is not exercised here: a stream body carries no
  // `content-length`, so only the running total can reject it.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8))
    },
  })
  const request = new Request(ORIGIN, streamInit(body))
  assertStrictEquals(request.headers.get("content-length"), null)

  const thrown = await assertRejects(() => readBoundedBody(request, { maxBytes: 4 }))
  assertStrictEquals(thrown instanceof NetPayloadTooLargeError, true)
  assertStrictEquals(thrown instanceof PayloadTooLargeError, true)
})

Deno.test("a declared over-cap length throws the canonical class through the entry point", async () => {
  // The streamed bytes are inside the cap, so only the declared-length pre-check
  // can reject this request.
  const request = new Request(
    ORIGIN,
    streamInit(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1))
          controller.close()
        },
      }),
      { "content-length": "999999" },
    ),
  )

  const thrown = await assertRejects(() => readBoundedBody(request, { maxBytes: 4 }))
  assertStrictEquals(thrown instanceof NetPayloadTooLargeError, true)
  assertStrictEquals(thrown instanceof PayloadTooLargeError, true)
})

Deno.test("a form-data cap rejection is catchable as the canonical error", async () => {
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
  const request = new Request(ORIGIN, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: payload,
  })

  const thrown = await assertRejects(
    () => parseBoundedFormData(request, { maxBytes: 32 }),
    NetPayloadTooLargeError,
  )
  assertStrictEquals(thrown instanceof NetPayloadTooLargeError, true)
})

Deno.test("the entry point republishes the promised surface and nothing else", async () => {
  const surface: Record<string, unknown> = await import("./bounded-body.ts")

  for (
    const name of [
      "PayloadTooLargeError",
      "readBoundedBody",
      "readBoundedText",
      "readContentLength",
      "parseBoundedFormData",
    ]
  ) {
    assertStrictEquals(name in surface, true, `${name} disappeared from the surface`)
  }
  // A narrow re-export is the point of the collapse: widening it to `export *`
  // would publish canonical symbols this package never promised.
  for (
    const unpromised of [
      "BodyReadErrorCode",
      "BodyReadTimeoutError",
      "readBoundedJson",
      "DEFAULT_MAX_BYTES",
      "DEFAULT_BODY_TIMEOUT_MS",
    ]
  ) {
    assertStrictEquals(unpromised in surface, false, `${unpromised} leaked into the surface`)
  }
})

Deno.test("BoundedBodyTimeout still types the stall budget", async () => {
  // A compile-time pin as much as a runtime one: the name survives the collapse,
  // so `import type { BoundedBodyTimeout }` keeps working for existing callers.
  const timeout: BoundedBodyTimeout = { timeoutMs: 50 }
  const request = new Request(ORIGIN, { method: "POST", body: "abc" })

  assertEquals((await readBoundedBody(request, { ...timeout, maxBytes: 5 })).byteLength, 3)
})
