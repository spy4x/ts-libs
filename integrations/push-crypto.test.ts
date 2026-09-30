import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding"
import { ApplicationServer, generateVapidKeys } from "@negrel/webpush"
import { encryptPayload } from "./push-crypto.ts"

/** RFC 8291 section 5 and appendix A: the worked example, every input and the output. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
}

const serverWith = async (asPrivate: string, asPublic: string): Promise<ApplicationServer> => {
  const raw = decodeBase64Url(asPublic)
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(raw.slice(1, 33)),
    y: encodeBase64Url(raw.slice(33, 65)),
  }
  const algorithm = { name: "ECDH", namedCurve: "P-256" }
  return new ApplicationServer({
    keys: {
      publicKey: await crypto.subtle.importKey("jwk", jwk, algorithm, true, []),
      privateKey: await crypto.subtle.importKey(
        "jwk",
        { ...jwk, d: asPrivate },
        algorithm,
        false,
        ["deriveKey"],
      ),
    },
    contactInformation: "mailto:ops@example.com",
    vapidKeys: await generateVapidKeys(),
  })
}

describe("encryptPayload", () => {
  it("reproduces the RFC 8291 section 5 message byte for byte", async () => {
    const server = await serverWith(RFC.asPrivate, RFC.asPublic)
    const body = await encryptPayload(
      server,
      { auth: RFC.auth, p256dh: RFC.uaPublic },
      new TextEncoder().encode(RFC.plaintext),
      decodeBase64Url(RFC.salt),
    )
    expect(encodeBase64Url(body)).toBe(RFC.body)
  })

  it("changes with the authentication secret", async () => {
    const server = await serverWith(RFC.asPrivate, RFC.asPublic)
    const body = await encryptPayload(
      server,
      { auth: encodeBase64Url(new Uint8Array(16)), p256dh: RFC.uaPublic },
      new TextEncoder().encode(RFC.plaintext),
      decodeBase64Url(RFC.salt),
    )
    expect(encodeBase64Url(body)).not.toBe(RFC.body)
  })

  it("uses a fresh random salt when none is pinned", async () => {
    const server = await serverWith(RFC.asPrivate, RFC.asPublic)
    const keys = { auth: RFC.auth, p256dh: RFC.uaPublic }
    const message = new TextEncoder().encode("x")
    const a = new Uint8Array(await encryptPayload(server, keys, message))
    const b = new Uint8Array(await encryptPayload(server, keys, message))
    expect(a.slice(0, 16)).not.toEqual(b.slice(0, 16))
  })

  it("rejects keys that are not a P-256 point", async () => {
    const server = await serverWith(RFC.asPrivate, RFC.asPublic)
    await expect(
      encryptPayload(server, { auth: RFC.auth, p256dh: "AAAA" }, new Uint8Array(1)),
    ).rejects.toThrow()
  })
})
