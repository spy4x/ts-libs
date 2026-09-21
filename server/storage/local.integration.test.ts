/**
 * `LocalStorage` and `S3Storage.download` against real disk I/O (#58, #74).
 *
 * `server/storage.test.ts` drives `LocalStorage` and `createDenoObjectFs` entirely
 * through `createMemoryObjectFs`, because the unit tier grants neither
 * `--allow-write` nor `--allow-net`. This file exercises the real `Deno` I/O path —
 * `createDenoObjectFs()` with no injected host, writing under a scratch folder the
 * integration tier is allowed to touch — and one `S3Storage.download()` against
 * MinIO, so a response body is streamed to a real file rather than the in-memory
 * fake.
 *
 * `createScratchFolder`/`removeScratchFolder` (`@integration-testing`) are the one
 * way into a real folder here: `Deno.makeTempDir()` writes outside `.volumes` and
 * stays refused under the tier's `--allow-write=.volumes` grant.
 */

import { assertEquals } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  createScratchFolder,
  deleteObject,
  ensureBucket,
  removeScratchFolder,
  requireReachable,
  s3Settings,
  uniqueKeyPrefix,
} from "@integration-testing"
import { LocalStorage } from "./local.ts"
import { S3Storage } from "./s3.ts"

describe("LocalStorage against a real filesystem", () => {
  it("writes and reads an object through real disk I/O", async () => {
    const folder = await createScratchFolder("it_local_storage")
    try {
      const provider = new LocalStorage({ basePath: folder })
      const payload = new TextEncoder().encode("hello from a real disk")

      await provider.upload("examplebucket", "greeting.txt", payload)
      const written = await provider.download(
        "examplebucket",
        "greeting.txt",
        `${folder}/round-trip.txt`,
      )

      assertEquals(written, payload.byteLength)
      assertEquals(await Deno.readFile(`${folder}/round-trip.txt`), payload)
      assertEquals(await provider.doesExist("examplebucket", "greeting.txt"), true)
      assertEquals(await provider.doesExist("examplebucket", "missing.txt"), false)
    } finally {
      await removeScratchFolder(folder)
    }
  })
})

describe("S3Storage.download against a real object store", () => {
  it("streams a real object to a real file", async () => {
    const settings = s3Settings()
    await requireReachable(settings.address)
    await ensureBucket(settings)

    const folder = await createScratchFolder("it_s3_download")
    const key = `${uniqueKeyPrefix("integration")}/photo.bin`
    const payload = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252])
    const storage = new S3Storage({
      region: settings.region,
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      endpoint: settings.endpoint,
      forcePathStyle: true,
    })

    try {
      await storage.upload(settings.bucket, key, payload)
      const destination = `${folder}/photo.bin`

      const written = await storage.download(settings.bucket, key, destination)

      assertEquals(written, payload.byteLength)
      assertEquals(await Deno.readFile(destination), payload)
    } finally {
      await deleteObject(settings, key)
      await removeScratchFolder(folder)
    }
  })
})
