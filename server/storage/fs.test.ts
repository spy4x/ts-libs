import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { FileSystemPort } from "@spy4x/platform/server/ports"
import {
  createDenoObjectFs,
  createObjectFs,
  type DenoFsHost,
  ensureFileDirectory,
  type WritableFileHandle,
  writeToFile,
} from "./fs.ts"
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
    mkdir: () => Promise.resolve(),
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

describe("ensureFileDirectory", () => {
  it("rethrows a failure to create the directory, such as a denied permission", async () => {
    const denied = () => Promise.reject(new Deno.errors.PermissionDenied("denied"))

    await assertRejects(
      () => ensureFileDirectory("a/b/file.bin", denied),
      Deno.errors.PermissionDenied,
    )
  })

  it("swallows AlreadyExists, so the write that follows reports the precise error", async () => {
    const exists = () => Promise.reject(new Deno.errors.AlreadyExists("a file is there"))

    await ensureFileDirectory("a/b/file.bin", exists)
  })
})

/**
 * A `FileSystemPort` over a map of files. Records every call; `failRename` makes
 * `rename` reject. Directories are not modelled: `mkdirp` only records.
 */
function memoryPort(options: { failRename?: boolean } = {}) {
  const files = new Map<string, Uint8Array>()
  const calls: string[] = []
  const unused = () => Promise.reject(new Error("not used"))
  const port: FileSystemPort = {
    exists: (path) => Promise.resolve(files.has(path)),
    readText: unused,
    writeText: unused,
    appendText: unused,
    readDir: unused,
    lock: unused,
    mkdirp: (path) => {
      calls.push(`mkdirp ${path}`)
      return Promise.resolve()
    },
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`)
      if (options.failRename) return Promise.reject(new Error("rename failed"))
      const data = files.get(from)
      if (data === undefined) return Promise.reject(new Deno.errors.NotFound(from))
      files.delete(from)
      files.set(to, data)
      return Promise.resolve()
    },
    remove: (path) => {
      calls.push(`remove ${path}`)
      files.delete(path)
      return Promise.resolve()
    },
    readBytes: (path) => Promise.resolve(files.get(path) ?? null),
    writeBytes: (path, data) => {
      calls.push(`writeBytes ${path}`)
      files.set(path, Uint8Array.from(data))
      return Promise.resolve()
    },
    writeStream: async (path, source) => {
      calls.push(`writeStream ${path}`)
      const chunks: number[] = []
      files.set(path, new Uint8Array())
      for await (const chunk of source) {
        chunks.push(...chunk)
        files.set(path, Uint8Array.from(chunks))
      }
      return chunks.length
    },
  }
  return { port, files, calls }
}

/** A stream that yields `first`, then errors on the next read. */
function brokenAfter(first: Uint8Array): ReadableStream<Uint8Array> {
  let reads = 0
  return new ReadableStream({
    pull(controller) {
      reads += 1
      if (reads === 1) controller.enqueue(first)
      else controller.error(new Error("connection dropped"))
    },
  })
}

describe("createObjectFs over a FileSystemPort", () => {
  it("writes bytes to a temporary file in the same folder and renames it into place", async () => {
    const { port, files, calls } = memoryPort()
    const fs = createObjectFs(port)

    assertEquals(await fs.writeObject("/srv/a/x.bin", PAYLOAD), PAYLOAD.byteLength)

    assertEquals(calls[0], "mkdirp /srv/a")
    const temporary = calls[1].slice("writeBytes ".length)
    assertEquals(temporary.startsWith("/srv/a/."), true)
    assertEquals(calls.slice(2), [`rename ${temporary} /srv/a/x.bin`])
    assertEquals([...files.keys()], ["/srv/a/x.bin"])
    assertEquals(await fs.readObject("/srv/a/x.bin"), PAYLOAD)
  })

  it("keeps the old object and removes the temporary file when a download is cut off", async () => {
    const { port, files } = memoryPort()
    const fs = createObjectFs(port)
    await fs.writeObject("/srv/x.bin", PAYLOAD)

    await assertRejects(
      () => fs.writeObject("/srv/x.bin", brokenAfter(new Uint8Array([9, 9]))),
      Error,
      "connection dropped",
    )

    assertEquals([...files.keys()], ["/srv/x.bin"])
    assertEquals(await fs.readObject("/srv/x.bin"), PAYLOAD)
  })

  it("returns the streamed byte count", async () => {
    const { port } = memoryPort()

    assertEquals(await createObjectFs(port).writeObject("x.bin", streamOf(PAYLOAD, PAYLOAD)), 46)
  })

  it("removes the temporary file and rethrows when the rename fails", async () => {
    const { port, files } = memoryPort({ failRename: true })

    await assertRejects(
      () => createObjectFs(port).writeObject("/srv/x.bin", PAYLOAD),
      Error,
      "rename failed",
    )

    assertEquals(files.size, 0)
  })

  it("rejects reading a missing object with NotFound", async () => {
    const { port } = memoryPort()

    await assertRejects(() => createObjectFs(port).readObject("/srv/none"), Deno.errors.NotFound)
  })

  it("throws at construction for a port without the byte methods", () => {
    const { port } = memoryPort()
    const { writeStream: _unused, ...withoutStream } = port

    assertThrows(() => createObjectFs(withoutStream), TypeError, "writeStream")
  })
})

describe("createDenoObjectFs with a host that can rename", () => {
  it("writes to a temporary file and renames it over the target", async () => {
    const opened: string[] = []
    const renamed: string[] = []
    const file = shortWritingFile(64)
    const fs = createDenoObjectFs({
      ...hostFor(file),
      open: (path) => {
        opened.push(path)
        return file.open()
      },
      rename: (from, to) => {
        renamed.push(`${from} -> ${to}`)
        return Promise.resolve()
      },
    })

    await fs.writeObject("base/x.bin", PAYLOAD)

    assertEquals(opened.length, 1)
    assertEquals(opened[0].startsWith("base/."), true)
    assertEquals(renamed, [`${opened[0]} -> base/x.bin`])
  })
})
