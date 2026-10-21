import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import {
  createPasskey,
  getPasskey,
  type PasskeyBrowser,
  type PasskeyStatics,
  signalUnknownPasskey,
  supportsPasskeyAutofill,
  supportsPasskeys,
} from "./passkey.ts"

const JSON_OUT = { id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "x" } }
const CREATION = { challenge: "c" } as unknown as PublicKeyCredentialCreationOptionsJSON
const REQUEST = { challenge: "r" } as unknown as PublicKeyCredentialRequestOptionsJSON

/** A browser whose calls are recorded in `calls`; `fail` makes `create`/`get` reject by name. */
function fakeBrowser(
  calls: unknown[],
  { fail, statics = {} }: { fail?: string; statics?: Partial<PasskeyStatics> } = {},
): PasskeyBrowser {
  const answer = (options: unknown) => {
    calls.push(options)
    if (fail) return Promise.reject(new DOMException("no", fail))
    return Promise.resolve({ toJSON: () => JSON_OUT })
  }
  return {
    PublicKeyCredential: {
      parseCreationOptionsFromJSON: (o) =>
        ({ parsed: o }) as unknown as PublicKeyCredentialCreationOptions,
      parseRequestOptionsFromJSON: (o) =>
        ({ parsed: o }) as unknown as PublicKeyCredentialRequestOptions,
      ...statics,
    },
    credentials: { create: answer, get: answer },
  }
}

describe("supportsPasskeys", () => {
  it("is true when the browser has the JSON helpers and navigator.credentials", () => {
    expect(supportsPasskeys(fakeBrowser([]))).toBe(true)
  })

  it("is false when the browser lacks the JSON helpers", () => {
    const browser = fakeBrowser([])
    const statics = { ...browser.PublicKeyCredential } as Partial<PasskeyStatics>
    delete statics.parseRequestOptionsFromJSON
    expect(supportsPasskeys({ ...browser, PublicKeyCredential: statics as PasskeyStatics }))
      .toBe(false)
  })

  it("is false without navigator.credentials", () => {
    expect(supportsPasskeys({ PublicKeyCredential: fakeBrowser([]).PublicKeyCredential })).toBe(
      false,
    )
  })

  it("is false where there is no WebAuthn at all, such as a server render", () => {
    expect(supportsPasskeys()).toBe(false)
  })
})

describe("supportsPasskeyAutofill", () => {
  it("is true when conditional mediation is available", async () => {
    const browser = fakeBrowser([], {
      statics: { isConditionalMediationAvailable: () => Promise.resolve(true) },
    })
    expect(await supportsPasskeyAutofill(browser)).toBe(true)
  })

  it("is false in a browser without passkeys, whatever the check says", async () => {
    const statics = fakeBrowser([], {
      statics: { isConditionalMediationAvailable: () => Promise.resolve(true) },
    }).PublicKeyCredential
    expect(await supportsPasskeyAutofill({ PublicKeyCredential: statics })).toBe(false)
  })

  it("is false when the check is missing or rejects", async () => {
    expect(await supportsPasskeyAutofill(fakeBrowser([]))).toBe(false)
    const rejecting = fakeBrowser([], {
      statics: { isConditionalMediationAvailable: () => Promise.reject(new Error("no")) },
    })
    expect(await supportsPasskeyAutofill(rejecting)).toBe(false)
  })
})

describe("createPasskey", () => {
  it("parses the server's options, passes the signal, and returns the credential's JSON", async () => {
    const calls: unknown[] = []
    const signal = new AbortController().signal
    expect(await createPasskey(CREATION, { browser: fakeBrowser(calls), signal })).toEqual(JSON_OUT)
    expect(calls).toEqual([{ publicKey: { parsed: CREATION }, signal }])
  })

  it("resolves to null when the person closes the dialog or the call is aborted", async () => {
    for (const fail of ["NotAllowedError", "AbortError"]) {
      expect(await createPasskey(CREATION, { browser: fakeBrowser([], { fail }) })).toBeNull()
    }
  })

  it("rejects when the authenticator already holds one of the person's passkeys", async () => {
    const browser = fakeBrowser([], { fail: "InvalidStateError" })
    await expect(createPasskey(CREATION, { browser })).rejects.toThrow("no")
  })

  it("rejects in a browser without passkeys", async () => {
    await expect(createPasskey(CREATION, { browser: { credentials: fakeBrowser([]).credentials } }))
      .rejects.toThrow("does not support passkeys")
  })
})

describe("getPasskey", () => {
  it("opens the dialog by default", async () => {
    const calls: unknown[] = []
    expect(await getPasskey(REQUEST, { browser: fakeBrowser(calls) })).toEqual(JSON_OUT)
    expect(calls).toEqual([{ publicKey: { parsed: REQUEST }, signal: undefined }])
  })

  it("passes the caller's signal, so an autofill request can be cancelled", async () => {
    const calls: unknown[] = []
    const signal = new AbortController().signal
    await getPasskey(REQUEST, { browser: fakeBrowser(calls), autofill: true, signal })
    expect(calls).toEqual([{ publicKey: { parsed: REQUEST }, signal, mediation: "conditional" }])
  })

  it("asks for conditional mediation when autofill is on", async () => {
    const calls: unknown[] = []
    await getPasskey(REQUEST, { browser: fakeBrowser(calls), autofill: true })
    expect(calls).toEqual([
      { publicKey: { parsed: REQUEST }, signal: undefined, mediation: "conditional" },
    ])
  })

  it("resolves to null when the person cancels", async () => {
    expect(await getPasskey(REQUEST, { browser: fakeBrowser([], { fail: "NotAllowedError" }) }))
      .toBeNull()
  })
})

describe("signalUnknownPasskey", () => {
  it("tells the provider which credential the server no longer knows", async () => {
    const seen: unknown[] = []
    const browser = fakeBrowser([], {
      statics: { signalUnknownCredential: (o) => Promise.resolve(void seen.push(o)) },
    })
    await signalUnknownPasskey("example.com", "abc", browser)
    expect(seen).toEqual([{ rpId: "example.com", credentialId: "abc" }])
  })

  it("never throws, neither where the browser lacks it nor when the provider rejects it", async () => {
    await signalUnknownPasskey("example.com", "abc", fakeBrowser([]))
    const rejecting = fakeBrowser([], {
      statics: { signalUnknownCredential: () => Promise.reject(new Error("no")) },
    })
    await signalUnknownPasskey("example.com", "abc", rejecting)
  })
})
