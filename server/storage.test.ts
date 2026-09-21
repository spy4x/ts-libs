import { assert, assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { StorageError, type StorageErrorCode } from "./storage/errors.ts"
import { parseExpiresIn, parseStorageEnv, StorageEnvName } from "./storage/env.ts"
import {
  createDenoObjectFs,
  type DenoFsHost,
  denoFsHost,
  parentDirectory,
  type WritableFileHandle,
  writeToFile,
} from "./storage/fs.ts"
import {
  createBucketStorage,
  createStorage,
  createStorageFrom,
  loadStorageProvider,
  storageEnvNames,
} from "./storage/index.ts"
import { DEFAULT_LOCAL_BASE_PATH, LocalStorage } from "./storage/local.ts"
import { createMemoryObjectFs } from "./storage/memory-fs.ts"
import {
  assertDestinationPath,
  isSafeObjectPath,
  resolveObjectKey,
  resolveStoragePath,
} from "./storage/paths.ts"
import type { ObjectFs } from "./storage/ports.ts"
import { defaultS3Endpoint, S3Storage } from "./storage/s3.ts"
import {
  DEFAULT_EXPIRES_IN_SECONDS,
  formatAmzDate,
  MAX_PRESIGN_EXPIRES_IN_SECONDS,
  signS3Request,
} from "./storage/sigv4.ts"

/**
 * Fixed credentials and a fixed clock, so every presigned URL in this file is
 * deterministic. `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder.
 */
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}
const FIXED_NOW = new Date("2026-01-02T03:04:05Z")
const AWS_ENDPOINT = "https://s3.eu-central-1.amazonaws.com"
/** MinIO's default endpoint: loopback, so path-style addressing is selected. */
const MINIO_ENDPOINT = "http://127.0.0.1:9000"
const AWS_SIGNATURE = /^[0-9a-f]{64}$/

/**
 * Bytes that are not valid UTF-8: NUL, a lone 0xff, 0xfe, an orphan continuation
 * byte, and a PNG magic prefix. A provider that decodes a body to text cannot
 * round-trip these.
 */
const BINARY_PAYLOAD = new Uint8Array([
  0x00,
  0xff,
  0xfe,
  0x80,
  0x01,
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
])

/** A valid `PresignRequest` a guard test can then spoil field by field. */
function presignRequest(): import("./storage/sigv4.ts").PresignRequest {
  return {
    method: "GET",
    endpoint: "https://examplebucket.s3.amazonaws.com",
    key: "test.txt",
    region: "us-east-1",
    credentials: CREDENTIALS,
    expiresIn: DEFAULT_EXPIRES_IN_SECONDS,
    now: new Date("2013-05-24T00:00:00Z"),
  }
}

function makeS3Storage(overrides: Partial<ConstructorParameters<typeof S3Storage>[0]> = {}) {
  return new S3Storage({
    region: "eu-central-1",
    ...CREDENTIALS,
    endpoint: AWS_ENDPOINT,
    clock: () => FIXED_NOW,
    ...overrides,
  })
}

/** A fetch double. Nothing in this file opens a socket. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }
  return { fetch: impl as typeof fetch, calls }
}

function bodyResponse(chunks: Uint8Array[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

/**
 * A `DenoFsHost` double. Every member defaults to "not configured", so a test
 * opts into exactly the branch it exercises and an unexpected call is loud.
 */
function fakeDenoHost(overrides: Partial<DenoFsHost> = {}): DenoFsHost {
  return {
    readFile: () => Promise.reject(new Error("readFile not configured")),
    stat: () => Promise.reject(new Error("stat not configured")),
    writeFile: () => Promise.reject(new Error("writeFile not configured")),
    open: () => Promise.reject(new Error("open not configured")),
    ...overrides,
  }
}

/**
 * A `WritableFileHandle` double: records what was written and whether it was
 * closed. Lets `writeToFile` be driven on the test task's permissions, which
 * grant neither `--allow-write` nor enough for `Deno.makeTempDir`.
 */
function fakeFileHandle(options: { failOnWrite?: boolean } = {}) {
  const chunks: Uint8Array[] = []
  let closed = false
  const handle: WritableFileHandle = {
    write(data) {
      if (options.failOnWrite) {
        return Promise.reject(new Error("simulated write failure"))
      }
      chunks.push(Uint8Array.from(data))
      return Promise.resolve(data.byteLength)
    },
    close() {
      closed = true
    },
  }
  return {
    handle,
    written: () => chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    bytes: () => {
      const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
      let offset = 0
      for (const chunk of chunks) {
        joined.set(chunk, offset)
        offset += chunk.byteLength
      }
      return joined
    },
    get closed() {
      return closed
    },
    get chunkCount() {
      return chunks.length
    },
  }
}

/** A deterministic byte array whose length is not a multiple of any chunk used below. */
function chunkBoundaryPayload(length: number): Uint8Array {
  const payload = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) payload[index] = index % 251
  return payload
}

/**
 * Split a payload into deliberately awkward chunks: the first is larger than
 * 64 KiB and not a multiple of it, the second is exactly 64 KiB, and single
 * bytes sit at both ends. A byte count that is right for two chunks can still
 * be wrong across a boundary.
 */
const ODD_CHUNK_SIZES = [65537, 65536, 1, 262144, 131072, 524286, 1]

/** 1 MiB + 1: not a multiple of 64 KiB and not of any chunk size above. */
const CHUNK_BOUNDARY_LENGTH = ODD_CHUNK_SIZES.reduce((total, size) => total + size, 0)

function* oddChunks(payload: Uint8Array): Generator<Uint8Array> {
  let offset = 0
  for (const size of ODD_CHUNK_SIZES) {
    yield payload.subarray(offset, offset + size)
    offset += size
  }
}

/** Wrap chunks in a `ReadableStream`, as an HTTP response body arrives. */
function chunkStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/** Build an environment record without `undefined` values, as `Deno.env.toObject()` would. */
function asEnv(entries: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

/**
 * Assert that `fn` fails with a `StorageError` of the given code.
 *
 * Accepts a synchronous throw as well as a rejection: validation of a bucket or
 * key is synchronous, and a test that only handles the async path would pass
 * for the wrong reason.
 */
async function rejectsWithCode(
  code: StorageErrorCode,
  fn: () => unknown,
): Promise<StorageError> {
  let error: StorageError | undefined
  try {
    await fn()
  } catch (caught) {
    if (!(caught instanceof StorageError)) throw caught
    error = caught
  }
  assert(error !== undefined, "expected a StorageError, but the call succeeded")
  assertEquals(error.code, code)
  return error
}

describe("signS3Request", () => {
  it("reproduces the published AWS SigV4 presign example byte for byte", async () => {
    // The published example addresses the bucket in the host: canonical URI
    // `/test.txt`, signed host `examplebucket.s3.amazonaws.com`.
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = await signS3Request({
      method: "GET",
      endpoint: "https://examplebucket.s3.amazonaws.com",
      key: "test.txt",
      region: "us-east-1",
      credentials: CREDENTIALS,
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    })

    assertEquals(
      url,
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
        "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&" +
        "X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&" +
        "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    )
  })

  it("signs the path-style variant of the same example with the bucket in the URI", async () => {
    const url = await signS3Request({
      method: "GET",
      endpoint: "https://s3.amazonaws.com",
      key: "examplebucket/test.txt",
      region: "us-east-1",
      credentials: CREDENTIALS,
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    })

    assertEquals(
      url,
      "https://s3.amazonaws.com/examplebucket/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
        "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&" +
        "X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&" +
        "X-Amz-Signature=733255ef022bec3f2a8701cd61d4b371f3f28c9f193a1f02279211d48d5193d7",
    )
  })

  it("rejects a malformed region before signing", async () => {
    // A direct caller of the signer is not behind S3Storage's constructor, so
    // these guards are the only thing between it and an invalid signature.
    for (const region of ["", "NOT A REGION", "eu-central-1!", "ÜS"]) {
      const error = await rejectsWithCode(
        "invalid_config",
        () => signS3Request({ ...presignRequest(), region }),
      )
      assert(error.message.includes("Invalid region"))
    }
  })

  it("rejects empty credentials before signing", async () => {
    const accessKeyId = await rejectsWithCode(
      "invalid_config",
      () =>
        signS3Request({ ...presignRequest(), credentials: { ...CREDENTIALS, accessKeyId: "" } }),
    )
    const secretAccessKey = await rejectsWithCode(
      "invalid_config",
      () =>
        signS3Request({
          ...presignRequest(),
          credentials: { ...CREDENTIALS, secretAccessKey: "" },
        }),
    )

    assert(accessKeyId.message.includes("accessKeyId"))
    assert(secretAccessKey.message.includes("secretAccessKey"))
  })

  it("rejects an expiry outside the S3 range or not an integer", async () => {
    for (const expiresIn of [0, -1, 604801, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = await rejectsWithCode(
        "invalid_expiry",
        () => signS3Request({ ...presignRequest(), expiresIn }),
      )
      assert(error.message.includes("expiresIn"))
    }
  })

  it("rejects a non-http endpoint before signing", async () => {
    const error = await rejectsWithCode(
      "invalid_config",
      () =>
        signS3Request({ ...presignRequest(), endpoint: "ftp://examplebucket.s3.amazonaws.com" }),
    )

    assert(error.message.includes("Endpoint must be http or https"))
  })

  it("produces different signatures for the two addressing styles", async () => {
    const common = {
      method: "GET" as const,
      region: "us-east-1",
      credentials: CREDENTIALS,
      expiresIn: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    }
    const virtualHosted = await signS3Request({
      ...common,
      endpoint: "https://examplebucket.s3.amazonaws.com",
      key: "test.txt",
    })
    const pathStyle = await signS3Request({
      ...common,
      endpoint: "https://s3.amazonaws.com",
      key: "examplebucket/test.txt",
    })

    assert(
      new URL(virtualHosted).searchParams.get("X-Amz-Signature") !==
        new URL(pathStyle).searchParams.get("X-Amz-Signature"),
      "the two styles must not collide",
    )
  })
})

describe("S3Storage.getUploadURL", () => {
  it("defaults the presign to no ACL at all", async () => {
    const url = await makeS3Storage().getUploadURL("examplebucket", "test.txt")
    const parameters = new URL(url).searchParams

    assertEquals(parameters.get("x-amz-acl"), null)
    assertEquals(parameters.get("X-Amz-SignedHeaders"), "host")
    assert(!url.includes("public-read"), "a default presign must not mention any ACL")
  })

  it("omits the ACL parameter entirely rather than sending it empty", async () => {
    const url = await makeS3Storage().getUploadURL("examplebucket", "test.txt")

    assert(
      !url.includes("acl"),
      `a default presign must carry no acl parameter, got ${url}`,
    )
  })

  it("adds the ACL only when a caller opts in explicitly", async () => {
    const url = await makeS3Storage().getUploadURL("examplebucket", "test.txt", {
      acl: "public-read",
    })
    const parameters = new URL(url).searchParams

    assertEquals(parameters.get("x-amz-acl"), "public-read")
    assertEquals(parameters.get("X-Amz-SignedHeaders"), "host")
  })

  it("produces a different signature with than without the ACL opt-in", async () => {
    const provider = makeS3Storage()
    const withoutAcl = await provider.getUploadURL("examplebucket", "test.txt")
    const withAcl = await provider.getUploadURL("examplebucket", "test.txt", { acl: "public-read" })

    assert(
      new URL(withoutAcl).searchParams.get("X-Amz-Signature") !==
        new URL(withAcl).searchParams.get("X-Amz-Signature"),
      "the ACL must be part of the signed request, not an unsigned extra",
    )
  })

  it("rejects an ACL outside the canned set", async () => {
    const error = await rejectsWithCode(
      "invalid_acl",
      () => makeS3Storage().getUploadURL("examplebucket", "test.txt", { acl: "bucket-owner-no" }),
    )

    assert(error.message.includes("Unsupported canned ACL"))
  })

  it("defaults the expiry to 3600 seconds", async () => {
    const url = await makeS3Storage().getUploadURL("examplebucket", "test.txt")

    assertEquals(
      new URL(url).searchParams.get("X-Amz-Expires"),
      String(DEFAULT_EXPIRES_IN_SECONDS),
    )
  })

  it("honours a per-call expiry override", async () => {
    const url = await makeS3Storage({ expiresIn: 60 }).getUploadURL("examplebucket", "test.txt", {
      expiresIn: 900,
    })

    assertEquals(new URL(url).searchParams.get("X-Amz-Expires"), "900")
  })

  it("rejects an expiry beyond the S3 ceiling instead of clamping it", () => {
    const error = (() => {
      try {
        makeS3Storage({ expiresIn: MAX_PRESIGN_EXPIRES_IN_SECONDS + 1 })
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_expiry")
  })

  it("scopes the credential to the region and the date", async () => {
    const url = await makeS3Storage().getUploadURL("examplebucket", "test.txt")
    const parameters = new URL(url).searchParams

    assertEquals(
      parameters.get("X-Amz-Credential"),
      `${CREDENTIALS.accessKeyId}/20260102/eu-central-1/s3/aws4_request`,
    )
    assertEquals(parameters.get("X-Amz-Date"), "20260102T030405Z")
    assertEquals(parameters.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256")
  })

  it("addresses AWS virtual-hosted and a loopback endpoint path-style", async () => {
    const virtualHosted = await makeS3Storage().getUploadURL("examplebucket", "test.txt")
    const pathStyle = await makeS3Storage({ endpoint: MINIO_ENDPOINT }).getUploadURL(
      "examplebucket",
      "test.txt",
    )

    assertEquals(new URL(virtualHosted).host, "examplebucket.s3.eu-central-1.amazonaws.com")
    assertEquals(new URL(virtualHosted).pathname, "/test.txt")
    assertEquals(new URL(pathStyle).host, "127.0.0.1:9000")
    assertEquals(new URL(pathStyle).pathname, "/examplebucket/test.txt")
  })

  it("keeps the bucket in the canonical path when addressing path-style", async () => {
    const url = await makeS3Storage({ endpoint: MINIO_ENDPOINT }).getUploadURL(
      "examplebucket",
      "test.txt",
    )

    assertEquals(new URL(url).pathname, "/examplebucket/test.txt")
  })

  it("signs a session token into the query when credentials are temporary", async () => {
    const url = await makeS3Storage({
      sessionToken: "SECURITY-TOKEN-PLACEHOLDER",
    }).getUploadURL("examplebucket", "test.txt")

    assertEquals(
      new URL(url).searchParams.get("X-Amz-Security-Token"),
      "SECURITY-TOKEN-PLACEHOLDER",
    )
  })

  it("signs a key with reserved characters without losing its shape", async () => {
    const url = await makeS3Storage().getUploadURL(
      "examplebucket",
      "media/2026/report (final)+v2.png",
    )

    assertEquals(new URL(url).pathname, "/media/2026/report%20%28final%29%2Bv2.png")
    assert(AWS_SIGNATURE.test(new URL(url).searchParams.get("X-Amz-Signature") ?? ""))
  })
})

describe("S3Storage.getDownloadURL", () => {
  it("presigns a GET with no ACL even when one is offered", async () => {
    const url = await makeS3Storage().getDownloadURL("examplebucket", "test.txt", {
      acl: "public-read",
    })
    const parameters = new URL(url).searchParams

    assertEquals(parameters.get("x-amz-acl"), null)
    assert(!url.includes("public-read"), "a download presign must never carry an ACL")
  })
})

describe("S3Storage with an injected fetch", () => {
  it("uploads the exact bytes through a presigned PUT", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const provider = makeS3Storage({ fetch: fetchImpl })

    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    assertEquals(calls.length, 1)
    assertEquals(calls[0].init?.method, "PUT")
    assert(
      calls[0].url.startsWith("https://examplebucket.s3.eu-central-1.amazonaws.com/"),
      calls[0].url,
    )
    assertEquals(new URL(calls[0].url).searchParams.get("x-amz-acl"), null)
    assertEquals(new Uint8Array(calls[0].init?.body as ArrayBuffer), BINARY_PAYLOAD)
  })

  it("encodes a string body as UTF-8 bytes", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }))

    await makeS3Storage({ fetch: fetchImpl }).upload("examplebucket", "note.txt", "héllo")

    assertEquals(
      new Uint8Array(calls[0].init?.body as ArrayBuffer),
      new TextEncoder().encode("héllo"),
    )
  })

  it("fails an upload with the response status, not a silent success", async () => {
    const { fetch: fetchImpl } = fakeFetch(
      () => new Response("AccessDenied", { status: 403 }),
    )
    const provider = makeS3Storage({ fetch: fetchImpl })

    const error = await rejectsWithCode(
      "request_failed",
      () => provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD),
    )

    assertEquals(error.status, 403)
    assertEquals(error.operation, "upload")
  })

  it("streams a download to the destination byte for byte", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() =>
      bodyResponse([BINARY_PAYLOAD.slice(0, 5), BINARY_PAYLOAD.slice(5)])
    )
    const destination = createMemoryObjectFs()
    const provider = makeS3Storage({ fetch: fetchImpl, fs: destination })

    const written = await provider.download("examplebucket", "photo.png", "/tmp/photo.png")

    assertEquals(written, BINARY_PAYLOAD.byteLength)
    assertEquals(calls[0].init?.method, "GET")
    const stored = await destination.readObject("/tmp/photo.png")
    assertEquals(stored, BINARY_PAYLOAD)
    assert(stored !== BINARY_PAYLOAD, "the stream must be a copy, not the caller's buffer")
  })

  it("streams a payload that is not a multiple of the chunk size byte-exactly", async () => {
    const payload = chunkBoundaryPayload(CHUNK_BOUNDARY_LENGTH)
    const { fetch: fetchImpl } = fakeFetch(() => bodyResponse([...oddChunks(payload)]))
    const destination = createMemoryObjectFs()
    const provider = makeS3Storage({ fetch: fetchImpl, fs: destination })

    const written = await provider.download("examplebucket", "big.bin", "/tmp/big.bin")

    assertEquals(written, CHUNK_BOUNDARY_LENGTH)
    assert(written % 65536 !== 0, "the payload must not be a whole number of 64 KiB blocks")
    const stored = await destination.readObject("/tmp/big.bin")
    assertEquals(stored.byteLength, CHUNK_BOUNDARY_LENGTH)
    assertEquals(stored, payload)
    assert(stored !== payload, "the stream must be a copy, not the caller's buffer")
  })

  it("fails a download with the response status when the object is unreachable", async () => {
    const { fetch: fetchImpl } = fakeFetch(() => new Response("NoSuchKey", { status: 404 }))
    const provider = makeS3Storage({ fetch: fetchImpl, fs: createMemoryObjectFs() })

    const error = await rejectsWithCode(
      "request_failed",
      () => provider.download("examplebucket", "missing.png", "/tmp/missing.png"),
    )

    assertEquals(error.status, 404)
  })

  it("reports existence with a HEAD probe", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const provider = makeS3Storage({ fetch: fetchImpl })

    assertEquals(await provider.doesExist("examplebucket", "photo.png"), true)
    assertEquals(calls[0].init?.method, "HEAD")
  })

  it("reports a missing object as absent", async () => {
    const { fetch: fetchImpl } = fakeFetch(() => new Response(null, { status: 404 }))

    assertEquals(
      await makeS3Storage({ fetch: fetchImpl }).doesExist("examplebucket", "gone"),
      false,
    )
  })

  it("throws rather than reporting a denied probe as absent", async () => {
    const { fetch: fetchImpl } = fakeFetch(() => new Response(null, { status: 403 }))
    const provider = makeS3Storage({ fetch: fetchImpl })

    const error = await rejectsWithCode(
      "request_failed",
      () => provider.doesExist("examplebucket", "photo.png"),
    )

    assertEquals(error.status, 403)
  })

  it("releases the upload response body instead of leaking it", async () => {
    // Deleting `response.body?.cancel()` from `upload` used to leave every test
    // in this file green: none of them checked the body was ever touched.
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true
      },
    })
    const { fetch: fetchImpl } = fakeFetch(() => new Response(body, { status: 200 }))
    const provider = makeS3Storage({ fetch: fetchImpl })

    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    assertEquals(cancelled, true, "the upload response body must be released")
  })
})

describe("S3Storage signs the request for the method it actually sends", () => {
  it("pins upload, download and exists to a signature for their own method", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch((_url, init) =>
      init?.method === "GET" ? bodyResponse([BINARY_PAYLOAD]) : new Response(null, { status: 200 })
    )
    const provider = makeS3Storage({ fetch: fetchImpl, fs: createMemoryObjectFs() })

    await provider.upload("examplebucket", "test.txt", BINARY_PAYLOAD)
    await provider.download("examplebucket", "test.txt", "/tmp/test.txt")
    await provider.doesExist("examplebucket", "test.txt")

    // Virtual-hosted addressing, the same address `addressFor` builds for a
    // non-loopback endpoint: the bucket in the host, the bare key in the path.
    const expectedFor = (method: "PUT" | "GET" | "HEAD") =>
      signS3Request({
        method,
        endpoint: "https://examplebucket.s3.eu-central-1.amazonaws.com",
        key: "test.txt",
        region: "eu-central-1",
        credentials: CREDENTIALS,
        expiresIn: DEFAULT_EXPIRES_IN_SECONDS,
        now: FIXED_NOW,
      })

    assertEquals(calls.length, 3)
    assertEquals(calls[0].url, await expectedFor("PUT"))
    assertEquals(calls[1].url, await expectedFor("GET"))
    assertEquals(calls[2].url, await expectedFor("HEAD"))
    // A test that only checked that a signature exists would pass even if
    // `doesExist` sent its HEAD against the download's GET-signed URL.
    assert(
      calls[2].url !== calls[1].url,
      "the exists probe must not reuse the download's GET signature",
    )
  })
})

describe("S3Storage wraps a network failure", () => {
  it("never leaks the signed url through the message or the cause", async () => {
    // What a real failed `fetch` looked like on Deno 2.9.7: the signed URL,
    // access key id and signature all sat in the rejection's `cause`.
    const leakyFetch = (): Promise<Response> =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: new Error(
            "error sending request for url (http://127.0.0.1:1/x?X-Amz-Signature=leaked-signature)",
          ),
        }),
      )
    const provider = makeS3Storage({
      fetch: leakyFetch as unknown as typeof fetch,
      fs: createMemoryObjectFs(),
    })

    for (
      const attempt of [
        () => provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD),
        () => provider.download("examplebucket", "photo.png", "/tmp/photo.png"),
        () => provider.doesExist("examplebucket", "photo.png"),
      ]
    ) {
      const error = await rejectsWithCode("request_failed", attempt)
      assertEquals(error.cause, undefined)
      assert(!error.message.includes("X-Amz-Signature"), error.message)
      assert(!JSON.stringify(error).includes("X-Amz-Signature"))
    }
  })
})

describe("S3Storage default endpoint", () => {
  it("derives the regional AWS endpoint when none is configured", async () => {
    const provider = makeS3Storage({ endpoint: undefined, region: "ap-southeast-2" })

    const url = await provider.getUploadURL("examplebucket", "test.txt")

    assertEquals(new URL(url).host, "examplebucket.s3.ap-southeast-2.amazonaws.com")
  })

  it("builds the documented regional host shape, not checked against AWS", () => {
    // No third-party network call is made from this repository: this pins the
    // URL shape only.
    assertEquals(defaultS3Endpoint("ap-southeast-2"), "https://s3.ap-southeast-2.amazonaws.com")
    assertEquals(defaultS3Endpoint("us-east-1"), "https://s3.us-east-1.amazonaws.com")
  })
})

describe("S3Storage construction", () => {
  it("rejects an empty region", () => {
    try {
      new S3Storage({ region: "", ...CREDENTIALS })
      throw new Error("expected a StorageError")
    } catch (error) {
      assert(error instanceof StorageError)
      assertEquals(error.code, "invalid_config")
    }
  })

  it("rejects missing credentials", () => {
    try {
      new S3Storage({ region: "eu-central-1", accessKeyId: "", secretAccessKey: "" })
      throw new Error("expected a StorageError")
    } catch (error) {
      assert(error instanceof StorageError)
      assertEquals(error.code, "invalid_config")
    }
  })
})

describe("download destination", () => {
  it("accepts an absolute destination and a relative one", () => {
    assertEquals(assertDestinationPath("/tmp/out.png"), "/tmp/out.png")
    assertEquals(assertDestinationPath("out.png"), "out.png")
    assertEquals(assertDestinationPath("./file-storage/photo.png"), "./file-storage/photo.png")
    assertEquals(assertDestinationPath("a/b/c.bin"), "a/b/c.bin")
  })

  it("refuses a destination that climbs out of its directory", () => {
    for (const toPath of ["../escape.png", "/tmp/../escape.png", "a/../../escape.png", "..\\x"]) {
      rejectsWithCode("invalid_path", () => assertDestinationPath(toPath))
    }
  })

  it("refuses an empty destination and a NUL byte", () => {
    rejectsWithCode("invalid_path", () => assertDestinationPath(""))
    rejectsWithCode("invalid_path", () => assertDestinationPath("/tmp/ou\u0000t.png"))
  })

  it("refuses a climbing destination before any object is read", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })
    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    await rejectsWithCode(
      "invalid_path",
      () => provider.download("examplebucket", "photo.png", "../escape.png"),
    )
    assertEquals(await fs.existsObject("../escape.png"), false)
  })

  it("refuses a climbing S3 destination before any request is made", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch(() => new Response(null, { status: 200 }))
    const provider = makeS3Storage({ fetch: fetchImpl, fs: createMemoryObjectFs() })

    await rejectsWithCode(
      "invalid_path",
      () => provider.download("examplebucket", "photo.png", "../../escape.png"),
    )
    assertEquals(calls.length, 0, "validation must happen before the fetch")
  })
})

describe("object key validation", () => {
  it("joins bucket and key into the canonical path", () => {
    assertEquals(resolveObjectKey("examplebucket", "media/a.png"), "examplebucket/media/a.png")
  })

  it("rejects a key that climbs out of the bucket", () => {
    const error = (() => {
      try {
        resolveObjectKey("examplebucket", "../other-bucket/secret.png")
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_path")
    assertEquals(isSafeObjectPath("../other-bucket/secret.png"), false)
  })

  it("rejects an absolute key, an embedded scheme and a backslash", async () => {
    for (const path of ["/etc/passwd", "s3://other/secret", "media\\a.png", "media/../../x"]) {
      assertEquals(isSafeObjectPath(path), false, `${path} must be rejected`)
      await rejectsWithCode("invalid_path", () => resolveObjectKey("examplebucket", path))
    }
  })

  it("rejects an invalid bucket name", () => {
    for (const bucket of ["", "AB", "has_underscore", "-leading", "trailing-", "a"]) {
      assertEquals(
        (() => {
          try {
            resolveObjectKey(bucket, "k.png")
            return undefined
          } catch (caught) {
            return (caught as StorageError).code
          }
        })(),
        "invalid_bucket",
        `${bucket} must be rejected`,
      )
    }
  })

  it("resolves a local path under the base directory", () => {
    assertEquals(
      resolveStoragePath("/srv/storage", "examplebucket", "media/a.png"),
      "/srv/storage/examplebucket/media/a.png",
    )
    assertEquals(
      resolveStoragePath("/srv/storage/", "examplebucket", "media/a.png"),
      "/srv/storage/examplebucket/media/a.png",
    )
  })
})

describe("LocalStorage", () => {
  it("round-trips non-UTF-8 bytes through upload and download unchanged", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })

    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)
    await provider.download(
      "examplebucket",
      "photo.png",
      `${DEFAULT_LOCAL_BASE_PATH}/examplebucket/round-trip.png`,
    )

    const stored = await fs.readObject(
      `${DEFAULT_LOCAL_BASE_PATH}/examplebucket/photo.png`,
    )
    const copied = await fs.readObject(
      `${DEFAULT_LOCAL_BASE_PATH}/examplebucket/round-trip.png`,
    )
    assertEquals(stored, BINARY_PAYLOAD)
    assertEquals(copied, BINARY_PAYLOAD)
    assertEquals(stored.byteLength, BINARY_PAYLOAD.byteLength)
    assertEquals(copied.byteLength, BINARY_PAYLOAD.byteLength)
  })

  it("keeps a PNG magic prefix intact", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00])

    await provider.upload("examplebucket", "magic.png", png)

    assertEquals(await fs.readObject(`${DEFAULT_LOCAL_BASE_PATH}/examplebucket/magic.png`), png)
  })

  it("writes a string body as UTF-8 bytes", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })

    await provider.upload("examplebucket", "note.txt", "héllo")

    assertEquals(
      await fs.readObject(`${DEFAULT_LOCAL_BASE_PATH}/examplebucket/note.txt`),
      new TextEncoder().encode("héllo"),
    )
  })

  it("downloads to the destination and reports the byte count", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })
    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    const written = await provider.download("examplebucket", "photo.png", "/tmp/out.png")

    assertEquals(written, BINARY_PAYLOAD.byteLength)
    assertEquals(await fs.readObject("/tmp/out.png"), BINARY_PAYLOAD)
  })

  it("round-trips a chunked payload through upload and download unchanged", async () => {
    const payload = chunkBoundaryPayload(CHUNK_BOUNDARY_LENGTH)
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })
    const at = (name: string) => `${DEFAULT_LOCAL_BASE_PATH}/examplebucket/${name}`

    const uploaded = await fs.writeObject(at("big.bin"), chunkStream([...oddChunks(payload)]))
    assertEquals(uploaded, CHUNK_BOUNDARY_LENGTH)
    assertEquals(await fs.readObject(at("big.bin")), payload)

    const written = await provider.download(
      "examplebucket",
      "big.bin",
      "/tmp/big.bin",
    )

    assertEquals(written, CHUNK_BOUNDARY_LENGTH)
    assertEquals(await fs.readObject("/tmp/big.bin"), payload)
    // Uploading a streamed body and downloading it back must both be exact,
    // not one of the two.
    assertEquals(await fs.readObject(at("big.bin")), await fs.readObject("/tmp/big.bin"))
  })

  it("rejects a download with an empty destination", async () => {
    const provider = new LocalStorage({ fs: createMemoryObjectFs() })

    await rejectsWithCode("invalid_path", () => provider.download("examplebucket", "a.png", ""))
  })

  it("fails a download of a missing object instead of writing an empty file", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })

    await assertRejects(
      () => provider.download("examplebucket", "missing.png", "/tmp/missing.png"),
      Deno.errors.NotFound,
    )
    assertEquals(await fs.existsObject("/tmp/missing.png"), false)
  })

  it("reports existence for a stored object and its absence otherwise", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ fs })
    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    assertEquals(await provider.doesExist("examplebucket", "photo.png"), true)
    assertEquals(await provider.doesExist("examplebucket", "other.png"), false)
  })

  it("refuses a key that climbs out of the bucket", async () => {
    const provider = new LocalStorage({ fs: createMemoryObjectFs() })

    await rejectsWithCode(
      "invalid_path",
      () => provider.upload("examplebucket", "../other-bucket/secret.png", BINARY_PAYLOAD),
    )
  })

  it("resolves into the base path it was given", async () => {
    const fs = createMemoryObjectFs()
    const provider = new LocalStorage({ basePath: "/srv/storage", fs })

    await provider.upload("examplebucket", "photo.png", BINARY_PAYLOAD)

    assertEquals(await fs.existsObject("/srv/storage/examplebucket/photo.png"), true)
    assertEquals(
      provider.fullPath("examplebucket", "photo.png"),
      "/srv/storage/examplebucket/photo.png",
    )
  })

  it("defaults its base path and serves dev-only file URLs", async () => {
    const provider = new LocalStorage({ fs: createMemoryObjectFs() })
    const uploadUrl = await provider.getUploadURL("examplebucket", "photo.png")
    const downloadUrl = await provider.getDownloadURL("examplebucket", "photo.png")

    assertEquals(provider.basePath, DEFAULT_LOCAL_BASE_PATH)
    assertEquals(uploadUrl, downloadUrl)
    assert(uploadUrl.startsWith("file:///"), uploadUrl)
    assert(uploadUrl.endsWith("/examplebucket/photo.png"), uploadUrl)
  })

  it("serves an absolute file URL when the base path is absolute", async () => {
    const provider = new LocalStorage({ basePath: "/srv/storage", fs: createMemoryObjectFs() })

    assertEquals(
      await provider.getDownloadURL("examplebucket", "photo.png"),
      "file:///srv/storage/examplebucket/photo.png",
    )
  })
})

describe("createMemoryObjectFs", () => {
  it("rejects a read of an unknown object", async () => {
    await assertRejects(
      () => createMemoryObjectFs().readObject("/missing"),
      Deno.errors.NotFound,
    )
  })

  it("serves seeded entries and reports the bytes it wrote", async () => {
    const fs = createMemoryObjectFs([["/seed.bin", BINARY_PAYLOAD]])

    assertEquals(await fs.readObject("/seed.bin"), BINARY_PAYLOAD)
    assertEquals(await fs.existsObject("/seed.bin"), true)
    assertEquals(await fs.writeObject("/other.bin", BINARY_PAYLOAD), BINARY_PAYLOAD.byteLength)
    assertEquals(await fs.readObject("/other.bin"), BINARY_PAYLOAD)
  })

  it("hands out copies, so a caller cannot mutate stored bytes", async () => {
    const fs = createMemoryObjectFs()
    await fs.writeObject("/a.bin", BINARY_PAYLOAD)

    const first = await fs.readObject("/a.bin")
    first[0] = 0x99

    assertEquals((await fs.readObject("/a.bin"))[0], 0x00)
  })
})

describe("chunk boundary fixture", () => {
  it("splits a payload of exactly 1 MiB + 1 that is not a multiple of 64 KiB", () => {
    // The list used to end in 393217 and summed to 917508, not 1048577: the
    // comment claimed a size the arithmetic did not produce. Pinned here so it
    // cannot drift again.
    assertEquals(ODD_CHUNK_SIZES.reduce((total, size) => total + size, 0), 1048577)
    assertEquals(CHUNK_BOUNDARY_LENGTH, 1048577)
    assert(CHUNK_BOUNDARY_LENGTH % 65536 !== 0)
    assertEquals(chunkBoundaryPayload(CHUNK_BOUNDARY_LENGTH).byteLength, 1048577)
  })
})

describe("parentDirectory", () => {
  it("returns undefined for a bare filename, so nothing is created", () => {
    // The source bug: `slice(0, "out.png".lastIndexOf("/"))` is `slice(0, -1)`,
    // which dropped the last character and mkdir-ed `out.pn`.
    assertEquals(parentDirectory("out.png"), undefined)
  })

  it("returns undefined when there is no directory part at all", () => {
    for (const filePath of ["", "a", "ab", "./out.png", "out.png", ".hidden"]) {
      assertEquals(
        parentDirectory(filePath),
        undefined,
        `${JSON.stringify(filePath)} has no parent`,
      )
    }
  })

  it("returns the directory part for a nested path", () => {
    assertEquals(parentDirectory("a/b.png"), "a")
    assertEquals(parentDirectory("nested/deep/out.png"), "nested/deep")
    assertEquals(parentDirectory("./nested/out.png"), "nested")
  })

  it("treats an absolute root parent as a directory", () => {
    assertEquals(parentDirectory("/abs/out.png"), "/abs")
    assertEquals(parentDirectory("/out.png"), "/")
  })

  it("collapses a repeated separator but keeps the directory", () => {
    assertEquals(parentDirectory("a//b.png"), "a")
    assertEquals(parentDirectory("a///b/c.png"), "a/b")
    assertEquals(parentDirectory("a/b//c.png"), "a/b")
  })

  it("normalises a Windows separator instead of mangling the name", () => {
    assertEquals(parentDirectory("C:\\tmp\\out.png"), "C:/tmp")
    assertEquals(parentDirectory("nested\\out.png"), "nested")
  })
})

describe("writeToFile", () => {
  it("writes a whole byte array once and reports its length", async () => {
    const file = fakeFileHandle()

    const written = await writeToFile(
      "/tmp/photo.png",
      BINARY_PAYLOAD,
      () => Promise.resolve(file.handle),
    )

    assertEquals(written, BINARY_PAYLOAD.byteLength)
    assertEquals(file.bytes(), BINARY_PAYLOAD)
    assertEquals(file.chunkCount, 1)
    assertEquals(file.closed, true)
  })

  it("counts bytes across chunk boundaries for a streamed body", async () => {
    const payload = chunkBoundaryPayload(CHUNK_BOUNDARY_LENGTH)
    const file = fakeFileHandle()

    const written = await writeToFile(
      "/tmp/big.bin",
      chunkStream([...oddChunks(payload)]),
      () => Promise.resolve(file.handle),
    )

    assertEquals(written, CHUNK_BOUNDARY_LENGTH)
    assertEquals(file.bytes(), payload)
    assertEquals(file.chunkCount, ODD_CHUNK_SIZES.length)
    assertEquals(file.closed, true)
  })

  it("closes the handle and rethrows when a streamed write fails", async () => {
    const file = fakeFileHandle({ failOnWrite: true })

    await assertRejects(
      () =>
        writeToFile(
          "/tmp/photo.png",
          chunkStream([BINARY_PAYLOAD]),
          () => Promise.resolve(file.handle),
        ),
      Error,
      "simulated write failure",
    )
    assertEquals(file.closed, true, "a failed write must not leak the handle")
  })

  it("closes the handle and rethrows when a whole-buffer write fails", async () => {
    // The buffer branch has its own closer+rethrow, separate from the streamed
    // branch above: deleting it alone must redden a test, not pass silently.
    const file = fakeFileHandle({ failOnWrite: true })

    const error = await assertRejects(() =>
      writeToFile("/tmp/photo.png", BINARY_PAYLOAD, () => Promise.resolve(file.handle))
    )

    assert(error instanceof Error)
    assertEquals(error.message, "simulated write failure", "the write error must survive")
    assertEquals(file.closed, true, "a failed whole-buffer write must not leak the handle")
  })

  it("closes the handle when the stream itself errors", async () => {
    const file = fakeFileHandle()
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BINARY_PAYLOAD)
        controller.error(new Error("stream broke"))
      },
    })

    const error = await assertRejects(() =>
      writeToFile("/tmp/photo.png", failing, () => Promise.resolve(file.handle))
    )

    assert(error instanceof Error)
    assertEquals(error.message, "stream broke", "the stream error must survive, not be replaced")
    assertEquals(file.closed, true, "a failed stream must not leak the handle")
  })

  it("keeps the bytes that arrived before a stream error", async () => {
    const file = fakeFileHandle()
    // The error lands one tick after the first chunk, which is the only shape
    // where the sink has already accepted it. A stream that errors before the
    // pump starts delivers nothing at all, so asserting a partial write there
    // would be asserting a microtask ordering rather than this code.
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BINARY_PAYLOAD)
        setTimeout(() => controller.error(new Error("stream broke")), 20)
      },
    })

    await assertRejects(() =>
      writeToFile("/tmp/photo.png", failing, () => Promise.resolve(file.handle))
    )

    assertEquals(file.bytes(), BINARY_PAYLOAD, "a partial write is kept, not discarded")
    assertEquals(file.closed, true)
  })

  it("passes the destination path through to the opener unchanged", async () => {
    const opened: string[] = []
    const file = fakeFileHandle()

    await writeToFile("out.png", BINARY_PAYLOAD, (path) => {
      opened.push(path)
      return Promise.resolve(file.handle)
    })

    assertEquals(opened, ["out.png"], "the opener seam must receive the caller's path")
  })

  it("opens once per write, for the whole-buffer and streamed shapes", async () => {
    const opened: string[] = []
    const file = fakeFileHandle()
    const opener = (path: string) => {
      opened.push(path)
      return Promise.resolve(file.handle)
    }

    await writeToFile("/a/one.bin", BINARY_PAYLOAD, opener)
    await writeToFile("/a/two.bin", chunkStream([BINARY_PAYLOAD]), opener)

    assertEquals(opened, ["/a/one.bin", "/a/two.bin"])
  })
})

describe("createDenoObjectFs", () => {
  it("constructs without touching the filesystem", () => {
    const fs = createDenoObjectFs()

    assertEquals(typeof fs.readObject, "function")
    assertEquals(typeof fs.writeObject, "function")
    assertEquals(typeof fs.existsObject, "function")
  })

  it("reports existence through the injected stat", async () => {
    const statCalls: string[] = []
    const fs = createDenoObjectFs(fakeDenoHost({
      stat: (path) => {
        statCalls.push(path)
        if (path === "/missing") return Promise.reject(new Deno.errors.NotFound("nope"))
        return Promise.resolve({})
      },
    }))

    assertEquals(await fs.existsObject("/present"), true)
    assertEquals(await fs.existsObject("/missing"), false)
    assertEquals(statCalls, ["/present", "/missing"])
  })

  it("rethrows a stat failure that is not NotFound, instead of reporting it absent", async () => {
    const fs = createDenoObjectFs(fakeDenoHost({
      stat: () => Promise.reject(new Deno.errors.PermissionDenied("denied")),
    }))

    // `LocalStorage.doesExist` used to answer `false` here, which the port's
    // contract forbids: only a missing object may read as absent, never a
    // denied or otherwise-failed probe.
    await assertRejects(() => fs.existsObject("/whatever"), Deno.errors.PermissionDenied)
  })

  it("writes through the injected host and returns the byte count", async () => {
    const written: { path: string; data: Uint8Array }[] = []
    const fs = createDenoObjectFs(fakeDenoHost({
      open: (path) => {
        const file = fakeFileHandle()
        return Promise.resolve(
          {
            write(data: Uint8Array) {
              written.push({ path, data: Uint8Array.from(data) })
              return file.handle.write(data)
            },
            close: file.handle.close,
          } satisfies WritableFileHandle,
        )
      },
    }))

    const count = await fs.writeObject("/tmp/out.bin", BINARY_PAYLOAD)

    assertEquals(count, BINARY_PAYLOAD.byteLength)
    assertEquals(written.length, 1)
    assertEquals(written[0].path, "/tmp/out.bin")
    assertEquals(written[0].data, BINARY_PAYLOAD)
  })

  it("reads through the injected host", async () => {
    const fs = createDenoObjectFs(fakeDenoHost({
      readFile: () => Promise.resolve(Uint8Array.from(BINARY_PAYLOAD)),
    }))

    assertEquals(await fs.readObject("/tmp/out.bin"), BINARY_PAYLOAD)
  })

  it("defaults to the real Deno host", () => {
    assertEquals(typeof denoFsHost.readFile, "function")
    assertEquals(typeof denoFsHost.stat, "function")
    assertEquals(typeof denoFsHost.writeFile, "function")
    assertEquals(typeof denoFsHost.open, "function")
  })

  it("plans no directory for a bare destination filename", () => {
    // The observable half of the fix that needs no permission: a bare
    // destination must not resolve to a bogus parent directory.
    assertEquals(parentDirectory("photo.png"), undefined)
    assertEquals(parentDirectory("out.pn"), undefined)
  })
})

describe("parseStorageEnv", () => {
  it("returns undefined when no provider is configured", () => {
    assertEquals(parseStorageEnv({}), undefined)
    assertEquals(parseStorageEnv(asEnv({ [StorageEnvName.Provider]: "" })), undefined)
  })

  it("rejects an unknown provider", () => {
    const error = (() => {
      try {
        parseStorageEnv(asEnv({ [StorageEnvName.Provider]: "gcs" }))
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_config")
  })

  it("requires a bucket", () => {
    const error = (() => {
      try {
        parseStorageEnv(asEnv({ [StorageEnvName.Provider]: "local" }))
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_config")
  })

  it("parses a local configuration without S3 credentials", () => {
    assertEquals(
      parseStorageEnv(
        asEnv({ [StorageEnvName.Provider]: "local", [StorageEnvName.Bucket]: "examplebucket" }),
      ),
      { bucket: "examplebucket" },
    )
  })

  it("parses a local base path override", () => {
    assertEquals(
      parseStorageEnv(asEnv({
        [StorageEnvName.Provider]: "local",
        [StorageEnvName.Bucket]: "examplebucket",
        [StorageEnvName.LocalPath]: "/srv/storage",
      })),
      { bucket: "examplebucket", localPath: "/srv/storage" },
    )
  })

  it("parses an S3 configuration with a placeholder endpoint", () => {
    assertEquals(
      parseStorageEnv(asEnv({
        [StorageEnvName.Provider]: "s3",
        [StorageEnvName.Bucket]: "examplebucket",
        [StorageEnvName.S3Region]: "eu-central-1",
        [StorageEnvName.S3Endpoint]: MINIO_ENDPOINT,
        [StorageEnvName.S3AccessKeyId]: CREDENTIALS.accessKeyId,
        [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
        [StorageEnvName.S3ForcePathStyle]: "true",
        [StorageEnvName.S3ExpiresIn]: "120",
      })),
      {
        bucket: "examplebucket",
        s3: {
          region: "eu-central-1",
          endpoint: MINIO_ENDPOINT,
          accessKeyId: CREDENTIALS.accessKeyId,
          secretAccessKey: CREDENTIALS.secretAccessKey,
          forcePathStyle: true,
          expiresIn: 120,
        },
      },
    )
  })

  it("requires the S3 region and both keys", () => {
    const base = {
      [StorageEnvName.Provider]: "s3",
      [StorageEnvName.Bucket]: "examplebucket",
    }

    for (
      const missing of [
        StorageEnvName.S3Region,
        StorageEnvName.S3AccessKeyId,
        StorageEnvName.S3SecretAccessKey,
      ]
    ) {
      const environment = asEnv({ ...base, [missing]: undefined })
      assertEquals(
        (() => {
          try {
            parseStorageEnv(environment)
            return undefined
          } catch (caught) {
            return (caught as StorageError).code
          }
        })(),
        "invalid_config",
        `${missing} must be required`,
      )
    }
  })

  it("requires both S3 keys to be non-empty, not merely absent", () => {
    const environment = asEnv({
      [StorageEnvName.Provider]: "s3",
      [StorageEnvName.Bucket]: "examplebucket",
      [StorageEnvName.S3Region]: "eu-central-1",
      [StorageEnvName.S3AccessKeyId]: "",
      [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
    })

    const error = (() => {
      try {
        parseStorageEnv(environment)
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_config")
    assert(error?.message.includes(StorageEnvName.S3AccessKeyId))
  })

  it("parses an explicit false path-style flag as false", () => {
    for (const value of ["0", "false"]) {
      const parsed = parseStorageEnv(asEnv({
        [StorageEnvName.Provider]: "s3",
        [StorageEnvName.Bucket]: "examplebucket",
        [StorageEnvName.S3Region]: "eu-central-1",
        [StorageEnvName.S3AccessKeyId]: CREDENTIALS.accessKeyId,
        [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
        [StorageEnvName.S3ForcePathStyle]: value,
      }))

      assertEquals(parsed?.s3?.forcePathStyle, false, `${value} must parse as false`)
    }
  })

  it("rejects a non-numeric, zero or over-long expiry", () => {
    const base = {
      [StorageEnvName.Provider]: "s3",
      [StorageEnvName.Bucket]: "examplebucket",
      [StorageEnvName.S3Region]: "eu-central-1",
      [StorageEnvName.S3AccessKeyId]: CREDENTIALS.accessKeyId,
      [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
    }

    for (const value of ["abc", "1h", "-1", "0", "604801", "1.5", ""]) {
      assertEquals(
        (() => {
          try {
            parseStorageEnv(asEnv({ ...base, [StorageEnvName.S3ExpiresIn]: value }))
            return undefined
          } catch (caught) {
            return (caught as StorageError).code
          }
        })(),
        "invalid_expiry",
        `${value} must be rejected`,
      )
    }
    // An empty value is rejected too, never read as "use the default": an
    // unset variable and a typo both produce an empty string, and silently
    // defaulting hides the typo.
    assertEquals(
      (() => {
        try {
          parseStorageEnv(asEnv({ ...base, [StorageEnvName.S3ExpiresIn]: "" }))
          return undefined
        } catch (caught) {
          return (caught as StorageError).code
        }
      })(),
      "invalid_expiry",
    )
  })

  it("rejects a non-boolean path-style flag", () => {
    const error = (() => {
      try {
        parseStorageEnv(asEnv({
          [StorageEnvName.Provider]: "s3",
          [StorageEnvName.Bucket]: "examplebucket",
          [StorageEnvName.S3Region]: "eu-central-1",
          [StorageEnvName.S3AccessKeyId]: CREDENTIALS.accessKeyId,
          [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
          [StorageEnvName.S3ForcePathStyle]: "yes",
        }))
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_config")
  })
})

describe("parseExpiresIn", () => {
  it("accepts a decimal integer within range", () => {
    assertEquals(parseExpiresIn("900"), 900)
    assertEquals(parseExpiresIn(900), 900)
    assertEquals(
      parseExpiresIn(String(MAX_PRESIGN_EXPIRES_IN_SECONDS)),
      MAX_PRESIGN_EXPIRES_IN_SECONDS,
    )
  })

  it("returns undefined when unset", () => {
    assertEquals(parseExpiresIn(undefined), undefined)
  })

  it("rejects a value Number() would silently coerce", () => {
    for (const value of ["", " 900", "900 ", "0x10", "1e3", "abc"]) {
      const error = (() => {
        try {
          parseExpiresIn(value)
          return undefined
        } catch (caught) {
          return caught as StorageError
        }
      })()

      assertEquals(error?.code, "invalid_expiry", `${value} must be rejected`)
    }
  })
})

describe("formatAmzDate", () => {
  it("formats an instant as an ISO basic timestamp", () => {
    assertEquals(formatAmzDate(new Date("2026-01-02T03:04:05Z")), "20260102T030405Z")
  })

  it("rejects an invalid clock reading", () => {
    assertEquals(
      (() => {
        try {
          formatAmzDate(new Date("nonsense"))
          return undefined
        } catch (caught) {
          return (caught as StorageError).code
        }
      })(),
      "invalid_config",
    )
  })
})

describe("bucket binding", () => {
  it("forwards every call with the bound bucket and drops the argument", async () => {
    const { fetch: fetchImpl, calls } = fakeFetch((_url, init) =>
      init?.method === "GET" ? bodyResponse([BINARY_PAYLOAD]) : new Response(null, { status: 200 })
    )
    const storage = createBucketStorage({
      bucket: "examplebucket",
      provider: makeS3Storage({ fetch: fetchImpl, fs: createMemoryObjectFs() }),
    })

    const uploadUrl = await storage.getUploadURL("photo.png")
    const downloadUrl = await storage.getDownloadURL("photo.png")
    await storage.upload("photo.png", BINARY_PAYLOAD)
    const written = await storage.download(
      "photo.png",
      "/tmp/photo.png",
    )
    const exists = await storage.doesExist("photo.png")

    assertEquals(new URL(uploadUrl).host, "examplebucket.s3.eu-central-1.amazonaws.com")
    assertEquals(new URL(uploadUrl).pathname, "/photo.png")
    assertEquals(new URL(downloadUrl).pathname, "/photo.png")
    assertEquals(written, BINARY_PAYLOAD.byteLength)
    assertEquals(exists, true)
    assertEquals(calls.length, 3)
    assert(calls.every((call) => call.url.includes("examplebucket")), "the bound bucket")
  })

  it("forwards a per-call ACL opt-in to the provider", async () => {
    const storage = createBucketStorage({
      bucket: "examplebucket",
      provider: makeS3Storage(),
    })

    const url = await storage.getUploadURL("photo.png", { acl: "public-read" })

    assertEquals(new URL(url).searchParams.get("x-amz-acl"), "public-read")
  })

  it("rejects an empty bucket", () => {
    const error = (() => {
      try {
        createBucketStorage({ bucket: "", provider: makeS3Storage() })
        return undefined
      } catch (caught) {
        return caught as StorageError
      }
    })()

    assertEquals(error?.code, "invalid_bucket")
  })
})

describe("loadStorageProvider", () => {
  it("loads the local provider by dynamic import", async () => {
    const provider = await loadStorageProvider("local")

    assert(provider instanceof LocalStorage)
  })

  it("loads the local provider with the base path it is given", async () => {
    const provider = await loadStorageProvider("local", { localPath: "/srv/storage" })

    assert(provider instanceof LocalStorage)
    assertEquals(provider.basePath, "/srv/storage")
  })

  it("loads the S3 provider from the configuration it is given", async () => {
    const provider = await loadStorageProvider("s3", {
      s3: {
        region: "eu-central-1",
        endpoint: MINIO_ENDPOINT,
        clock: () => FIXED_NOW,
        ...CREDENTIALS,
      },
    })

    assert(provider instanceof S3Storage)
    const url = await provider.getUploadURL("examplebucket", "photo.png")
    assertEquals(new URL(url).host, "127.0.0.1:9000")
    assertEquals(new URL(url).searchParams.get("x-amz-acl"), null)
  })

  it("refuses to build the S3 provider without configuration", async () => {
    await rejectsWithCode("invalid_config", () => loadStorageProvider("s3"))
  })

  it("throws on an unknown provider name instead of falling back to local", async () => {
    const error = await rejectsWithCode(
      "invalid_config",
      () => loadStorageProvider("gcs" as never),
    )

    assert(error.message.includes("Unknown storage provider"))
  })
})

describe("createStorageFrom", () => {
  it("returns undefined for an absent configuration", async () => {
    assertEquals(await createStorageFrom(undefined), undefined)
  })

  it("binds a local provider to the configured bucket", async () => {
    const storage = await createStorageFrom({ bucket: "examplebucket", localPath: "/srv/storage" })

    assertEquals(storage?.bucket, "examplebucket")
    assert(storage?.provider instanceof LocalStorage)
  })

  it("binds an S3 provider when S3 configuration is present", async () => {
    const storage = await createStorageFrom({
      bucket: "examplebucket",
      s3: { region: "eu-central-1", endpoint: AWS_ENDPOINT, ...CREDENTIALS },
    })

    assert(storage?.provider instanceof S3Storage)
    assertEquals(storage?.bucket, "examplebucket")
  })
})

describe("createStorage", () => {
  it("reads no environment when none is configured", async () => {
    assertEquals(await createStorage({}), undefined)
  })

  it("builds from an explicit environment record", async () => {
    const storage = await createStorage(asEnv({
      [StorageEnvName.Provider]: "s3",
      [StorageEnvName.Bucket]: "examplebucket",
      [StorageEnvName.S3Region]: "eu-central-1",
      [StorageEnvName.S3Endpoint]: MINIO_ENDPOINT,
      [StorageEnvName.S3AccessKeyId]: CREDENTIALS.accessKeyId,
      [StorageEnvName.S3SecretAccessKey]: CREDENTIALS.secretAccessKey,
    }))

    assert(storage?.provider instanceof S3Storage)
    const url = await storage.getUploadURL("photo.png")
    assertEquals(new URL(url).host, "127.0.0.1:9000")
    assertEquals(new URL(url).searchParams.get("x-amz-acl"), null)
  })

  it("imports and configures without touching the real environment", async () => {
    const storage = await createStorage()

    assertEquals(storage === undefined || typeof storage.getUploadURL === "function", true)
  })

  it("names every variable it reads", () => {
    const names = storageEnvNames()

    assert(names.includes(StorageEnvName.Provider))
    assert(names.includes(StorageEnvName.S3AccessKeyId))
    assertEquals(names.length, Object.values(StorageEnvName).length)
  })
})

/** The port is exported as a type: this pins that a caller can implement it. */
describe("FileStorage port", () => {
  it("is implementable by a caller's own provider", async () => {
    const seen: string[] = []
    const provider: import("./storage/ports.ts").FileStorage = {
      getUploadURL: (bucket, path) => Promise.resolve(`custom://${bucket}/${path}`),
      getDownloadURL: (bucket, path) => Promise.resolve(`custom://${bucket}/${path}`),
      upload: (bucket, path) => {
        seen.push(`${bucket}/${path}`)
        return Promise.resolve()
      },
      download: () => Promise.resolve(0),
      doesExist: () => Promise.resolve(false),
    }
    const storage = createBucketStorage({ bucket: "examplebucket", provider })

    await storage.upload("photo.png", BINARY_PAYLOAD)

    assertEquals(seen, ["examplebucket/photo.png"])
    assertEquals(await storage.getDownloadURL("photo.png"), "custom://examplebucket/photo.png")
  })

  it("types the filesystem port so a fake satisfies the provider", () => {
    const fake: ObjectFs = createMemoryObjectFs()

    assertEquals(typeof fake.writeObject, "function")
  })
})
