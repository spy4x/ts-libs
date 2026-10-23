/**
 * `S3Storage`'s browser-upload and object-management methods against real stores (#738):
 * MinIO, and Garage, the store Seed bundles. `s3.test.ts` pins the URLs with a fake
 * `fetch`; only a store that checks the signature shows the signed headers are enforced.
 *
 * Isolation: every key carries a random prefix and is deleted in a `finally` through the
 * harness's own `deleteObject`, not through the code under test.
 */

import { assert, assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  deleteObject,
  ensureBucket,
  garageSettings,
  requireReachable,
  type S3Settings,
  s3Settings,
  uniqueKeyPrefix,
} from "@integration-testing"
import { S3Storage } from "./s3.ts"

const STORES: [string, () => S3Settings][] = [["MinIO", s3Settings], ["Garage", garageSettings]]

/** Reach the store, make sure its bucket exists, and build a path-style provider. */
async function connect(settings: S3Settings): Promise<S3Storage> {
  await requireReachable(settings.address)
  await ensureBucket(settings)
  return new S3Storage({
    region: settings.region,
    accessKeyId: settings.accessKeyId,
    secretAccessKey: settings.secretAccessKey,
    endpoint: settings.endpoint,
    forcePathStyle: true,
  })
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

for (const [name, settingsOf] of STORES) {
  describe(`S3Storage against ${name}`, () => {
    it("uploads through a presigned PUT, then heads, reads, lists and deletes the object", async () => {
      const settings = settingsOf()
      const storage = await connect(settings)
      const prefix = `${uniqueKeyPrefix("s3client")}/`
      const key = `${prefix}avatar.png`

      try {
        const put = await fetch(
          await storage.presignPut(settings.bucket, key, {
            contentType: "image/png",
            contentLength: PNG.length,
          }),
          { method: "PUT", body: PNG, headers: { "content-type": "image/png" } },
        )
        await put.body?.cancel()
        assertEquals(put.status, 200)

        const info = await storage.head(settings.bucket, key)
        assertEquals(info?.size, PNG.length)
        assertEquals(info?.contentType, "image/png")
        assert(info?.etag !== undefined && info.lastModified instanceof Date)

        assertEquals(await storage.getRange(settings.bucket, key, 0, 3), PNG.slice(0, 4))

        const get = await fetch(
          await storage.presignGet(settings.bucket, key, {
            responseContentType: "application/octet-stream",
            responseContentDisposition: `attachment; filename="avatar.png"`,
          }),
        )
        assertEquals(new Uint8Array(await get.arrayBuffer()), PNG)
        assertEquals(get.headers.get("content-type"), "application/octet-stream")
        assertEquals(get.headers.get("content-disposition"), `attachment; filename="avatar.png"`)

        const page = await storage.list(settings.bucket, prefix)
        assertEquals(page.objects.map((object) => [object.key, object.size]), [[key, PNG.length]])

        await storage.delete(settings.bucket, key)
        assertEquals(await storage.head(settings.bucket, key), null)
      } finally {
        await deleteObject(settings, key)
      }
    })

    it("refuses a presigned PUT whose type or size differs from the signed one", async () => {
      const settings = settingsOf()
      const storage = await connect(settings)
      const key = `${uniqueKeyPrefix("s3client")}/signed.png`

      try {
        const url = await storage.presignPut(settings.bucket, key, {
          contentType: "image/png",
          contentLength: PNG.length,
        })
        const otherType = await fetch(url, {
          method: "PUT",
          body: PNG,
          headers: { "content-type": "text/html" },
        })
        await otherType.body?.cancel()
        assertEquals(otherType.status, 403)

        const bigger = await fetch(url, {
          method: "PUT",
          body: new Uint8Array(PNG.length + 1),
          headers: { "content-type": "image/png" },
        })
        await bigger.body?.cancel()
        assertEquals(bigger.status, 403)

        assertEquals(await storage.head(settings.bucket, key), null)
      } finally {
        await deleteObject(settings, key)
      }
    })

    it("copies an object to a key the upload URL cannot reach", async () => {
      const settings = settingsOf()
      const storage = await connect(settings)
      const prefix = uniqueKeyPrefix("s3client")
      const staging = `${prefix}/tmp/a b.png`
      const final = `${prefix}/final.png`

      try {
        const url = await storage.presignPut(settings.bucket, staging, {
          contentType: "image/png",
          contentLength: PNG.length,
        })
        const upload = (body: Uint8Array<ArrayBuffer>) =>
          fetch(url, { method: "PUT", body, headers: { "content-type": "image/png" } })
            .then(async (response) => {
              await response.body?.cancel()
              return response.status
            })
        assertEquals(await upload(PNG), 200)

        await storage.copy(settings.bucket, staging, final)
        assertEquals(await upload(new Uint8Array(PNG.length)), 200)

        const info = await storage.head(settings.bucket, final)
        assertEquals([info?.size, info?.contentType], [PNG.length, "image/png"])
        assertEquals(await storage.getRange(settings.bucket, final, 0, PNG.length - 1), PNG)
        await assertRejects(() => storage.copy(settings.bucket, `${prefix}/gone`, final))
      } finally {
        await deleteObject(settings, staging)
        await deleteObject(settings, final)
      }
    })

    it("pages through a prefix with the continuation token", async () => {
      const settings = settingsOf()
      const storage = await connect(settings)
      const prefix = `${uniqueKeyPrefix("s3client")}/`
      const keys = [`${prefix}a.txt`, `${prefix}b.txt`]

      try {
        for (const key of keys) await storage.upload(settings.bucket, key, key)

        const first = await storage.list(settings.bucket, prefix, { maxKeys: 1 })
        assertEquals(first.objects.map((object) => object.key), [keys[0]])
        assert(first.continuationToken !== undefined)

        const second = await storage.list(settings.bucket, prefix, {
          maxKeys: 1,
          continuationToken: first.continuationToken,
        })
        assertEquals(second.objects.map((object) => object.key), [keys[1]])
        assertEquals(second.continuationToken, undefined)
      } finally {
        for (const key of keys) await deleteObject(settings, key)
      }
    })
  })
}
