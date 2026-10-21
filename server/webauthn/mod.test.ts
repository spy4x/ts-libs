import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import { type } from "arktype"

import {
  authenticationOptions,
  authenticationResponseSchema,
  registrationOptions,
  registrationResponseSchema,
  verifyAuthentication,
  verifyRegistration,
  WEBAUTHN_CHALLENGE_TTL_MS,
  type WebAuthnCredential,
  type WebAuthnRelyingParty,
} from "./mod.ts"
import { type Bend, SoftAuthenticator, UP, UV } from "./soft-authenticator.test.ts"

const RP: WebAuthnRelyingParty = { id: "app.test", name: "Test app", origins: ["https://app.test"] }
const USER = { id: "01928c4e-7b2a-7000-8000-000000000001", name: "ada@example.test" }
const NOW = 1_800_000_000_000
const now = () => NOW

/** Registers `device` for {@link USER} and returns what the app would store. */
async function register(device: SoftAuthenticator): Promise<WebAuthnCredential> {
  const { options, challenge } = registrationOptions(RP, { user: USER, now })
  const result = await verifyRegistration(RP, {
    response: await device.create(options),
    challenge,
    now,
  })
  if (!result.ok) throw new Error(`registration refused: ${result.reason}`)
  return { ...result.credential, userId: USER.id }
}

/** Runs one registration ceremony with `bend` applied and returns the refusal reason or "ok". */
async function registerWith(device: SoftAuthenticator, bend: Bend, at = NOW) {
  const { options, challenge } = registrationOptions(RP, { user: USER, now })
  const result = await verifyRegistration(RP, {
    response: await device.create(options, bend),
    challenge,
    now: () => at,
  })
  return result.ok ? "ok" : result.reason
}

/** Runs one sign-in ceremony for `credential` with `bend` applied. */
async function signInWith(
  device: SoftAuthenticator,
  credential: WebAuthnCredential,
  bend: Bend = {},
  at = NOW,
) {
  const { options, challenge } = authenticationOptions(RP, { now })
  const handle = encodeBase64Url(new TextEncoder().encode(credential.userId))
  return await verifyAuthentication(RP, {
    response: await device.get(options, handle, bend),
    challenge,
    credential,
    now: () => at,
  })
}

describe("registrationOptions", () => {
  it("asks for a discoverable passkey with user verification, ES256 or RS256, no attestation", () => {
    const { options, challenge } = registrationOptions(RP, { user: USER, now })
    expect(options.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257])
    expect(options.authenticatorSelection).toEqual({
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    })
    expect(options.attestation).toBe("none")
    expect(options.rp).toEqual({ id: "app.test", name: "Test app" })
    expect(new TextDecoder().decode(decodeBase64Url(options.user.id))).toBe(USER.id)
    expect(options.challenge).toBe(challenge.value)
    expect(decodeBase64Url(challenge.value).byteLength).toBe(32)
    expect(challenge.expiresAt).toBe(NOW + WEBAUTHN_CHALLENGE_TTL_MS)
  })

  it("makes a fresh challenge every time", () => {
    const a = registrationOptions(RP, { user: USER }).challenge.value
    const b = registrationOptions(RP, { user: USER }).challenge.value
    expect(a).not.toBe(b)
  })

  it("lists the person's existing passkeys to exclude", () => {
    const { options } = registrationOptions(RP, {
      user: USER,
      exclude: [{ id: "AAAA", transports: ["internal"] }],
    })
    expect(options.excludeCredentials).toEqual([
      { id: "AAAA", type: "public-key", transports: ["internal"] },
    ])
  })
})

describe("authenticationOptions", () => {
  it("requires user verification and names the RP ID", () => {
    const { options } = authenticationOptions(RP, { now })
    expect(options.userVerification).toBe("required")
    expect(options.rpId).toBe("app.test")
    expect(options.allowCredentials).toEqual([])
  })
})

describe("register then sign in", () => {
  for (const alg of [-7, -257] as const) {
    it(`accepts a round trip with an ${alg === -7 ? "ES256" : "RS256"} passkey`, async () => {
      const device = new SoftAuthenticator(alg)
      const credential = await register(device)
      expect(credential.id).toBe(device.id)
      expect(credential.counter).toBe(0)
      expect(credential.transports).toEqual(["internal", "hybrid"])
      expect(await signInWith(device, credential)).toEqual({ ok: true, counter: 0, backedUp: true })
    })
  }

  it("reports a synced passkey as multi-device and backed up", async () => {
    const device = new SoftAuthenticator()
    const { options, challenge } = registrationOptions(RP, { user: USER, now })
    const result = await verifyRegistration(RP, {
      response: await device.create(options),
      challenge,
      now,
    })
    expect(result.ok && [result.multiDevice, result.backedUp]).toEqual([true, true])
  })

  it("accepts a counter that goes up and returns it to store", async () => {
    const device = new SoftAuthenticator(-7, 5)
    const credential = await register(device)
    expect(credential.counter).toBe(5)
    expect(await signInWith(device, credential)).toEqual({ ok: true, counter: 6, backedUp: true })
  })

  it("accepts a synced passkey that always sends a counter of zero", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect((await signInWith(device, credential)).ok).toBe(true)
    expect((await signInWith(device, credential)).ok).toBe(true)
  })
})

describe("verifyRegistration refuses", () => {
  it("a response from an origin that is not listed", async () => {
    expect(await registerWith(new SoftAuthenticator(), { origin: "https://evil.test" }))
      .toBe("wrong_origin")
  })

  it("a ceremony inside another site's frame", async () => {
    expect(await registerWith(new SoftAuthenticator(), { crossOrigin: true })).toBe("wrong_origin")
  })

  it("a key made for another RP ID", async () => {
    expect(await registerWith(new SoftAuthenticator(), { rpId: "evil.test" })).toBe("wrong_rp_id")
  })

  it("a response to an earlier challenge", async () => {
    const old = registrationOptions(RP, { user: USER, now }).options.challenge
    expect(await registerWith(new SoftAuthenticator(), { challenge: old }))
      .toBe("challenge_mismatch")
  })

  it("a response after the challenge expired", async () => {
    const late = NOW + WEBAUTHN_CHALLENGE_TTL_MS + 1
    expect(await registerWith(new SoftAuthenticator(), {}, late)).toBe("challenge_expired")
  })

  it("a sign-in response sent to registration", async () => {
    expect(await registerWith(new SoftAuthenticator(), { type: "webauthn.get" })).toBe("wrong_type")
  })

  it("a key that is neither ES256 nor RS256", async () => {
    expect(await registerWith(new SoftAuthenticator(-8), {})).toBe("unsupported_algorithm")
  })

  it("an ES256 key on a curve other than P-256", async () => {
    expect(await registerWith(new SoftAuthenticator("-7/P-384"), {})).toBe("unsupported_algorithm")
  })

  it("an authenticator that did not verify the person", async () => {
    expect(await registerWith(new SoftAuthenticator(), { flags: UP })).toBe("user_not_verified")
  })

  it("an authenticator that did not see the person", async () => {
    expect(await registerWith(new SoftAuthenticator(), { flags: UV })).toBe("user_not_present")
  })

  it("a backed-up credential that is not backup eligible", async () => {
    expect(await registerWith(new SoftAuthenticator(), { flags: UP | UV | 16 })).toBe("malformed")
  })

  it("a response whose id is not the credential's", async () => {
    const device = new SoftAuthenticator()
    const { options, challenge } = registrationOptions(RP, { user: USER, now })
    const response = await device.create(options)
    const other = new SoftAuthenticator().id
    const result = await verifyRegistration(RP, {
      response: { ...response, id: other, rawId: other },
      challenge,
      now,
    })
    expect(result).toEqual({ ok: false, reason: "malformed" })
  })

  it("bytes that do not parse", async () => {
    const device = new SoftAuthenticator()
    const { options, challenge } = registrationOptions(RP, { user: USER, now })
    const response = await device.create(options)
    response.response.attestationObject = "AAAA"
    expect(await verifyRegistration(RP, { response, challenge, now }))
      .toEqual({ ok: false, reason: "malformed" })
  })
})

describe("verifyAuthentication refuses", () => {
  it("a response from an origin that is not listed", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect(await signInWith(device, credential, { origin: "https://evil.test" }))
      .toEqual({ ok: false, reason: "wrong_origin" })
  })

  it("a signature made for another RP ID", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect(await signInWith(device, credential, { rpId: "evil.test" }))
      .toEqual({ ok: false, reason: "wrong_rp_id" })
  })

  it("a response to an earlier challenge", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    const old = authenticationOptions(RP, { now }).options.challenge
    expect(await signInWith(device, credential, { challenge: old }))
      .toEqual({ ok: false, reason: "challenge_mismatch" })
  })

  it("a response after the challenge expired", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect(await signInWith(device, credential, {}, NOW + WEBAUTHN_CHALLENGE_TTL_MS + 1))
      .toEqual({ ok: false, reason: "challenge_expired" })
  })

  it("a registration response sent to sign-in", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect(await signInWith(device, credential, { type: "webauthn.create" }))
      .toEqual({ ok: false, reason: "wrong_type" })
  })

  it("an authenticator that did not verify the person", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    expect(await signInWith(device, credential, { flags: UP }))
      .toEqual({ ok: false, reason: "user_not_verified" })
  })

  it("a tampered signature", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    const { options, challenge } = authenticationOptions(RP, { now })
    const response = await device.get(options, null)
    const signature = decodeBase64Url(response.response.signature)
    signature[signature.length - 1] ^= 1
    response.response.signature = encodeBase64Url(signature)
    expect(await verifyAuthentication(RP, { response, challenge, credential, now }))
      .toEqual({ ok: false, reason: "bad_signature" })
  })

  it("authenticator data changed after signing", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    const { options, challenge } = authenticationOptions(RP, { now })
    const response = await device.get(options, null)
    const data = decodeBase64Url(response.response.authenticatorData)
    data[36] = 9 // the low byte of the counter
    response.response.authenticatorData = encodeBase64Url(data)
    expect(await verifyAuthentication(RP, { response, challenge, credential, now }))
      .toEqual({ ok: false, reason: "bad_signature" })
  })

  it("a signature from another key under the same credential id", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    const stranger = new SoftAuthenticator()
    const other = await register(stranger)
    expect(
      await signInWith(stranger, { ...other, id: credential.id, publicKey: credential.publicKey }),
    )
      .toEqual({ ok: false, reason: "wrong_credential" })
    expect(await signInWith(device, { ...credential, publicKey: other.publicKey }))
      .toEqual({ ok: false, reason: "bad_signature" })
  })

  it("a counter that went backwards, after the signature checked out", async () => {
    const device = new SoftAuthenticator(-7, 5)
    const credential = await register(device)
    expect(await signInWith(device, credential, { counter: 5 }))
      .toEqual({ ok: false, reason: "counter_regressed" })
    expect(await signInWith(device, credential, { counter: 0 }))
      .toEqual({ ok: false, reason: "counter_regressed" })
  })

  it("a forged response with an old counter as a bad signature, not a cloned device", async () => {
    const device = new SoftAuthenticator(-7, 5)
    const credential = await register(device)
    const { options, challenge } = authenticationOptions(RP, { now })
    const response = await device.get(options, null, { counter: 1 })
    response.response.signature = encodeBase64Url(new Uint8Array(70))
    expect(await verifyAuthentication(RP, { response, challenge, credential, now }))
      .toEqual({ ok: false, reason: "bad_signature" })
  })

  it("a user handle that is not the credential owner's", async () => {
    const device = new SoftAuthenticator()
    const credential = await register(device)
    const { options, challenge } = authenticationOptions(RP, { now })
    const response = await device.get(options, encodeBase64Url(new TextEncoder().encode("other")))
    expect(await verifyAuthentication(RP, { response, challenge, credential, now }))
      .toEqual({ ok: false, reason: "wrong_credential" })
  })
})

describe("response schemas", () => {
  it("accept what a browser sends and refuse anything else", async () => {
    const device = new SoftAuthenticator()
    const reg = await device.create(registrationOptions(RP, { user: USER }).options)
    const auth = await device.get(authenticationOptions(RP).options, null)
    expect(registrationResponseSchema(reg)).toEqual(reg)
    expect(authenticationResponseSchema(auth)).toEqual(auth)
    expect(registrationResponseSchema(auth) instanceof type.errors).toBe(true)
    expect(authenticationResponseSchema({ ...auth, type: "password" }) instanceof type.errors)
      .toBe(true)
    expect(authenticationResponseSchema({ ...auth, id: "not base64url!" }) instanceof type.errors)
      .toBe(true)
  })
})
