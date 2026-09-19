import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { verifyWebhookRequest } from "./webhooks.ts"
import type { WebhookRejectReason } from "./webhooks.ts"

const SECRET = "test-secret-not-real"
const BODY = new TextEncoder().encode('{"event":"ping","n":1}')

/** Signer that mirrors what a sender does: HMAC-SHA256 over `<ts>.<raw body>`. */
const sign = async (secret: string, timestampSeconds: number, body: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const prefix = new TextEncoder().encode(`${timestampSeconds}.`)
  const signed = new Uint8Array(prefix.length + body.length)
  signed.set(prefix, 0)
  signed.set(body, prefix.length)
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed))
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

const AT_SECONDS = 1_800_000_000
const clockAt = (ms: number) => () => ms

const headersFor = (signature: string, timestamp: string | number): Headers => {
  const headers = new Headers()
  headers.set("X-Signature-256", signature)
  headers.set("X-Signature-Timestamp", String(timestamp))
  return headers
}

const config = { secret: SECRET, clock: clockAt(AT_SECONDS * 1000) }

const rejection = async (
  rawBody: Uint8Array | ArrayBuffer,
  headers: Headers | Record<string, string>,
): Promise<WebhookRejectReason> => {
  const result = await verifyWebhookRequest(rawBody, headers, config)
  expect(result.ok).toBe(false)
  return result.ok === false ? result.reason : "signature_mismatch"
}

describe("verifyWebhookRequest", () => {
  it("accepts a delivery signed with the shared secret", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const result = await verifyWebhookRequest(BODY, headersFor(signature, AT_SECONDS), config)
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.timestampSeconds).toBe(AT_SECONDS)
    expect(result.ok === true && [...result.body]).toEqual([...BODY])
  })

  it("accepts the prefixed scheme a GitHub-style sender writes", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const headers = new Headers({
      "X-Hub-Signature-256": `sha256=${signature}`,
      "X-Signature-Timestamp": String(AT_SECONDS),
    })
    const result = await verifyWebhookRequest(BODY, headers, {
      secret: SECRET,
      timestampHeader: "X-Signature-Timestamp",
      signatureHeader: "X-Hub-Signature-256",
      clock: clockAt(AT_SECONDS * 1000),
    })
    expect(result.ok).toBe(true)
  })

  it("reads headers from a plain record case-insensitively", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const result = await verifyWebhookRequest(BODY, {
      "x-signature-256": signature,
      "X-SIGNATURE-TIMESTAMP": String(AT_SECONDS),
    }, config)
    expect(result.ok).toBe(true)
  })

  it("accepts an ArrayBuffer body, since that is what a runtime hands over", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const buffer = BODY.buffer.slice(0) as ArrayBuffer
    const result = await verifyWebhookRequest(buffer, headersFor(signature, AT_SECONDS), config)
    expect(result.ok).toBe(true)
  })

  it("rejects a body that changed after signing", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const tampered = new TextEncoder().encode('{"event":"ping","n":2}')
    expect(await rejection(tampered, headersFor(signature, AT_SECONDS))).toBe("signature_mismatch")
  })

  it("rejects a signature made with another secret", async () => {
    const signature = await sign("another-secret-not-real", AT_SECONDS, BODY)
    expect(await rejection(BODY, headersFor(signature, AT_SECONDS))).toBe("signature_mismatch")
  })

  it("rejects a signature that is not the full 64 hex characters", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    expect(await rejection(BODY, headersFor(signature.slice(0, 63), AT_SECONDS)))
      .toBe("malformed_signature")
    expect(await rejection(BODY, headersFor("sha256=zz", AT_SECONDS))).toBe("malformed_signature")
  })

  it("rejects a signature scheme it does not implement", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    expect(await rejection(BODY, headersFor(`sha1=${signature}`, AT_SECONDS)))
      .toBe("malformed_signature")
  })

  it("rejects an oversized signature header before parsing it", async () => {
    expect(await rejection(BODY, headersFor("a".repeat(201), AT_SECONDS)))
      .toBe("malformed_signature")
  })

  it("rejects a missing or blank signature header", async () => {
    expect(await rejection(BODY, { "X-Signature-Timestamp": String(AT_SECONDS) }))
      .toBe("missing_signature")
    expect(await rejection(BODY, headersFor("   ", AT_SECONDS))).toBe("missing_signature")
  })

  it("rejects a missing, non-numeric or oversized timestamp", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    expect(await rejection(BODY, { "X-Signature-256": signature })).toBe("missing_timestamp")
    expect(await rejection(BODY, headersFor(signature, "yesterday"))).toBe("malformed_timestamp")
    expect(await rejection(BODY, headersFor(signature, "-1"))).toBe("malformed_timestamp")
    expect(await rejection(BODY, headersFor(signature, "1".repeat(25))))
      .toBe("malformed_timestamp")
  })

  it("rejects a replayed delivery older than the tolerance window", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const late = { secret: SECRET, clock: clockAt((AT_SECONDS + 400) * 1000) }
    const result = await verifyWebhookRequest(BODY, headersFor(signature, AT_SECONDS), late)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("stale_timestamp")
    expect(result.ok === false && result.message).toContain("400s old")
  })

  it("accepts a delivery inside the tolerance window", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const result = await verifyWebhookRequest(BODY, headersFor(signature, AT_SECONDS), {
      secret: SECRET,
      clock: clockAt((AT_SECONDS + 299) * 1000),
    })
    expect(result.ok).toBe(true)
  })

  it("rejects a timestamp too far in the future", async () => {
    const signature = await sign(SECRET, AT_SECONDS + 400, BODY)
    expect(await rejection(BODY, headersFor(signature, AT_SECONDS + 400))).toBe("future_timestamp")
  })

  it("honours a caller-supplied narrower tolerance", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const result = await verifyWebhookRequest(BODY, headersFor(signature, AT_SECONDS), {
      secret: SECRET,
      toleranceSeconds: 5,
      clock: clockAt((AT_SECONDS + 6) * 1000),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("stale_timestamp")
  })

  it("rejects a string body, which cannot be compared byte for byte", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const asString = "not bytes" as unknown as Uint8Array
    expect(await rejection(asString, headersFor(signature, AT_SECONDS))).toBe("malformed_body")
  })

  it("rejects everything when the verifier has no secret, rather than accepting", async () => {
    // An empty secret must not become "sign with nothing and pass": the
    // explicit precondition fires first and every delivery is refused, before
    // any HMAC is attempted (a zero-length HMAC key is a `DataError`).
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    const unconfigured = await verifyWebhookRequest(BODY, headersFor(signature, AT_SECONDS), {
      secret: "",
      clock: clockAt(AT_SECONDS * 1000),
    })
    expect(unconfigured.ok).toBe(false)
    expect(unconfigured.ok === false && unconfigured.reason).toBe("invalid_secret")
    expect(unconfigured.ok === false && unconfigured.message).toContain("no usable secret")
  })

  it("leaks neither the secret nor the body in a rejection message", async () => {
    const result = await verifyWebhookRequest(BODY, headersFor("deadbeef", AT_SECONDS), config)
    expect(result.ok).toBe(false)
    const message = result.ok === false ? result.message : ""
    expect(message).not.toContain(SECRET)
    expect(message).not.toContain("ping")
  })

  it("is order-independent in the timestamp, so a re-signed body at another second fails", async () => {
    const signature = await sign(SECRET, AT_SECONDS, BODY)
    // Same body, signature minted for a different second: the timestamp is
    // inside the signed string and inside the replay check.
    expect(await rejection(BODY, headersFor(signature, AT_SECONDS + 1))).toBe("signature_mismatch")
  })
})

describe("verifyWebhookRequest secret handling", () => {
  const FORGERY = new TextEncoder().encode('{"event":"admin_granted"}')
  const clock = clockAt(AT_SECONDS * 1000)

  /** Signs with an arbitrary value, the way a forger who knows the weakness would. */
  const signWith = async (secret: unknown, body: Uint8Array) => {
    // The HMAC key the old code built for a falsy secret was `String(falsy)`,
    // so `null` signed as the literal text "null" and `" "` as a space.
    const asString = typeof secret === "string" ? secret : String(secret)
    return await sign(asString === "null" ? "null" : asString, AT_SECONDS, body)
  }

  const rejects = async (secret: unknown): Promise<WebhookRejectReason> => {
    const signature = await signWith(secret, FORGERY)
    const result = await verifyWebhookRequest(FORGERY, headersFor(signature, AT_SECONDS), {
      secret: secret as string,
      clock,
    })
    expect({ secret: String(secret), ok: result.ok }).toEqual({ secret: String(secret), ok: false })
    return result.ok === false ? result.reason : "signature_mismatch"
  }

  it("rejects a forgery signed with the HMAC key `null`", async () => {
    // The live forgery path: `crypto.subtle.importKey` accepted the key built
    // from `null`, so a body signed with the same `null` verified.
    expect(await rejects(null)).toBe("invalid_secret")
  })

  it("rejects a forgery signed with a whitespace-only secret", async () => {
    expect(await rejects(" ")).toBe("invalid_secret")
    expect(await rejects("\t \n")).toBe("invalid_secret")
  })

  it("rejects every unusable secret with the same typed reason, never a throw", async () => {
    for (const secret of ["", "   ", null, undefined, 42, {}, [], true]) {
      const signature = await sign(SECRET, AT_SECONDS, FORGERY)
      const result = await verifyWebhookRequest(FORGERY, headersFor(signature, AT_SECONDS), {
        secret: secret as string,
        clock,
      })
      expect({
        secret: String(secret),
        ok: result.ok,
        reason: result.ok === false && result.reason,
      })
        .toEqual({ secret: String(secret), ok: false, reason: "invalid_secret" })
    }
  })

  it("rejects a missing config object rather than throwing", async () => {
    const signature = await sign(SECRET, AT_SECONDS, FORGERY)
    const result = await verifyWebhookRequest(
      FORGERY,
      headersFor(signature, AT_SECONDS),
      null as unknown as { secret: string },
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("invalid_secret")
  })

  it("does not throw `DataError: Key length is zero` for an empty or absent secret", async () => {
    for (const secret of ["", null, undefined]) {
      const signature = await sign(SECRET, AT_SECONDS, FORGERY)
      await expect(
        verifyWebhookRequest(FORGERY, headersFor(signature, AT_SECONDS), {
          secret: secret as string,
          clock,
        }),
      ).resolves.toEqual({
        ok: false,
        reason: "invalid_secret",
        message: "verifier has no usable secret configured",
      })
    }
  })

  it("still accepts a real secret, so the fail-closed check is not unconditional", async () => {
    const signature = await sign(SECRET, AT_SECONDS, FORGERY)
    const result = await verifyWebhookRequest(FORGERY, headersFor(signature, AT_SECONDS), {
      secret: SECRET,
      clock,
    })
    expect(result.ok).toBe(true)
  })
})
