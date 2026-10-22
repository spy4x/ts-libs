import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { matchesContentType, SNIFF_BYTES, SNIFFABLE_CONTENT_TYPES } from "./content-type.ts"

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(
    parts.flatMap((part) =>
      typeof part === "string" ? Array.from(part, (char) => char.charCodeAt(0)) : part
    ),
  )

/** The first bytes of one real file of each type. */
const SAMPLES: Record<string, Uint8Array> = {
  "image/png": bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d], "IHDR"),
  "image/jpeg": bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF"),
  "image/gif": bytes("GIF89a", [1, 0, 1, 0]),
  "image/webp": bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "),
  "application/pdf": bytes("%PDF-1.7\n"),
  "application/zip": bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0]),
  "text/plain": new TextEncoder().encode("Привет, world\n"),
  "text/csv": bytes("id,name\n1,Ann\n"),
  "application/json": bytes(`{"a":1}`),
}

describe("matchesContentType", () => {
  it("accepts the first bytes of a real file of every type it knows", () => {
    for (const type of SNIFFABLE_CONTENT_TYPES) {
      assertEquals(matchesContentType(SAMPLES[type], type), true, type)
    }
  })

  it("refuses a PNG's bytes under every other type", () => {
    for (const type of SNIFFABLE_CONTENT_TYPES.filter((type) => type !== "image/png")) {
      assertEquals(matchesContentType(SAMPLES["image/png"], type), false, type)
    }
  })

  it("refuses an HTML page that claims to be a PNG", () => {
    assertEquals(matchesContentType(bytes("<html><script>alert(1)</script>"), "image/png"), false)
  })

  it("refuses a RIFF file that is not WebP, such as a WAV", () => {
    assertEquals(
      matchesContentType(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "), "image/webp"),
      false,
    )
  })

  it("accepts a GIF87a and an empty ZIP archive", () => {
    assertEquals(matchesContentType(bytes("GIF87a"), "image/gif"), true)
    assertEquals(matchesContentType(bytes([0x50, 0x4b, 0x05, 0x06]), "application/zip"), true)
  })

  it("refuses text with a NUL byte or invalid UTF-8", () => {
    assertEquals(matchesContentType(bytes("a", [0], "b"), "text/plain"), false)
    assertEquals(matchesContentType(bytes([0xff, 0xfe, 0x41]), "text/plain"), false)
  })

  it("accepts text whose head stops in the middle of a character", () => {
    const text = new TextEncoder().encode("ok é")
    assertEquals(matchesContentType(text.subarray(0, text.length - 1), "text/plain"), true)
  })

  it("looks only at the first SNIFF_BYTES bytes", () => {
    const long = new Uint8Array(SNIFF_BYTES + 1).fill(0x61)
    long[SNIFF_BYTES] = 0
    assertEquals(matchesContentType(long, "text/plain"), true)
  })

  it("ignores parameters and case in the type", () => {
    assertEquals(matchesContentType(SAMPLES["text/csv"], "Text/CSV; charset=utf-8"), true)
  })

  it("refuses an empty file and a type it does not know", () => {
    assertEquals(matchesContentType(new Uint8Array(0), "text/plain"), false)
    assertEquals(matchesContentType(SAMPLES["text/plain"], "text/html"), false)
    assertEquals(matchesContentType(SAMPLES["image/png"], "image/svg+xml"), false)
  })
})
