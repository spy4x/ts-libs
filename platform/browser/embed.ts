/**
 * Helpers for a page that is framed by another site: tell the parent frame how tall the page is,
 * and capture the visitor's time zone. Ported from `mig` (`lib/height-report-script.ts`,
 * `lib/guest-tz-script.ts`), as functions instead of inline script text.
 *
 * A parent page cannot read a cross-origin frame's height, so the frame has to say it.
 * {@link reportHeight} measures one element's own box (`getBoundingClientRect().height`), not the
 * document: `document.documentElement.scrollHeight` only ever grows while the frame's height is set
 * by the parent, so a page that got shorter would keep reporting its old, taller size.
 *
 * Nothing here reads a global at import time: the `window` is a parameter, read from `globalThis`
 * only when the caller passes none, so the module is safe to import in a server render and
 * testable with fakes.
 *
 * @module
 */

/** The parent frame: all {@link reportHeight} needs from it is `postMessage`. */
export interface EmbedParent {
  postMessage(message: unknown, targetOrigin: string): void
}

/** The observer {@link reportHeight} uses; a `ResizeObserver` fits. */
export interface EmbedResizeObserver {
  observe(element: unknown): void
  disconnect(): void
}

/** The measured element: anything with a `getBoundingClientRect`. */
export interface EmbedMeasurable {
  getBoundingClientRect(): { height: number }
}

/** The subset of `Window` {@link reportHeight} reads. */
export interface EmbedWindow {
  parent: EmbedParent
  document: {
    readyState: string
    querySelector(selector: string): EmbedMeasurable | null
  }
  ResizeObserver?: new (callback: () => void) => EmbedResizeObserver
  addEventListener(type: "load" | "resize", listener: () => void): void
  removeEventListener(type: "load" | "resize", listener: () => void): void
}

/** Options for {@link reportHeight}. */
export interface ReportHeightOptions {
  /**
   * The element whose height is reported, or a CSS selector for it. Mark the page's own content
   * wrapper, not `<body>`: a body that is sized to the frame never shrinks.
   */
  element: EmbedMeasurable | string
  /**
   * The parent's origin, e.g. `https://host.example`, passed to `postMessage` as its target origin.
   * Required, with no default: the browser then delivers the message only to a parent on that
   * origin. Pass `"*"` yourself only for a value that is safe for any page to read.
   */
  targetOrigin: string
  /** The `type` field of the message. Defaults to {@link EMBED_HEIGHT_MESSAGE_TYPE}. */
  messageType?: string
  /** The window to read. Defaults to the global `window`. */
  window?: EmbedWindow
}

/** Default `type` of the message {@link reportHeight} posts: `{ type, height }`. */
export const EMBED_HEIGHT_MESSAGE_TYPE = "embed:height"

/**
 * Post the element's height, in whole CSS pixels, to the parent frame — once the page has loaded,
 * and again each time the element's size changes. Returns a function that stops reporting.
 *
 * The message is `{ type: "embed:height", height }`. Does nothing, and returns a no-op stop, when
 * the page is not framed (`window.parent === window`) or the element is not found. Uses
 * `ResizeObserver` when the window has one and falls back to the `resize` event. A height equal to
 * the last one sent is not sent again.
 *
 * @throws {TypeError} when `targetOrigin` is empty.
 */
export function reportHeight(options: ReportHeightOptions): () => void {
  if (options.targetOrigin === "") {
    throw new TypeError("reportHeight needs a targetOrigin, e.g. https://host.example")
  }
  const win = options.window ?? (globalThis as unknown as { window?: EmbedWindow }).window
  if (!win || win.parent === (win as unknown)) return () => {}
  const element = typeof options.element === "string"
    ? win.document.querySelector(options.element)
    : options.element
  if (!element) return () => {}

  const type = options.messageType ?? EMBED_HEIGHT_MESSAGE_TYPE
  let last: number | undefined
  let observer: EmbedResizeObserver | undefined
  let stopped = false

  const send = () => {
    if (stopped) return
    const height = Math.ceil(element.getBoundingClientRect().height)
    if (height === last) return
    last = height
    win.parent.postMessage({ type, height }, options.targetOrigin)
  }
  const start = () => {
    win.removeEventListener("load", start)
    if (stopped) return
    send()
    if (win.ResizeObserver) {
      observer = new win.ResizeObserver(send)
      observer.observe(element)
    } else {
      win.addEventListener("resize", send)
    }
  }

  if (win.document.readyState === "complete") start()
  else win.addEventListener("load", start)

  return () => {
    stopped = true
    observer?.disconnect()
    win.removeEventListener("load", start)
    win.removeEventListener("resize", send)
  }
}

/**
 * The visitor's IANA time zone (`Europe/Berlin`), or `undefined` when the runtime reports none.
 *
 * @param resolve Reads the zone; defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
 * A throwing or empty answer gives `undefined`, never an exception.
 */
export function captureTimeZone(
  resolve: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | undefined {
  try {
    const zone = resolve()
    return zone ? zone : undefined
  } catch {
    return undefined
  }
}

/**
 * Put the visitor's time zone into a form field, only when the field is still empty — a zone the
 * page already filled in (from a link's `tz` parameter, say) is what the visitor saw on screen, and
 * overwriting it would submit a different one. Returns the zone written, or `undefined` when the
 * field was already filled or no zone could be detected.
 *
 * @param field The input to fill; anything with a string `value`.
 * @param resolve Passed to {@link captureTimeZone}.
 */
export function fillEmptyTimeZoneField(
  field: { value: string } | null | undefined,
  resolve?: () => string | undefined,
): string | undefined {
  if (!field || field.value !== "") return undefined
  const zone = captureTimeZone(resolve)
  if (zone === undefined) return undefined
  field.value = zone
  return zone
}
