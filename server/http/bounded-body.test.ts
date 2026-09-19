import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert"
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
 * `readBoundedBody` returns offset-0 views today, but the form-data path must
 * not depend on that: the source handed `body.buffer` to `Response`, which is
 * the whole backing buffer, not the view.
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

/** A timer the test fires by hand, so no test waits on the wall clock. */
function manualTimer() {
  const handlers: Array<() => void> = []
  const cleared: number[] = []
  const timeoutOptions: BoundedBodyTimeout = {
    setTimer: (handler) => {
      handlers.push(handler)
      return handlers.length - 1
    },
    clearTimer: (handle) => {
      cleared.push(handle)
    },
  }
  return {
    timeoutOptions,
    cleared,
    fire: () => {
      for (const handler of handlers) handler()
    },
  }
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
  let settled = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      // Whatever reaches the reader is irrelevant: the rejection has to happen
      // before the first chunk, so closing here keeps the test from hanging.
      settled = true
      controller.close()
    },
  })
  const request = new Request(
    ORIGIN,
    streamInit(body, { "content-length": "999999" }),
  )

  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
  assertEquals(settled, false, "the body was read despite an over-cap content-length")
})

Deno.test("readBoundedBody cancels an over-cap declared body without reading it", async () => {
  let cancelReason: unknown
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {})
    },
    cancel(reason) {
      cancelled = true
      cancelReason = reason
    },
  })
  const request = new Request(
    ORIGIN,
    streamInit(body, { "content-length": "999999" }),
  )

  await assertRejects(() => readBoundedBody(request, { maxBytes: 5 }), PayloadTooLargeError)
  assertEquals(cancelled, true, "rejected request body was left un-cancelled")
  assertEquals(cancelReason, undefined)
})

Deno.test("readBoundedBody rejects a stalled body when the deadline fires", async () => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {})
    },
    cancel() {
      cancelled = true
    },
  })
  const request = new Request(ORIGIN, streamInit(body))
  const timer = manualTimer()

  const pending = assertRejects(
    () => readBoundedBody(request, { maxBytes: 64, timeoutMs: 1000, ...timer.timeoutOptions }),
    Error,
    "Body read timed out after 1000ms",
  )

  timer.fire()
  await pending
  assertEquals(timer.cleared.length, 1, "timeout timer was not cleared")
  assertEquals(cancelled, true, "the stalled reader was left open after the timeout")
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
  const request = new Request(ORIGIN, { method: "POST", body: "abc" })
  await assertRejects(() => readBoundedBody(request, { maxBytes: -1 }), RangeError)
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

Deno.test("readContentLength reads an integer header and ignores junk", () => {
  assertEquals(readContentLength(new Headers({ "content-length": "42" })), 42)
  assertEquals(readContentLength(new Headers({ "content-length": "0" })), 0)
  assertEquals(readContentLength(new Headers()), null)
  assertEquals(readContentLength(new Headers({ "content-length": "12.5" })), null)
  assertEquals(readContentLength(new Headers({ "content-length": "-1" })), null)
  assertEquals(readContentLength(new Headers({ "content-length": "12abc" })), null)
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
