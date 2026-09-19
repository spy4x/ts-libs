/**
 * Client-side half of a data export: turn a response body into a saved file.
 *
 * Browser-only. `document` and an object URL are the two things a server cannot
 * provide, so this module lives behind its own subpath
 * (`@ts-libs/server/export-client`) and is never reachable from a server import.
 * The server-side envelope and header builder is `server/export.ts`.
 */

/** Minimal document surface this helper needs, so the caller passes its own `document`. */
export interface DownloadDocument {
  createElement: (tagName: "a") => HTMLAnchorElement
}

/** Object-URL surface, injected so a test never allocates a real blob URL. */
export interface ObjectUrlAdapter {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

/** Everything {@link downloadResponseAsFile} needs; all of it injectable. */
export interface DownloadOptions {
  /** Document that provides the anchor. Defaults to the global `document`. */
  document?: DownloadDocument
  /** Object-URL factory. Defaults to `URL.createObjectURL` / `URL.revokeObjectURL`. */
  objectUrl?: ObjectUrlAdapter
}

/** Default object-URL adapter over the platform `URL` API. */
const platformObjectUrl: ObjectUrlAdapter = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

/**
 * Save a response body to disk under `filename`.
 *
 * Reads the body into a `Blob`, hands it to an object URL, clicks a synthetic
 * anchor, and revokes the URL. The revoke is in a `finally`, so a document that
 * refuses the click does not leak the blob for the lifetime of the page.
 *
 * @param response Response whose body should be saved. Consumed by this call.
 * @param filename Value for the anchor's `download` attribute. The export
 * endpoint's `Content-Disposition` is a suggestion; this attribute is what the
 * browser obeys.
 * @param options Injected `document` and object-URL adapter. Both default to the
 * platform globals; injecting them is what makes this testable under
 * `deno test --allow-read --allow-env`.
 */
export async function downloadResponseAsFile(
  response: Response,
  filename: string,
  options: DownloadOptions = {},
): Promise<void> {
  const doc = options.document ?? (globalThis as { document?: DownloadDocument }).document
  if (!doc) {
    throw new Error("downloadResponseAsFile needs a document; pass one in a non-DOM runtime")
  }
  const objectUrl = options.objectUrl ?? platformObjectUrl

  const blob = await response.blob()
  const url = objectUrl.create(blob)
  try {
    const anchor = doc.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    objectUrl.revoke(url)
  }
}
