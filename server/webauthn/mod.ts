/**
 * `@spy4x/server/webauthn` — passkeys (WebAuthn level 3) for a relying party: the options a browser
 * needs to create or use a passkey, and the checks on what it sends back.
 *
 * Kept small on purpose:
 *
 * - Only ES256 (COSE -7, P-256) and RS256 (COSE -257) keys are accepted. Every mainstream passkey
 *   provider offers ES256.
 * - User verification (the device's fingerprint, face or PIN) is required on every ceremony, so a
 *   passkey alone is a full sign-in, never a weaker factor.
 * - Attestation is neither requested nor checked: options ask for `"none"`, and the attestation
 *   statement of a response is ignored whatever its format, as the specification lets a client do
 *   itself. Nothing here trusts where an authenticator came from, and nothing fetches a
 *   certificate revocation list named by a certificate the client sent.
 * - Every function is pure apart from random bytes and the clock. The caller stores the challenge
 *   and the credential. A challenge is single-use: take it out of the store (get and delete in one
 *   step) before calling a `verify` function, so a second response for it finds nothing.
 *
 * Parsing (CBOR, COSE keys, authenticator data, DER signatures and their WebCrypto import) comes
 * from `@simplewebauthn/server`'s helpers. Each check is written out below, in the order of the
 * specification's "Registering a New Credential" (section 7.1) and "Verifying an Authentication
 * Assertion" (section 7.2).
 *
 * @module
 */

import {
  cose,
  decodeAttestationObject,
  decodeCredentialPublicKey,
  parseAuthenticatorData,
  verifySignature,
} from "@simplewebauthn/server/helpers"
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server"
import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url"
import { type Type, type } from "arktype"
import { type NowFn, systemNow } from "@spy4x/platform/universal/time"

export type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON }

/** How a browser can reach an authenticator, as `AuthenticatorAttestationResponse.getTransports()` says. */
export type AuthenticatorTransport =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb"

/** COSE algorithm ids accepted for a passkey's key: ES256 (-7) and RS256 (-257). */
export const WEBAUTHN_ALGORITHMS: readonly number[] = [-7, -257]
/** How long a challenge stays valid, and the `timeout` the browser is given: five minutes. */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60_000
/** Longest credential id the specification allows, in bytes. */
const MAX_CREDENTIAL_ID_BYTES = 1023
const CHALLENGE_BYTES = 32
const TRANSPORTS: readonly string[] = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
]

/** Who the passkeys belong to: the site, as the browser sees it. */
export interface WebAuthnRelyingParty {
  /** The RP ID: the site's registrable domain or a host under it, such as `"example.com"`. */
  id: string
  /** The name a passkey dialog shows, such as the product's name. */
  name: string
  /** Every origin a ceremony may come from, such as `["https://app.example.com"]`. Exact match. */
  origins: readonly string[]
}

/** A challenge the caller stores between the options and the response. */
export interface WebAuthnChallenge {
  /** The challenge, base64url, as it appears in the options and in the client data. */
  value: string
  /** Epoch milliseconds after which a response to it is refused. */
  expiresAt: number
}

/** A stored passkey, as {@link verifyRegistration} returned it and the caller kept it. */
export interface WebAuthnCredential {
  /** The credential id, base64url. */
  id: string
  /** The COSE public key, exactly as {@link verifyRegistration} returned it. */
  publicKey: Uint8Array
  /** The last signature counter accepted for it. */
  counter: number
  /** The user id it was registered for: the `user.id` given to {@link registrationOptions}. */
  userId: string
  /** How the browser can reach the authenticator, if it said. */
  transports?: AuthenticatorTransport[]
}

/** Why a response was refused. */
export type WebAuthnRefusal =
  /** Not a WebAuthn response, or one whose bytes do not parse. */
  | "malformed"
  /** A response to the other ceremony: a sign-in sent to registration, or the reverse. */
  | "wrong_type"
  /** The response answers a different challenge (another ceremony's, or an old one). */
  | "challenge_mismatch"
  /** The challenge outlived {@link WEBAUTHN_CHALLENGE_TTL_MS}. */
  | "challenge_expired"
  /** The ceremony ran on an origin that is not listed, or inside another site's frame. */
  | "wrong_origin"
  /** The authenticator signed for another RP ID. */
  | "wrong_rp_id"
  /** The authenticator did not report the person present. */
  | "user_not_present"
  /** The authenticator did not verify the person (no fingerprint, face or PIN). */
  | "user_not_verified"
  /** The new key is not ES256 or RS256. */
  | "unsupported_algorithm"
  /** The response names another credential, or another user than the credential's. */
  | "wrong_credential"
  /** The signature does not verify with the stored key. */
  | "bad_signature"
  /**
   * The signature counter did not go up. A valid signature with an old counter can mean a cloned
   * authenticator; the caller should log it against the credential.
   */
  | "counter_regressed"

/** The result of a `verify` function. */
export type WebAuthnResult<T> = { ok: true } & T | { ok: false; reason: WebAuthnRefusal }

/** What {@link registrationOptions} and {@link authenticationOptions} produce. */
export interface WebAuthnOptions<T> {
  /** Send these to the browser, as JSON. */
  options: T
  /** Store this until the response comes back. */
  challenge: WebAuthnChallenge
}

/** Parameters of {@link registrationOptions}. */
export interface RegistrationOptionsInput {
  /** The person adding a passkey. `id` is the app's user id; it must not be an e-mail address. */
  user: { id: string; name: string; displayName?: string }
  /** The person's existing passkeys, so the same authenticator is not registered twice. */
  exclude?: readonly Pick<WebAuthnCredential, "id" | "transports">[]
  now?: NowFn
}

/** Parameters of {@link authenticationOptions}. */
export interface AuthenticationOptionsInput {
  /**
   * The passkeys that may answer. Leave empty for a sign-in where the person has not said who they
   * are yet (the passkey picker or autofill): the browser then offers every passkey for the site.
   */
  allow?: readonly Pick<WebAuthnCredential, "id" | "transports">[]
  now?: NowFn
}

const base64Url: Type<string> = type(/^[A-Za-z0-9_-]{1,65536}$/)

/** A registration response that passed {@link registrationResponseSchema}. */
export interface RegistrationResponse {
  id: string
  rawId: string
  type: "public-key"
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] }
}

/** An authentication response that passed {@link authenticationResponseSchema}. */
export interface AuthenticationResponse {
  id: string
  rawId: string
  type: "public-key"
  response: {
    clientDataJSON: string
    authenticatorData: string
    signature: string
    userHandle?: string | null
  }
}

/** A registration response, as `PublicKeyCredential.toJSON()` makes it after `create()`. */
export const registrationResponseSchema: Type<RegistrationResponse> = type({
  id: base64Url,
  rawId: base64Url,
  type: "'public-key'",
  response: {
    clientDataJSON: base64Url,
    attestationObject: base64Url,
    "transports?": "string[] <= 16",
  },
})

/** An authentication response, as `PublicKeyCredential.toJSON()` makes it after `get()`. */
export const authenticationResponseSchema: Type<AuthenticationResponse> = type({
  id: base64Url,
  rawId: base64Url,
  type: "'public-key'",
  response: {
    clientDataJSON: base64Url,
    authenticatorData: base64Url,
    signature: base64Url,
    "userHandle?": base64Url.or("null"),
  },
})

const clientDataSchema = type({
  type: "string",
  challenge: "string",
  origin: "string",
  "crossOrigin?": "boolean",
  "topOrigin?": "string",
})

/** What {@link verifyRegistration} returns on success: store all of it. */
export interface RegisteredPasskey {
  credential: Omit<WebAuthnCredential, "userId">
  /** The passkey can be synced to the person's other devices (backup eligible). */
  multiDevice: boolean
  /** The passkey is synced right now (backed up). */
  backedUp: boolean
}

/** What {@link verifyAuthentication} returns on success. */
export interface AuthenticatedPasskey {
  /** Store this as the credential's new `counter`. */
  counter: number
  /** The passkey is synced right now (backed up); it can change between sign-ins. */
  backedUp: boolean
}

/**
 * Options for `navigator.credentials.create()`, asking for a discoverable passkey with user
 * verification, ES256 or RS256, and no attestation.
 */
export function registrationOptions(
  rp: WebAuthnRelyingParty,
  input: RegistrationOptionsInput,
): WebAuthnOptions<PublicKeyCredentialCreationOptionsJSON> {
  if (!input.user.id) throw new Error("registrationOptions: user.id is required")
  if (!input.user.name) throw new Error("registrationOptions: user.name is required")
  const challenge = newChallenge(input.now)
  return {
    challenge,
    options: {
      challenge: challenge.value,
      rp: { id: rp.id, name: rp.name },
      user: {
        id: userHandle(input.user.id),
        name: input.user.name,
        displayName: input.user.displayName ?? input.user.name,
      },
      pubKeyCredParams: WEBAUTHN_ALGORITHMS.map((alg) => ({ alg, type: "public-key" })),
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
      attestation: "none",
      excludeCredentials: (input.exclude ?? []).map(descriptor),
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
    },
  }
}

/** Options for `navigator.credentials.get()`, requiring user verification. */
export function authenticationOptions(
  rp: WebAuthnRelyingParty,
  input: AuthenticationOptionsInput = {},
): WebAuthnOptions<PublicKeyCredentialRequestOptionsJSON> {
  const challenge = newChallenge(input.now)
  return {
    challenge,
    options: {
      challenge: challenge.value,
      rpId: rp.id,
      timeout: WEBAUTHN_CHALLENGE_TTL_MS,
      allowCredentials: (input.allow ?? []).map(descriptor),
      userVerification: "required",
    },
  }
}

/**
 * Checks a registration response against the challenge taken from the store. On success the
 * caller stores the credential for the user, after making sure no stored credential has its id.
 */
export async function verifyRegistration(
  rp: WebAuthnRelyingParty,
  input: { response: RegistrationResponse; challenge: WebAuthnChallenge; now?: NowFn },
): Promise<WebAuthnResult<RegisteredPasskey>> {
  const { response } = input
  if (response.id !== response.rawId) return refuse("malformed")
  const client = checkClientData(rp, response.response.clientDataJSON, "webauthn.create", input)
  if (client !== true) return refuse(client)

  let auth
  try {
    const attestation = decodeAttestationObject(
      decodeBase64Url(response.response.attestationObject),
    )
    const authData = attestation.get("authData")
    if (!(authData instanceof Uint8Array)) return refuse("malformed")
    auth = parseAuthenticatorData(authData)
  } catch {
    return refuse("malformed")
  }
  const flags = checkAuthenticatorData(auth)
  if (flags !== true) return refuse(flags)
  if (!(await rpIdMatches(rp.id, auth.rpIdHash))) return refuse("wrong_rp_id")
  if (!auth.flags.up) return refuse("user_not_present")
  if (!auth.flags.uv) return refuse("user_not_verified")

  const { credentialID, credentialPublicKey } = auth
  if (!auth.flags.at || !credentialID || !credentialPublicKey) return refuse("malformed")
  if (credentialID.byteLength > MAX_CREDENTIAL_ID_BYTES) return refuse("malformed")
  if (encodeBase64Url(credentialID) !== response.id) return refuse("malformed")
  const key = keyAlgorithm(credentialPublicKey)
  if (key === "malformed") return refuse("malformed")
  if (key === "unsupported") return refuse("unsupported_algorithm")

  // Unknown transports are dropped rather than refused: a newer browser may name one.
  const transports = response.response.transports?.filter((t): t is AuthenticatorTransport =>
    TRANSPORTS.includes(t)
  )
  return {
    ok: true,
    credential: {
      id: response.id,
      publicKey: credentialPublicKey,
      counter: auth.counter,
      ...(transports ? { transports } : {}),
    },
    multiDevice: auth.flags.be,
    backedUp: auth.flags.bs,
  }
}

/**
 * Checks an authentication response against the challenge taken from the store and the stored
 * credential whose id is `response.id`. On success the caller stores the returned counter.
 */
export async function verifyAuthentication(
  rp: WebAuthnRelyingParty,
  input: {
    response: AuthenticationResponse
    challenge: WebAuthnChallenge
    credential: WebAuthnCredential
    now?: NowFn
  },
): Promise<WebAuthnResult<AuthenticatedPasskey>> {
  const { response, credential } = input
  if (response.id !== response.rawId) return refuse("malformed")
  if (response.id !== credential.id) return refuse("wrong_credential")
  const handle = response.response.userHandle
  if (handle && handle !== userHandle(credential.userId)) return refuse("wrong_credential")
  const client = checkClientData(rp, response.response.clientDataJSON, "webauthn.get", input)
  if (client !== true) return refuse(client)

  let authData, auth, signature, clientData
  try {
    authData = decodeBase64Url(response.response.authenticatorData)
    auth = parseAuthenticatorData(authData)
    signature = decodeBase64Url(response.response.signature)
    clientData = decodeBase64Url(response.response.clientDataJSON)
  } catch {
    return refuse("malformed")
  }
  const flags = checkAuthenticatorData(auth)
  if (flags !== true) return refuse(flags)
  if (!(await rpIdMatches(rp.id, auth.rpIdHash))) return refuse("wrong_rp_id")
  if (!auth.flags.up) return refuse("user_not_present")
  if (!auth.flags.uv) return refuse("user_not_verified")
  if (keyAlgorithm(credential.publicKey) !== "ok") return refuse("unsupported_algorithm")

  const clientDataHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData))
  const signed = new Uint8Array(authData.byteLength + clientDataHash.byteLength)
  signed.set(authData)
  signed.set(clientDataHash, authData.byteLength)
  let valid = false
  try {
    valid = await verifySignature({
      signature,
      data: signed,
      credentialPublicKey: new Uint8Array(credential.publicKey),
    })
  } catch {
    valid = false
  }
  if (!valid) return refuse("bad_signature")

  // Section 6.1.1: a counter of zero on both sides means the authenticator keeps none, which is
  // what synced passkeys send. Otherwise the new value must be greater than the stored one.
  if ((auth.counter > 0 || credential.counter > 0) && auth.counter <= credential.counter) {
    return refuse("counter_regressed")
  }
  return { ok: true, counter: auth.counter, backedUp: auth.flags.bs }
}

/** The user handle the options carry for an app user id: its UTF-8 bytes, base64url. */
function userHandle(userId: string): string {
  return encodeBase64Url(new TextEncoder().encode(userId))
}

function newChallenge(now: NowFn = systemNow): WebAuthnChallenge {
  const bytes = crypto.getRandomValues(new Uint8Array(CHALLENGE_BYTES))
  return { value: encodeBase64Url(bytes), expiresAt: now() + WEBAUTHN_CHALLENGE_TTL_MS }
}

function descriptor(credential: Pick<WebAuthnCredential, "id" | "transports">) {
  return {
    id: credential.id,
    type: "public-key" as const,
    ...(credential.transports ? { transports: credential.transports } : {}),
  }
}

function refuse(reason: WebAuthnRefusal): { ok: false; reason: WebAuthnRefusal } {
  return { ok: false, reason }
}

/** Section 7.1 steps 5–10 and 7.2 steps 10–14: the client data says what, where and for which. */
function checkClientData(
  rp: WebAuthnRelyingParty,
  clientDataJSON: string,
  ceremony: "webauthn.create" | "webauthn.get",
  input: { challenge: WebAuthnChallenge; now?: NowFn },
): true | WebAuthnRefusal {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(clientDataJSON),
    ))
  } catch {
    return "malformed"
  }
  const data = clientDataSchema(parsed)
  if (data instanceof type.errors) return "malformed"
  if (data.type !== ceremony) return "wrong_type"
  if (data.challenge !== input.challenge.value) return "challenge_mismatch"
  if ((input.now ?? systemNow)() > input.challenge.expiresAt) return "challenge_expired"
  if (!rp.origins.includes(data.origin)) return "wrong_origin"
  if (data.crossOrigin === true || data.topOrigin !== undefined) return "wrong_origin"
  return true
}

/** Section 6.3.3: a credential that is backed up must be backup eligible. */
function checkAuthenticatorData(
  auth: ReturnType<typeof parseAuthenticatorData>,
): true | WebAuthnRefusal {
  return auth.flags.bs && !auth.flags.be ? "malformed" : true
}

async function rpIdMatches(rpId: string, rpIdHash: Uint8Array): Promise<boolean> {
  const expected = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)),
  )
  return rpIdHash.byteLength === expected.byteLength &&
    expected.every((byte, i) => byte === rpIdHash[i])
}

/** Whether a COSE key is ES256 on P-256 or RS256, with the key type that algorithm needs. */
function keyAlgorithm(publicKey: Uint8Array): "ok" | "unsupported" | "malformed" {
  let key
  try {
    key = decodeCredentialPublicKey(new Uint8Array(publicKey))
  } catch {
    return "malformed"
  }
  if (!(key instanceof Map)) return "malformed"
  const alg = key.get(cose.COSEKEYS.alg)
  const kty = key.get(cose.COSEKEYS.kty)
  if (alg === cose.COSEALG.ES256) {
    return kty === cose.COSEKTY.EC2 && key.get(cose.COSEKEYS.crv) === cose.COSECRV.P256
      ? "ok"
      : "unsupported"
  }
  if (alg === cose.COSEALG.RS256) return kty === cose.COSEKTY.RSA ? "ok" : "unsupported"
  return "unsupported"
}
