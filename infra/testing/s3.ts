/**
 * The two bucket operations an integration test needs and `FileStorage` does not
 * offer: create the shared bucket if it is missing, and delete an object again.
 *
 * Both go through the library's own `signS3Request`, so the tier still adds no
 * dependency and no second signing implementation. The port deliberately has no
 * `createBucket` and no `delete` — those are an operator's job, not an upload
 * path's — which is why they live here rather than being added to it.
 *
 * Path-style addressing throughout: MinIO on a loopback address cannot resolve a
 * bucket as a subdomain.
 */

import { signS3Request } from "@spy4x/server/storage"
import type { S3Settings } from "./services.ts"

/** Lifetime of a presigned URL used inside one test. Seconds, not hours. */
const PRESIGN_SECONDS = 60

function presign(
  settings: S3Settings,
  method: "PUT" | "DELETE",
  key: string,
): Promise<string> {
  return signS3Request({
    method,
    endpoint: settings.endpoint,
    key,
    region: settings.region,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    expiresIn: PRESIGN_SECONDS,
    now: new Date(),
  })
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

/**
 * Create the bucket the integration tier shares, unless it already exists.
 *
 * Idempotent on purpose: every run calls it, and runs overlap. S3 answers a repeat
 * with `409 BucketAlreadyOwnedByYou`, which is success here.
 */
export async function ensureBucket(settings: S3Settings): Promise<void> {
  const response = await fetch(await presign(settings, "PUT", settings.bucket), { method: "PUT" })
  if (response.ok || response.status === 409) {
    await discard(response)
    return
  }
  const detail = await response.text().catch(() => "")
  throw new Error(
    `Creating bucket ${settings.bucket} on ${settings.endpoint} failed with ` +
      `HTTP ${response.status}: ${detail.slice(0, 200)}`,
  )
}

/**
 * Delete one object. Deleting an object that is not there succeeds, so a cleanup
 * step is safe to run after a test that failed before it wrote anything.
 */
export async function deleteObject(settings: S3Settings, key: string): Promise<void> {
  const response = await fetch(
    await presign(settings, "DELETE", `${settings.bucket}/${key}`),
    { method: "DELETE" },
  )
  if (!response.ok && response.status !== 404) {
    const detail = await response.text().catch(() => "")
    throw new Error(
      `Deleting ${settings.bucket}/${key} failed with HTTP ${response.status}: ` +
        detail.slice(0, 200),
    )
  }
  await discard(response)
}
