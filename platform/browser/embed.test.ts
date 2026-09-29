// Fakes for `window`, the parent frame and `ResizeObserver`: no DOM, no timers.

import { assertEquals, assertThrows } from "@std/assert"
import {
  captureTimeZone,
  EMBED_HEIGHT_MESSAGE_TYPE,
  type EmbedMeasurable,
  type EmbedWindow,
  fillEmptyTimeZoneField,
  reportHeight,
} from "./embed.ts"

interface Harness {
  win: EmbedWindow
  posted: { message: unknown; origin: string }[]
  listeners: Map<string, Set<() => void>>
  observers: { fire(): void; observed: unknown[]; disconnected: boolean }[]
  emit(type: string): void
}

function harness(
  options: { readyState?: string; resizeObserver?: boolean; framed?: boolean; found?: boolean } =
    {},
): Harness {
  const posted: Harness["posted"] = []
  const listeners: Harness["listeners"] = new Map()
  const observers: Harness["observers"] = []
  const element = { found: options.found ?? true }
  const win = {
    parent: { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
    document: {
      readyState: options.readyState ?? "complete",
      querySelector: () => element.found ? measurable : null,
    },
    addEventListener: (type: string, listener: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type: string, listener: () => void) =>
      listeners.get(type)?.delete(listener),
  } as unknown as EmbedWindow & { parent: unknown }
  if (options.resizeObserver ?? true) {
    win.ResizeObserver = class {
      record = { fire: () => callback(), observed: [] as unknown[], disconnected: false }
      constructor(_callback: () => void) {
        callback = _callback
        observers.push(this.record)
      }
      observe(el: unknown) {
        this.record.observed.push(el)
      }
      disconnect() {
        this.record.disconnected = true
      }
    }
  }
  let callback: () => void = () => {}
  if (options.framed === false) win.parent = win as never
  return {
    win,
    posted,
    listeners,
    observers,
    emit: (type) => listeners.get(type)?.forEach((listener) => listener()),
  }
}

let height = 100.2
const measurable: EmbedMeasurable = { getBoundingClientRect: () => ({ height }) }

Deno.test("reportHeight posts the rounded-up height to the given origin as soon as the page is loaded", () => {
  height = 100.2
  const h = harness()
  reportHeight({ element: measurable, targetOrigin: "https://host.example", window: h.win })
  assertEquals(h.posted, [{
    message: { type: EMBED_HEIGHT_MESSAGE_TYPE, height: 101 },
    origin: "https://host.example",
  }])
})

Deno.test("reportHeight posts only to the caller-given origin and refuses an empty one", () => {
  const h = harness()
  reportHeight({ element: measurable, targetOrigin: "https://host.example", window: h.win })
  assertEquals(h.posted.map((p) => p.origin), ["https://host.example"])
  assertThrows(
    () => reportHeight({ element: measurable, targetOrigin: "", window: h.win }),
    TypeError,
    "targetOrigin",
  )
})

Deno.test("reportHeight posts again when the element grows or shrinks, and skips an unchanged height", () => {
  height = 300
  const h = harness()
  reportHeight({ element: measurable, targetOrigin: "https://a.example", window: h.win })
  height = 300
  h.observers[0].fire()
  height = 120
  h.observers[0].fire()
  height = 500
  h.observers[0].fire()
  assertEquals(h.posted.map((p) => (p.message as { height: number }).height), [300, 120, 500])
})

Deno.test("reportHeight waits for the load event when the page is still loading", () => {
  height = 50
  const h = harness({ readyState: "loading" })
  reportHeight({ element: measurable, targetOrigin: "https://a.example", window: h.win })
  assertEquals(h.posted, [])
  h.emit("load")
  assertEquals(h.posted.length, 1)
  assertEquals(h.observers.length, 1)
})

Deno.test("reportHeight falls back to the resize event when there is no ResizeObserver", () => {
  height = 40
  const h = harness({ resizeObserver: false })
  reportHeight({ element: measurable, targetOrigin: "https://a.example", window: h.win })
  height = 90
  h.emit("resize")
  assertEquals(h.posted.map((p) => (p.message as { height: number }).height), [40, 90])
})

Deno.test("reportHeight finds the element by selector and uses a custom message type", () => {
  height = 10
  const h = harness()
  reportHeight({
    element: "[data-height]",
    targetOrigin: "https://a.example",
    messageType: "mig:height",
    window: h.win,
  })
  assertEquals(h.posted[0].message, { type: "mig:height", height: 10 })
})

Deno.test("reportHeight does nothing when the page is not framed or the element is missing", () => {
  const top = harness({ framed: false })
  reportHeight({ element: measurable, targetOrigin: "https://a.example", window: top.win })
  assertEquals(top.posted, [])
  const missing = harness({ found: false })
  reportHeight({ element: "#nope", targetOrigin: "https://a.example", window: missing.win })
  assertEquals(missing.posted, [])
})

Deno.test("reportHeight stop disconnects the observer and silences later changes", () => {
  height = 20
  const h = harness()
  const stop = reportHeight({
    element: measurable,
    targetOrigin: "https://a.example",
    window: h.win,
  })
  stop()
  height = 999
  h.observers[0].fire()
  assertEquals(h.observers[0].disconnected, true)
  assertEquals(h.posted.length, 1)
})

Deno.test("captureTimeZone returns the resolved zone, and undefined when it is empty or throws", () => {
  assertEquals(captureTimeZone(() => "Europe/Berlin"), "Europe/Berlin")
  assertEquals(captureTimeZone(() => ""), undefined)
  assertEquals(captureTimeZone(() => undefined), undefined)
  assertEquals(
    captureTimeZone(() => {
      throw new Error("no Intl")
    }),
    undefined,
  )
  assertEquals(typeof captureTimeZone(), "string")
})

Deno.test("fillEmptyTimeZoneField fills an empty field and leaves a filled one alone", () => {
  const empty = { value: "" }
  assertEquals(fillEmptyTimeZoneField(empty, () => "Asia/Tokyo"), "Asia/Tokyo")
  assertEquals(empty.value, "Asia/Tokyo")
  const filled = { value: "Europe/Paris" }
  assertEquals(fillEmptyTimeZoneField(filled, () => "Asia/Tokyo"), undefined)
  assertEquals(filled.value, "Europe/Paris")
  assertEquals(fillEmptyTimeZoneField(null), undefined)
  const none = { value: "" }
  assertEquals(fillEmptyTimeZoneField(none, () => undefined), undefined)
  assertEquals(none.value, "")
})
