/** Browser-only base64 helpers. Nothing in this module is reachable from `@ts-libs/platform`. */

/**
 * Decode a URL-safe base64 string (no padding, `-`/`_` alphabet) to bytes.
 *
 * This is the input shape a `PushManager.subscribe()` result carries. Decoding happens through
 * `atob`, which is available in Deno, every browser and every web worker — no `Buffer`, no
 * `@std/encoding` dependency for one function.
 *
 * Both padded and unpadded input are accepted. Throws on a malformed string, and on output longer
 * than `atob`'s 65535-code-unit ceiling rather than silently truncating.
 */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  // Existing padding is stripped first: the caller may hand over either form, and echoing "=" onto
  // an already-padded string produces a length `atob` rejects.
  const unpadded = base64Url.replace(/=+$/, "")
  const padding = "=".repeat((4 - (unpadded.length % 4)) % 4)
  const base64 = (unpadded + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = globalThis.atob(base64)
  if (raw.length > 65535) throw new Error("base64 payload is too large for atob")
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i)
  return output
}
