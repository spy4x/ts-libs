import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { createDenoObjectFs, type DenoFsHost, type WritableFileHandle, writeToFile } from "./fs.ts"
import { LocalStorage } from "./local.ts"
import { S3Storage } from "./s3.ts"

const PAYLOAD = Uint8Array.from({ length: 23 }, (_, index) => (index * 37 + 5) % 256)

/**
 * A handle that writes at most `limit` bytes per call and returns how many it
 * wrote, which `Deno.FsFile.write` is allowed to do on a nearly full disk.
 * `limit: 0` makes every write report no progress.
 */
function shortWritingFile(limit: number) {
  const stored: number[] = []
  let calls = 0
  let closed = false
  const handle: WritableFileHandle = {
    write(data) {
      calls += 1
      if (calls > 1000) return Promise.reject(new Error("write loop did not stop"))
      const count = Math.min(limit, data.byteLength)
      stored.push(...data.subarray(0, count))
      return Promise.resolve(count)
    },
    close() {
      closed = true
    },
  }
  return {
    handle,
    open: () => Promise.resolve(handle),
    stored: () => Uint8Array.from(stored),
    get closed() {
      return closed
    },
  }
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return ReadableStream.from(chunks)
}

function hostFor(file: ReturnType<typeof shortWritingFile>, source = PAYLOAD): DenoFsHost {
  return {
    readFile: () => Promise.resolve(source),
    stat: () => Promise.resolve({}),
    writeFile: () => Promise.reject(new Error("writeFile is not used")),
    open: file.open,
  }
}

describe("writeToFile with a handle that writes short", () => {
  it("writes every byte of a whole buffer and reports that count", async () => {
    const file = shortWritingFile(4)

    const reported = await writeToFile("out.bin", PAYLOAD, file.open)

    assertEquals(file.stored(), PAYLOAD)
    assertEquals(reported, PAYLOAD.byteLength)
    assertEquals(file.closed, true)
  })

  it("writes every byte of every streamed chunk and reports that count", async () => {
    const file = shortWritingFile(3)

    const reported = await writeToFile(
      "out.bin",
      streamOf(PAYLOAD.subarray(0, 10), PAYLOAD.subarray(10)),
      file.open,
    )

    assertEquals(file.stored(), PAYLOAD)
    assertEquals(reported, PAYLOAD.byteLength)
    assertEquals(file.closed, true)
  })

  it("rejects a whole-buffer write that makes no progress and closes the handle", async () => {
    const file = shortWritingFile(0)

    await assertRejects(
      () => writeToFile("out.bin", PAYLOAD, file.open),
      Deno.errors.WriteZero,
      "after 0 of 23 bytes",
    )
    assertEquals(file.closed, true)
  })

  it("rejects a streamed write that makes no progress and closes the handle", async () => {
    const file = shortWritingFile(0)

    await assertRejects(
      () => writeToFile("out.bin", streamOf(PAYLOAD), file.open),
      Deno.errors.WriteZero,
    )
    assertEquals(file.closed, true)
  })
})

describe("storage callers with a handle that writes short", () => {
  it("LocalStorage.upload stores the whole body", async () => {
    const file = shortWritingFile(5)
    const storage = new LocalStorage({ basePath: "base", fs: createDenoObjectFs(hostFor(file)) })

    await storage.upload("bucket", "photo.png", PAYLOAD)

    assertEquals(file.stored(), PAYLOAD)
  })

  it("LocalStorage.download copies the whole object and reports its length", async () => {
    const file = shortWritingFile(5)
    const storage = new LocalStorage({ basePath: "base", fs: createDenoObjectFs(hostFor(file)) })

    const reported = await storage.download("bucket", "photo.png", "copy.png")

    assertEquals(file.stored(), PAYLOAD)
    assertEquals(reported, PAYLOAD.byteLength)
  })

  it("S3Storage.download streams the whole body and reports its length", async () => {
    const file = shortWritingFile(5)
    const storage = new S3Storage({
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      clock: () => new Date("2026-01-01T00:00:00Z"),
      fetch: () => Promise.resolve(new Response(streamOf(PAYLOAD))),
      fs: createDenoObjectFs(hostFor(file)),
    })

    const reported = await storage.download("bucket", "photo.png", "copy.png")

    assertEquals(file.stored(), PAYLOAD)
    assertEquals(reported, PAYLOAD.byteLength)
  })

  it("LocalStorage.upload rejects when the handle makes no progress", async () => {
    const file = shortWritingFile(0)
    const storage = new LocalStorage({ basePath: "base", fs: createDenoObjectFs(hostFor(file)) })

    await assertRejects(
      () => storage.upload("bucket", "photo.png", PAYLOAD),
      Deno.errors.WriteZero,
    )
  })
})
