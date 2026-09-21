import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  type DownloadDocument,
  downloadResponseAsFile,
  type ObjectUrlAdapter,
  type TimerAdapter,
} from "./download.ts"

/** Records every call this helper makes to the anchor, the body and the object URL, in order. */
function callLog() {
  return [] as string[]
}

/** A fake anchor that records what was set on it and whether it was clicked. */
function fakeAnchor(log: string[], onClick?: () => void) {
  return {
    href: "",
    download: "",
    click() {
      log.push("click")
      onClick?.()
    },
  } as unknown as HTMLAnchorElement
}

function fakeDocument(anchor: HTMLAnchorElement, log: string[]): DownloadDocument {
  return {
    createElement: () => anchor,
    body: {
      appendChild: (node) => {
        expect(node).toBe(anchor)
        log.push("appendChild")
      },
      removeChild: (node) => {
        expect(node).toBe(anchor)
        log.push("removeChild")
      },
    },
  }
}

function fakeObjectUrl(
  log: string[],
  url = "blob:fake-url",
): ObjectUrlAdapter & { revoked: string[] } {
  return {
    revoked: [] as string[],
    create: () => {
      log.push("create")
      return url
    },
    revoke(revokedUrl: string) {
      log.push("revoke")
      this.revoked.push(revokedUrl)
    },
  }
}

/** A timer that never fires on its own; the test fires it by calling `run()`. */
function fakeTimer(log: string[]): TimerAdapter & { run: () => void } {
  let scheduled: (() => void) | undefined
  return {
    setTimeout: (callback, _delayMs) => {
      log.push("setTimeout")
      scheduled = callback
      return 0
    },
    run: () => {
      scheduled?.()
    },
  }
}

describe("downloadResponseAsFile", () => {
  it("clicks an anchor built from the object URL and the given filename", async () => {
    const log = callLog()
    const anchor = fakeAnchor(log)
    const doc = fakeDocument(anchor, log)
    const objectUrl = fakeObjectUrl(log, "blob:report")
    const timer = fakeTimer(log)

    await downloadResponseAsFile(new Response("data"), "report.csv", {
      document: doc,
      objectUrl,
      timer,
    })

    expect(anchor.href).toBe("blob:report")
    expect(anchor.download).toBe("report.csv")
    expect(log).toContain("click")
  })

  it("attaches the anchor before the click and detaches it in the same task, revoking only once the timer fires", async () => {
    const log = callLog()
    const anchor = fakeAnchor(log)
    const doc = fakeDocument(anchor, log)
    const objectUrl = fakeObjectUrl(log)
    const timer = fakeTimer(log)

    await downloadResponseAsFile(new Response("data"), "f.csv", {
      document: doc,
      objectUrl,
      timer,
    })
    expect(log).toEqual(["create", "appendChild", "click", "removeChild", "setTimeout"])

    timer.run()
    expect(log).toEqual(["create", "appendChild", "click", "removeChild", "setTimeout", "revoke"])
  })

  it("asks the timer to wait five seconds before the revoke", async () => {
    const doc = fakeDocument(fakeAnchor([]), [])
    const objectUrl = fakeObjectUrl([])
    let requestedDelayMs: number | undefined
    const timer: TimerAdapter = {
      setTimeout: (callback, delayMs) => {
        requestedDelayMs = delayMs
        callback()
        return 0
      },
    }

    await downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl, timer })

    // A literal, not the module's own constant: this pins the actual number the module asks
    // for, rather than comparing the source against itself if the constant were ever changed.
    expect(requestedDelayMs).toBe(5000)
  })

  it("passes the module's own delay to the platform's setTimeout when no timer is injected", async () => {
    const anchor = fakeAnchor([])
    const doc = fakeDocument(anchor, [])
    const objectUrl = fakeObjectUrl([], "blob:default-timer")

    // No `timer` in options: this exercises `options.timer ?? platformTimer`, the real
    // `setTimeout`. The platform `setTimeout` is swapped for a stand-in that records the delay
    // it was asked for and never fires, so nothing here waits five real seconds or needs a fake
    // clock library; the original is always restored, even if the assertions below throw.
    const realSetTimeout = globalThis.setTimeout
    let requestedDelayMs: number | undefined
    globalThis.setTimeout = ((_callback: () => void, delayMs?: number) => {
      requestedDelayMs = delayMs
      return 0
    }) as typeof setTimeout
    try {
      await downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl })
    } finally {
      globalThis.setTimeout = realSetTimeout
    }

    expect(anchor.href).toBe("blob:default-timer")
    expect(requestedDelayMs).toBe(5000)
  })

  it("keeps the object URL alive when the call resolves, and revokes it once the timer fires", async () => {
    const log = callLog()
    const doc = fakeDocument(fakeAnchor(log), log)
    const objectUrl = fakeObjectUrl(log, "blob:revoke-me")
    const timer = fakeTimer(log)

    await downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl, timer })
    expect(objectUrl.revoked).toEqual([])

    timer.run()
    expect(objectUrl.revoked).toEqual(["blob:revoke-me"])
  })

  it("still schedules the revoke when the click throws, and revokes only once the timer fires", async () => {
    const log = callLog()
    const anchor = fakeAnchor(log, () => {
      throw new Error("popup blocked")
    })
    const doc = fakeDocument(anchor, log)
    const objectUrl = fakeObjectUrl(log, "blob:leak-check")
    const timer = fakeTimer(log)

    await expect(
      downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl, timer }),
    ).rejects.toThrow("popup blocked")
    expect(objectUrl.revoked).toEqual([])

    timer.run()
    expect(objectUrl.revoked).toEqual(["blob:leak-check"])
  })

  it("still revokes the object URL once the timer fires, even when removeChild throws", async () => {
    const log = callLog()
    const anchor = fakeAnchor(log)
    const doc: DownloadDocument = {
      createElement: () => anchor,
      body: {
        appendChild: (node) => {
          expect(node).toBe(anchor)
          log.push("appendChild")
        },
        removeChild: () => {
          log.push("removeChild")
          throw new DOMException("node is not a child of this node", "NotFoundError")
        },
      },
    }
    const objectUrl = fakeObjectUrl(log, "blob:detach-fails")
    const timer = fakeTimer(log)

    await expect(
      downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl, timer }),
    ).rejects.toThrow("node is not a child of this node")
    expect(objectUrl.revoked).toEqual([])

    timer.run()
    expect(objectUrl.revoked).toEqual(["blob:detach-fails"])
  })

  it("rejects without a document rather than touching a global one", async () => {
    await expect(
      downloadResponseAsFile(new Response("data"), "f.csv", {
        objectUrl: fakeObjectUrl(callLog()),
      }),
    ).rejects.toThrow("needs a document")
  })
})
