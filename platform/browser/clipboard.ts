/**
 * Put text on the clipboard, with the legacy fallback an insecure origin still needs.
 *
 * Nothing here reads a global at import time: the clipboard and the document are parameters, read
 * from `navigator.clipboard` and `document` only when the caller passes neither, so the module is
 * safe to import during a server render and testable with fakes.
 *
 * @module
 */

/** The one clipboard method this helper calls. `navigator.clipboard` satisfies it. */
export interface ClipboardWriter {
  writeText(text: string): Promise<void>
}

/** The document surface the legacy `execCommand("copy")` path needs. `document` satisfies it. */
export interface ClipboardDocument {
  createElement(tagName: "textarea"): HTMLTextAreaElement
  body: {
    appendChild(node: HTMLTextAreaElement): unknown
    removeChild(node: HTMLTextAreaElement): unknown
  }
  execCommand(commandId: "copy"): boolean
}

/** Where {@link copyToClipboard} writes. Each field: `undefined` reads the global, `null` means none. */
export interface CopyToClipboardOptions {
  /** Async Clipboard API. Defaults to `navigator.clipboard`. */
  clipboard?: ClipboardWriter | null
  /** Document for the legacy path. Defaults to the global `document`. */
  document?: ClipboardDocument | null
}

/**
 * Write `text` to the clipboard, and say whether it got there.
 *
 * The Async Clipboard API is tried first. When it is missing, or it rejects — a denied permission,
 * an insecure origin — the text is copied the old way: an off-screen read-only `<textarea>`, a
 * selection and `document.execCommand("copy")`, removed again whatever happens. Never throws.
 *
 * @param text Text to place on the clipboard.
 * @param options Injected clipboard and document; both default to the browser's own.
 * @returns `true` when one of the two paths reported success, `false` when neither could.
 */
export async function copyToClipboard(
  text: string,
  options: CopyToClipboardOptions = {},
): Promise<boolean> {
  const clipboard = options.clipboard === undefined
    ? (globalThis as { navigator?: { clipboard?: ClipboardWriter } }).navigator?.clipboard
    : options.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or an insecure origin: fall through to the legacy path.
    }
  }

  const doc = options.document === undefined
    ? (globalThis as { document?: ClipboardDocument }).document
    : options.document
  if (!doc) return false
  return legacyCopy(text, doc)
}

/** `document.execCommand("copy")` on an off-screen textarea, which is always removed again. */
function legacyCopy(text: string, doc: ClipboardDocument): boolean {
  let textarea: HTMLTextAreaElement | undefined
  let attached = false
  try {
    textarea = doc.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.left = "-9999px"
    doc.body.appendChild(textarea)
    attached = true
    textarea.select()
    return doc.execCommand("copy")
  } catch {
    return false
  } finally {
    if (attached && textarea) doc.body.removeChild(textarea)
  }
}
