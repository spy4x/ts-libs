import { assert, assertEquals, assertRejects } from "@std/assert"
import { encodeHex } from "@std/encoding/hex"
import { describe, it } from "@std/testing/bdd"
import { sha256Hex } from "@spy4x/platform/tokens"
import { StorageError } from "./errors.ts"
import { S3Storage } from "./s3.ts"
import { deriveSigningKey, signS3Request } from "./sigv4.ts"

/** The AWS documentation's example credentials. */
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
}
const FIXED_NOW = new Date("2026-01-02T03:04:05Z")
const GARAGE_ENDPOINT = "http://garage.internal:3900"

/** A fetch double that records every call. Nothing in this file opens a socket. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }
  return { fetch: impl as typeof fetch, calls }
}

/** A path-style provider on a Garage-like endpoint, with a pinned clock. */
function garage(fetchImpl: typeof fetch = fakeFetch(() => new Response(null)).fetch) {
  return new S3Storage({
    region: "garage",
    ...CREDENTIALS,
    endpoint: GARAGE_ENDPOINT,
    forcePathStyle: true,
    clock: () => FIXED_NOW,
    fetch: fetchImpl,
  })
}

async function hmac(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(key).slice(),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return encodeHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))),
  )
}

describe("SigV4 signing", () => {
  it("derives the signing key of the published AWS example", async () => {
    // https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
    const key = await deriveSigningKey(
      "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      "20120215",
      "us-east-1",
      "iam",
    )
    assertEquals(
      encodeHex(key),
      "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d",
    )
  })

  it("signs extra headers exactly as a canonical request written out by hand", async () => {
    const url = new URL(
      await signS3Request({
        method: "PUT",
        endpoint: "https://examplebucket.s3.amazonaws.com",
        key: "photo.png",
        region: "us-east-1",
        credentials: CREDENTIALS,
        expiresIn: 300,
        now: new Date("2013-05-24T00:00:00Z"),
        headers: { "content-type": " image/png ", "content-length": "1024" },
      }),
    )
    const query = "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
      "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&" +
      "X-Amz-Date=20130524T000000Z&X-Amz-Expires=300&" +
      "X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost"
    const canonicalRequest = [
      "PUT",
      "/photo.png",
      query,
      "content-length:1024",
      "content-type:image/png",
      "host:examplebucket.s3.amazonaws.com",
      "",
      "content-length;content-type;host",
      "UNSIGNED-PAYLOAD",
    ].join("\n")
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      "20130524T000000Z",
      "20130524/us-east-1/s3/aws4_request",
      await sha256Hex(canonicalRequest),
    ].join("\n")
    const key = await deriveSigningKey(CREDENTIALS.secretAccessKey, "20130524", "us-east-1", "s3")

    assertEquals(url.search, `?${query}&X-Amz-Signature=${await hmac(key, stringToSign)}`)
  })

  it("refuses to sign host again, an uppercase name or a value with a line break", async () => {
    const invalid: Record<string, string>[] = [
      { host: "evil" },
      { "Content-Type": "a" },
      { "x-a": "a\r\nb: c" },
    ]
    for (const headers of invalid) {
      await assertRejects(
        () =>
          signS3Request({
            method: "PUT",
            endpoint: GARAGE_ENDPOINT,
            key: "b/k",
            region: "garage",
            credentials: CREDENTIALS,
            expiresIn: 60,
            now: FIXED_NOW,
            headers,
          }),
        StorageError,
        "Invalid header to sign",
      )
    }
  })
})

describe("S3Storage.presignPut", () => {
  it("signs the content type and the exact length into the URL", async () => {
    const url = new URL(
      await garage().presignPut("uploads", "u1/avatar.png", {
        contentType: "image/png",
        contentLength: 2048,
        expiresIn: 300,
      }),
    )
    assertEquals(url.origin + url.pathname, `${GARAGE_ENDPOINT}/uploads/u1/avatar.png`)
    assertEquals(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host")
    assertEquals(url.searchParams.get("X-Amz-Expires"), "300")
    assertEquals(url.searchParams.get("x-amz-acl"), null)
  })

  it("gives a different signature for a different type or length", async () => {
    const sign = async (contentType: string, contentLength: number) =>
      new URL(await garage().presignPut("uploads", "a.png", { contentType, contentLength }))
        .searchParams.get("X-Amz-Signature")
    const base = await sign("image/png", 10)
    assert(base !== await sign("text/html", 10))
    assert(base !== await sign("image/png", 11))
  })

  it("rejects an empty type and a length that is not a whole non-negative number", async () => {
    for (
      const options of [
        { contentType: " ", contentLength: 1 },
        { contentType: "image/png", contentLength: -1 },
        { contentType: "image/png", contentLength: 1.5 },
        { contentType: "image/png", contentLength: Number.NaN },
      ]
    ) {
      await assertRejects(() => garage().presignPut("uploads", "a.png", options), StorageError)
    }
  })
})

describe("S3Storage.presignGet", () => {
  it("signs the response type and disposition the store must answer with", async () => {
    const url = new URL(
      await garage().presignGet("uploads", "u1/report.pdf", {
        responseContentType: "application/pdf",
        responseContentDisposition: `attachment; filename="report.pdf"`,
      }),
    )
    assertEquals(url.searchParams.get("response-content-type"), "application/pdf")
    assertEquals(
      url.searchParams.get("response-content-disposition"),
      `attachment; filename="report.pdf"`,
    )
    assertEquals(url.searchParams.get("X-Amz-SignedHeaders"), "host")
  })

  it("leaves both response parameters out when none is asked for", async () => {
    const url = new URL(await garage().presignGet("uploads", "a.txt"))
    assertEquals(url.searchParams.has("response-content-type"), false)
    assertEquals(url.searchParams.has("response-content-disposition"), false)
  })
})

describe("S3Storage.head", () => {
  it("reports size, type, entity tag and date from a HEAD request", async () => {
    const { fetch, calls } = fakeFetch(() =>
      new Response(null, {
        headers: {
          "content-length": "42",
          "content-type": "image/png",
          etag: `"abc"`,
          "last-modified": "Fri, 02 Jan 2026 03:04:05 GMT",
        },
      })
    )
    const info = await garage(fetch).head("uploads", "a.png")

    assertEquals(info, {
      size: 42,
      contentType: "image/png",
      etag: `"abc"`,
      lastModified: new Date("2026-01-02T03:04:05Z"),
    })
    assertEquals(calls[0].init?.method, "HEAD")
  })

  it("returns null for a missing object and throws for a denied one", async () => {
    const missing = fakeFetch(() => new Response(null, { status: 404 }))
    assertEquals(await garage(missing.fetch).head("uploads", "gone.png"), null)

    const denied = fakeFetch(() => new Response(null, { status: 403 }))
    const error = await assertRejects(() => garage(denied.fetch).head("uploads", "a.png"))
    assert(error instanceof StorageError)
    assertEquals(error.status, 403)
  })
})

describe("S3Storage.getRange", () => {
  it("asks for the inclusive byte range and returns those bytes", async () => {
    const { fetch, calls } = fakeFetch(() =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 206 })
    )
    const bytes = await garage(fetch).getRange("uploads", "a.png", 0, 3)

    assertEquals(bytes, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    assertEquals(new Headers(calls[0].init?.headers).get("range"), "bytes=0-3")
  })

  it("keeps only the range when a store ignores Range and sends the whole object", async () => {
    let cancelled = false
    const whole = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 1, 2, 3]))
        controller.enqueue(new Uint8Array([4, 5, 6, 7]))
      },
      cancel() {
        cancelled = true
      },
    })
    const { fetch } = fakeFetch(() => new Response(whole, { status: 200 }))

    assertEquals(
      await garage(fetch).getRange("uploads", "a.bin", 2, 5),
      new Uint8Array([2, 3, 4, 5]),
    )
    assert(cancelled, "the rest of the body must not be read")
  })

  it("reads a range past the end of the object as no bytes", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 416 }))
    assertEquals(await garage(fetch).getRange("uploads", "empty", 0, 15), new Uint8Array(0))
  })

  it("rejects a range that ends before it starts", async () => {
    await assertRejects(
      () => garage().getRange("uploads", "a", 5, 4),
      StorageError,
      "range must be integers",
    )
  })
})

describe("S3Storage.delete", () => {
  it("sends a DELETE and accepts a missing object", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 404 }))
    await garage(fetch).delete("uploads", "gone.png")

    assertEquals(calls[0].init?.method, "DELETE")
    assertEquals(new URL(calls[0].url).pathname, "/uploads/gone.png")
  })

  it("throws when the store refuses the delete", async () => {
    const { fetch } = fakeFetch(() => new Response(null, { status: 500 }))
    await assertRejects(() => garage(fetch).delete("uploads", "a.png"), StorageError, "HTTP 500")
  })
})

describe("S3Storage.copy", () => {
  it("sends a signed PUT to the target that names the encoded source", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("<CopyObjectResult/>"))
    await garage(fetch).copy("uploads", "tmp/a b.png", "final/a.png")

    const url = new URL(calls[0].url)
    assertEquals(calls[0].init?.method, "PUT")
    assertEquals(url.pathname, "/uploads/final/a.png")
    assertEquals(url.searchParams.get("X-Amz-SignedHeaders"), "host;x-amz-copy-source")
    assertEquals(
      new Headers(calls[0].init?.headers).get("x-amz-copy-source"),
      "/uploads/tmp/a%20b.png",
    )
  })

  it("throws when the store refuses the copy or answers 200 with an error", async () => {
    const missing = fakeFetch(() => new Response(null, { status: 404 }))
    await assertRejects(
      () => garage(missing.fetch).copy("uploads", "gone.png", "b.png"),
      StorageError,
      "HTTP 404",
    )

    const failed = fakeFetch(() =>
      new Response("<Error><Code>InternalError</Code><Message>try again</Message></Error>")
    )
    await assertRejects(
      () => garage(failed.fetch).copy("uploads", "a.png", "b.png"),
      StorageError,
      "InternalError: try again",
    )
  })

  it("rejects a source path that climbs out of the bucket", async () => {
    await assertRejects(
      () => garage().copy("uploads", "../other/a.png", "b.png"),
      StorageError,
      "Object path must be relative",
    )
  })
})

describe("S3Storage.list", () => {
  const PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>uploads</Name><Prefix>u1/</Prefix><KeyCount>2</KeyCount><MaxKeys>2</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <Contents><Key>u1/a&amp;b.png</Key><LastModified>2026-01-02T03:04:05.000Z</LastModified>
    <ETag>&quot;e1&quot;</ETag><Size>10</Size><StorageClass>STANDARD</StorageClass></Contents>
  <Contents><Key>u1/&#x444;.txt</Key><Size>0</Size></Contents>
  <NextContinuationToken>next&#43;page</NextContinuationToken>
</ListBucketResult>`

  it("lists one page under a prefix and returns the token for the next", async () => {
    const { fetch, calls } = fakeFetch(() => new Response(PAGE))
    const page = await garage(fetch).list("uploads", "u1/", { maxKeys: 2 })

    assertEquals(page, {
      objects: [
        {
          key: "u1/a&b.png",
          size: 10,
          etag: `"e1"`,
          lastModified: new Date("2026-01-02T03:04:05Z"),
        },
        { key: "u1/ф.txt", size: 0 },
      ],
      continuationToken: "next+page",
    })
    const url = new URL(calls[0].url)
    assertEquals(url.pathname, "/uploads")
    assertEquals(url.searchParams.get("list-type"), "2")
    assertEquals(url.searchParams.get("prefix"), "u1/")
    assertEquals(url.searchParams.get("max-keys"), "2")
  })

  it("sends the continuation token back and stops at the last page", async () => {
    const last = PAGE.replace("<IsTruncated>true</IsTruncated>", "<IsTruncated>false</IsTruncated>")
    const { fetch, calls } = fakeFetch(() => new Response(last))
    const page = await garage(fetch).list("uploads", "u1/", { continuationToken: "next+page" })

    assertEquals(page.continuationToken, undefined)
    assertEquals(new URL(calls[0].url).searchParams.get("continuation-token"), "next+page")
  })

  it("lists from the bucket host's root with virtual-hosted addressing", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("<ListBucketResult/>"))
    const provider = new S3Storage({
      region: "eu-central-1",
      ...CREDENTIALS,
      clock: () => FIXED_NOW,
      fetch,
    })
    assertEquals(await provider.list("uploads", ""), { objects: [] })

    const url = new URL(calls[0].url)
    assertEquals(url.host, "uploads.s3.eu-central-1.amazonaws.com")
    assertEquals(url.pathname, "/")
  })

  it("rejects a page size outside 1 to 1000", async () => {
    for (const maxKeys of [0, 1001, 2.5]) {
      await assertRejects(() => garage().list("uploads", "", { maxKeys }), StorageError)
    }
  })
})

describe("S3Storage failure messages", () => {
  it("carry the store's error code and message, never the rest of its error body", async () => {
    const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SignatureDoesNotMatch</Code>` +
      `<Message>The request signature we calculated does not match</Message>` +
      `<AWSAccessKeyId>AKIAIOSFODNN7EXAMPLE</AWSAccessKeyId>` +
      `<StringToSign>AWS4-HMAC-SHA256 20260102T030405Z</StringToSign>` +
      `<SignatureProvided>0123abcd</SignatureProvided></Error>`
    const { fetch } = fakeFetch(() => new Response(body, { status: 403 }))
    const error = await assertRejects(() => garage(fetch).delete("uploads", "a.png"))

    assert(error instanceof StorageError)
    assertEquals(
      error.message,
      "delete failed for uploads/a.png with HTTP 403: SignatureDoesNotMatch: " +
        "The request signature we calculated does not match",
    )
  })
})
