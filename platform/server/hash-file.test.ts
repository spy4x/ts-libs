import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { chunkBytes, fakeByteReader } from "./_fake-fs.ts"
import { sha256OfBytes, sha256OfStream, sha256OfText } from "./hash-file.ts"

/** SHA-256 of the empty string and of "abc" — published values, not recomputed here. */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("sha256OfBytes", () => {
  it("hashes the empty input to the published digest", async () => {
    expect(await sha256OfBytes(new Uint8Array())).toBe(EMPTY_SHA256)
  })

  it("hashes a known input to the published digest", async () => {
    expect(await sha256OfBytes(new TextEncoder().encode("abc"))).toBe(ABC_SHA256)
  })

  it("hashes a view into a larger buffer by its own window only", async () => {
    const backing = new TextEncoder().encode("xxabcxx")
    const view = backing.subarray(2, 5)
    expect(await sha256OfBytes(view)).toBe(ABC_SHA256)
  })
})

describe("sha256OfText", () => {
  it("hashes UTF-8 text", async () => {
    expect(await sha256OfText("abc")).toBe(ABC_SHA256)
    expect(await sha256OfText("")).toBe(EMPTY_SHA256)
  })

  it("distinguishes two strings that differ only by a multi-byte character", async () => {
    const withAccent = await sha256OfText("cafe")
    const withEAcute = await sha256OfText("café")
    expect(withEAcute).not.toBe(withAccent)
  })
})

describe("sha256OfStream", () => {
  it("matches the one-shot digest for the same bytes", async () => {
    const bytes = new TextEncoder().encode("abc")
    expect(await sha256OfStream(fakeByteReader([bytes]))).toBe(ABC_SHA256)
  })

  it("hashes the empty stream to the empty digest", async () => {
    expect(await sha256OfStream(fakeByteReader([]))).toBe(EMPTY_SHA256)
  })

  it("is independent of how the bytes are chunked", async () => {
    const payload = new Uint8Array(1000)
    crypto.getRandomValues(payload)
    const oneShot = await sha256OfBytes(payload)
    for (const size of [1, 3, 64, 999, 1000, 4096]) {
      expect(await sha256OfStream(fakeByteReader(chunkBytes(payload, size)))).toBe(oneShot)
    }
  })

  it("hashes a stream whose first chunk is empty", async () => {
    expect(
      await sha256OfStream(fakeByteReader([new Uint8Array(), new TextEncoder().encode("abc")])),
    ).toBe(ABC_SHA256)
  })

  it("propagates a reader failure instead of returning a digest of the prefix", async () => {
    const reader = {
      async *chunks() {
        yield new TextEncoder().encode("ab")
        throw new Error("device error")
      },
    }
    await expect(sha256OfStream(reader)).rejects.toThrow("device error")
  })
})
