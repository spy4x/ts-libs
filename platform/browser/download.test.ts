import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { type DownloadDocument, downloadResponseAsFile, type ObjectUrlAdapter } from "./download.ts"

/** A fake anchor that records what was set on it and whether it was clicked. */
function fakeAnchor(onClick?: () => void) {
  return {
    href: "",
    download: "",
    click() {
      onClick?.()
    },
  } as unknown as HTMLAnchorElement
}

function fakeObjectUrl(url = "blob:fake-url"): ObjectUrlAdapter & { revoked: string[] } {
  return {
    revoked: [] as string[],
    create: () => url,
    revoke(revokedUrl: string) {
      this.revoked.push(revokedUrl)
    },
  }
}

describe("downloadResponseAsFile", () => {
  it("clicks an anchor built from the object URL and the given filename", async () => {
    let clicked = false
    const anchor = fakeAnchor(() => {
      clicked = true
    })
    const doc: DownloadDocument = { createElement: () => anchor }
    const objectUrl = fakeObjectUrl("blob:report")

    await downloadResponseAsFile(new Response("data"), "report.csv", { document: doc, objectUrl })

    expect(anchor.href).toBe("blob:report")
    expect(anchor.download).toBe("report.csv")
    expect(clicked).toBe(true)
  })

  it("revokes the object URL after the click", async () => {
    const doc: DownloadDocument = { createElement: () => fakeAnchor() }
    const objectUrl = fakeObjectUrl("blob:revoke-me")

    await downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl })

    expect(objectUrl.revoked).toEqual(["blob:revoke-me"])
  })

  it("revokes the object URL even when the click throws", async () => {
    const anchor = fakeAnchor(() => {
      throw new Error("popup blocked")
    })
    const doc: DownloadDocument = { createElement: () => anchor }
    const objectUrl = fakeObjectUrl("blob:leak-check")

    await expect(
      downloadResponseAsFile(new Response("data"), "f.csv", { document: doc, objectUrl }),
    ).rejects.toThrow("popup blocked")
    expect(objectUrl.revoked).toEqual(["blob:leak-check"])
  })

  it("rejects without a document rather than touching a global one", async () => {
    await expect(
      downloadResponseAsFile(new Response("data"), "f.csv", { objectUrl: fakeObjectUrl() }),
    ).rejects.toThrow("needs a document")
  })
})
