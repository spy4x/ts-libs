/**
 * The object-store smoke test of the integration tier (#74).
 *
 * `server/storage.test.ts` drives `S3Storage` with an injected `fetch`, so the
 * presigned URLs it asserts have never been shown to a server that checks a
 * signature. This test uploads through the adapter's own default `fetch` and reads
 * the bytes back from the URL the adapter signs, against MinIO.
 *
 * Isolation: every object key carries a random prefix, and the object is deleted in
 * a `finally`. The bucket is shared and created on demand, because a bucket is an
 * operator-level object and creating one per run would leave a pile of them behind.
 */

import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  deleteObject,
  ensureBucket,
  requireReachable,
  s3Settings,
  uniqueKeyPrefix,
} from "@integration-testing"
import { S3Storage } from "./s3.ts"

describe("s3 storage against a real object store", () => {
  it("uploads an object and reads the same bytes back from a presigned url", async () => {
    const settings = s3Settings()
    await requireReachable(settings.address)
    await ensureBucket(settings)

    const key = `${uniqueKeyPrefix("integration")}/greeting.txt`
    const payload = new TextEncoder().encode("hello from the integration tier")
    const storage = new S3Storage({
      region: settings.region,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      endpoint: settings.endpoint,
      forcePathStyle: true,
    })

    try {
      await storage.upload(settings.bucket, key, payload)

      const response = await fetch(await storage.getDownloadURL(settings.bucket, key))
      assertEquals(response.status, 200)
      assertEquals(new Uint8Array(await response.arrayBuffer()), payload)
    } finally {
      await deleteObject(settings, key)
    }
  })
})
