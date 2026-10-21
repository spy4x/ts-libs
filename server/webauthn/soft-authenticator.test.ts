// A software authenticator for the WebAuthn tests: it makes real keys with WebCrypto and builds the
// bytes a browser would send, so the tests run the module's checks end to end. Each option bends
// one thing a hostile or broken client could bend.

import { isoCBOR } from "@simplewebauthn/server/helpers"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import type {
  AuthenticationResponse,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponse,
} from "./mod.ts"

export const UP = 1
export const UV = 4
export const BE = 8
export const BS = 16
const AT = 64

/** What a ceremony may bend. Every field defaults to what an honest browser and device send. */
export interface Bend {
  origin?: string
  rpId?: string
  type?: string
  challenge?: string
  flags?: number
  counter?: number
  crossOrigin?: boolean
  topOrigin?: string
}

/**
 * A COSE algorithm id, `"-7/P-384"` for a key that claims ES256 on the wrong curve, or
 * `"-257/1024"` for an RS256 key with a 1024-bit modulus.
 */
type Algorithm = -7 | -257 | -8 | "-7/P-384" | "-257/1024"

export class SoftAuthenticator {
  readonly credentialId: Uint8Array
  counter: number
  #keys: CryptoKeyPair | null = null

  constructor(
    readonly alg: Algorithm = -7,
    counter = 0,
    readonly origin = "https://app.test",
    idBytes = 32,
  ) {
    this.counter = counter
    this.credentialId = crypto.getRandomValues(new Uint8Array(idBytes))
  }

  get #rsa(): boolean {
    return this.alg === -257 || this.alg === "-257/1024"
  }

  get id(): string {
    return encodeBase64Url(this.credentialId)
  }

  async create(
    options: PublicKeyCredentialCreationOptionsJSON,
    bend: Bend = {},
  ): Promise<RegistrationResponse> {
    const key = await this.#coseKey()
    const idLength = new Uint8Array([
      this.credentialId.byteLength >> 8,
      this.credentialId.byteLength,
    ])
    const authData = concat(
      await this.#authDataHeader(
        bend.rpId ?? options.rp.id!,
        (bend.flags ?? UP | UV | BE | BS) | AT,
        bend.counter,
      ),
      new Uint8Array(16),
      idLength,
      this.credentialId,
      key,
    )
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], [
        "authData",
        authData,
      ]]) as Map<string, string>,
    )
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: this.#clientData("webauthn.create", options.challenge, bend),
        attestationObject: encodeBase64Url(attestationObject),
        transports: ["internal", "hybrid"],
      },
    }
  }

  async get(
    options: PublicKeyCredentialRequestOptionsJSON,
    userHandle: string | null,
    bend: Bend = {},
  ): Promise<AuthenticationResponse> {
    if (bend.counter === undefined && this.counter > 0) this.counter++
    const authData = await this.#authDataHeader(
      bend.rpId ?? options.rpId!,
      bend.flags ?? UP | UV | BE | BS,
      bend.counter ?? this.counter,
    )
    const clientDataJSON = this.#clientData("webauthn.get", options.challenge, bend)
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", decodeBase64Url(clientDataJSON)),
    )
    const signature = await this.#sign(concat(authData, hash))
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON,
        authenticatorData: encodeBase64Url(authData),
        signature: encodeBase64Url(signature),
        userHandle,
      },
    }
  }

  #clientData(ceremony: string, challenge: string, bend: Bend): string {
    const data = {
      type: bend.type ?? ceremony,
      challenge: bend.challenge ?? challenge,
      origin: bend.origin ?? this.origin,
      crossOrigin: bend.crossOrigin ?? false,
      ...(bend.topOrigin ? { topOrigin: bend.topOrigin } : {}),
    }
    return encodeBase64Url(new TextEncoder().encode(JSON.stringify(data)))
  }

  async #authDataHeader(
    rpId: string,
    flags: number,
    counter = this.counter,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
    )
    const count = new Uint8Array(4)
    new DataView(count.buffer).setUint32(0, counter)
    return concat(rpIdHash, new Uint8Array([flags]), count)
  }

  async #keyPair(): Promise<CryptoKeyPair> {
    if (this.#keys) return this.#keys
    const params = this.alg === -7 ? { name: "ECDSA", namedCurve: "P-256" } : this.#rsa
      ? {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: this.alg === -257 ? 2048 : 1024,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      }
      : this.alg === "-7/P-384"
      ? { name: "ECDSA", namedCurve: "P-384" }
      : { name: "Ed25519" }
    this.#keys = await crypto.subtle.generateKey(params, true, ["sign", "verify"]) as CryptoKeyPair
    return this.#keys
  }

  async #coseKey(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey("jwk", (await this.#keyPair()).publicKey)
    const b = (value?: string) => decodeBase64Url(value!)
    const entries: [number, number | Uint8Array][] = this.alg === -7
      ? [[1, 2], [3, -7], [-1, 1], [-2, b(jwk.x)], [-3, b(jwk.y)]]
      : this.#rsa
      ? [[1, 3], [3, -257], [-1, b(jwk.n)], [-2, b(jwk.e)]]
      : this.alg === "-7/P-384"
      ? [[1, 2], [3, -7], [-1, 2], [-2, b(jwk.x)], [-3, b(jwk.y)]]
      : [[1, 1], [3, -8], [-1, 6], [-2, b(jwk.x)]]
    return isoCBOR.encode(new Map(entries))
  }

  async #sign(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
    const { privateKey } = await this.#keyPair()
    if (this.#rsa) {
      return new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, data))
    }
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data),
    )
    return derSignature(raw)
  }
}

/** WebAuthn sends ES256 signatures as ASN.1 DER, WebCrypto makes them as raw `r || s`. */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    let value = bytes.slice(start)
    if (value[0] & 0x80) value = concat(new Uint8Array([0]), value)
    return concat(new Uint8Array([0x02, value.length]), value)
  }
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
