/**
 * Turn a `Response` body into a file the browser saves.
 *
 * `document` and an object URL are the two things a server cannot provide, so
 * this lives in `@spy4x/platform/browser`, never in `@spy4x/server`. It
 * pairs with the download response `@spy4x/server/export` builds, but the
 * two are separate packages on purpose: a server import must never pull in a
 * DOM type.
 */

/** Minimal document surface this helper needs, so the caller passes its own `document`. */
export interface DownloadDocument {
  createElement: (tagName: "a") => HTMLAnchorElement
  /** Anchor container. The click needs the anchor attached to fire in every browser. */
  body: {
    appendChild: (node: HTMLAnchorElement) => void
    removeChild: (node: HTMLAnchorElement) => void
  }
}

/** Object-URL surface, injected so a test never allocates a real blob URL. */
export interface ObjectUrlAdapter {
  create: (blob: Blob) => string
  revoke: (url: string) => void
}

/** Timer surface, injected so a test never waits on a real delay. */
export interface TimerAdapter {
  /** Schedule `callback` to run after `delayMs` milliseconds. Mirrors `setTimeout`. */
  setTimeout: (callback: () => void, delayMs: number) => unknown
}

/** Everything {@link downloadResponseAsFile} needs; all of it injectable. */
export interface DownloadOptions {
  /** Document that provides the anchor and its container. Defaults to the global `document`. */
  document?: DownloadDocument
  /** Object-URL factory. Defaults to `URL.createObjectURL` / `URL.revokeObjectURL`. */
  objectUrl?: ObjectUrlAdapter
  /** Timer used to defer cleanup past the click. Defaults to the platform `setTimeout`. */
  timer?: TimerAdapter
}

/** Default object-URL adapter over the platform `URL` API. */
const platformObjectUrl: ObjectUrlAdapter = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

/** Default timer adapter over the platform `setTimeout`. */
const platformTimer: TimerAdapter = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
}

/**
 * Delay, in milliseconds, before the object URL is revoked.
 *
 * Not a measured figure: the issue this fixes asked for "a `setTimeout` of a few seconds", and this
 * is a plain reading of that phrase, chosen rather than derived. There is no single reference value
 * to match — FileSaver.js 2.0.5 waits 40 000 ms before revoking, at the far end of what a common
 * implementation does. Five seconds sits inside that spread: long enough for the browser to start
 * reading the blob on a slow machine, short enough that the blob does not outlive the click by much.
 */
const REVOKE_DELAY_MS = 5000

/**
 * Save a response body to disk under `filename`.
 *
 * Reads the body into a `Blob`, hands it to an object URL, and clicks a synthetic anchor built from
 * it. The anchor is attached to the document before the click and detached right after, in the same
 * task, because some browsers never fire a download for an anchor that was never in the document —
 * and because attaching and detaching both happen inside the `try`, a document whose `body` refuses
 * either call still reaches the `finally` below rather than leaking the object URL created one line
 * earlier. The object URL itself is revoked from a later task through the injected timer, not in the
 * click's own task: revoking too early has historically cancelled a download that was still
 * starting. Revoking is the one thing the `finally` always does, even if attaching or detaching the
 * anchor throws, so a DOM call failing never leaves the blob pinned for the page's lifetime.
 *
 * @param response Response whose body should be saved. Consumed by this call.
 * @param filename Value for the anchor's `download` attribute. The export
 * endpoint's `Content-Disposition` is a suggestion; this attribute is what the
 * browser obeys.
 * @param options Injected `document`, object-URL adapter and timer. All three default to the
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
  const timer = options.timer ?? platformTimer

  const blob = await response.blob()
  const url = objectUrl.create(blob)
  try {
    const anchor = doc.createElement("a")
    anchor.href = url
    anchor.download = filename
    try {
      doc.body.appendChild(anchor)
      anchor.click()
    } finally {
      doc.body.removeChild(anchor)
    }
  } finally {
    timer.setTimeout(() => {
      objectUrl.revoke(url)
    }, REVOKE_DELAY_MS)
  }
}
