import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type ClipboardDocument, type ClipboardWriter, copyToClipboard } from "./clipboard.ts"

/** A clipboard that records what it was given, or rejects the way a denied permission does. */
function fakeClipboard(written: string[], reject = false): ClipboardWriter {
  return {
    writeText(text) {
      if (reject) return Promise.reject(new DOMException("denied", "NotAllowedError"))
      written.push(text)
      return Promise.resolve()
    },
  }
}

/** A document whose `execCommand("copy")` copies the selected textarea's value into `copied`. */
function fakeDocument(copied: string[], log: string[], succeeds = true): ClipboardDocument {
  let selected = ""
  return {
    createElement: () => {
      const textarea = {
        value: "",
        style: {} as Record<string, string>,
        setAttribute: (name: string) => log.push(`setAttribute:${name}`),
        select: () => {
          selected = textarea.value
          log.push("select")
        },
      }
      return textarea as unknown as HTMLTextAreaElement
    },
    body: {
      appendChild: () => log.push("append"),
      removeChild: () => log.push("remove"),
    },
    execCommand: () => {
      log.push("execCommand")
      if (succeeds) copied.push(selected)
      return succeeds
    },
  }
}

describe("copyToClipboard", () => {
  it("writes through the Async Clipboard API and reports success", async () => {
    const written: string[] = []
    const log: string[] = []

    const ok = await copyToClipboard("invoice-42", {
      clipboard: fakeClipboard(written),
      document: fakeDocument([], log),
    })

    expect(ok).toBe(true)
    expect(written).toEqual(["invoice-42"])
    expect(log).toEqual([])
  })

  it("falls back to execCommand when the clipboard rejects", async () => {
    const copied: string[] = []
    const log: string[] = []

    const ok = await copyToClipboard("invoice-42", {
      clipboard: fakeClipboard([], true),
      document: fakeDocument(copied, log),
    })

    expect(ok).toBe(true)
    expect(copied).toEqual(["invoice-42"])
    expect(log).toEqual(["setAttribute:readonly", "append", "select", "execCommand", "remove"])
  })

  it("falls back to execCommand when there is no clipboard", async () => {
    const copied: string[] = []

    const ok = await copyToClipboard("plain", {
      clipboard: null,
      document: fakeDocument(copied, []),
    })

    expect(ok).toBe(true)
    expect(copied).toEqual(["plain"])
  })

  it("reports failure and removes the textarea when execCommand fails", async () => {
    const log: string[] = []

    const ok = await copyToClipboard("x", {
      clipboard: null,
      document: fakeDocument([], log, false),
    })

    expect(ok).toBe(false)
    expect(log.at(-1)).toBe("remove")
  })

  it("resolves false and removes the textarea when execCommand throws", async () => {
    const log: string[] = []
    const doc = fakeDocument([], log)
    doc.execCommand = () => {
      log.push("execCommand")
      throw new DOMException("blocked", "SecurityError")
    }

    const result = copyToClipboard("x", { clipboard: null, document: doc })

    await expect(result).resolves.toBe(false)
    expect(log.at(-1)).toBe("remove")
  })

  it("reports failure instead of throwing with neither a clipboard nor a document", async () => {
    expect(await copyToClipboard("x", { clipboard: null, document: null })).toBe(false)
  })

  it("reads the globals when nothing is passed, and Deno has neither", async () => {
    expect(await copyToClipboard("x")).toBe(false)
  })
})
