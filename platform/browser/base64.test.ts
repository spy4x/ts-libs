import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { urlBase64ToUint8Array } from "./base64.ts"

/** Reference encoder, so the expectations are not the implementation restated. */
function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

describe("urlBase64ToUint8Array", () => {
  it("decodes an unpadded URL-safe string", () => {
    const bytes = urlBase64ToUint8Array("AQAB")
    expect([...bytes]).toEqual([1, 0, 1])
  })

  it("decodes the URL-safe alphabet only, never producing a negative code unit", () => {
    // 0xFB 0xFF encodes to "+/8=" in standard base64 and "-_8" in the URL-safe alphabet.
    const bytes = urlBase64ToUint8Array("-_8")
    expect([...bytes]).toEqual([0xfb, 0xff])
  })

  it("accepts an already-padded string", () => {
    expect([...urlBase64ToUint8Array("AQAB")]).toEqual([...urlBase64ToUint8Array("AQAB=")])
  })

  it("decodes an empty string to zero bytes", () => {
    expect(urlBase64ToUint8Array("").length).toBe(0)
  })

  it("round-trips a realistic Web Push key", () => {
    const key = new Uint8Array(65)
    crypto.getRandomValues(key)
    expect([...urlBase64ToUint8Array(toBase64Url(key))]).toEqual([...key])
  })

  it("throws on a malformed string instead of returning a partial key", () => {
    expect(() => urlBase64ToUint8Array("!!!!")).toThrow()
  })
})
