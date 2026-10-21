/**
 * The browser half of passkeys: feature checks, and the `navigator.credentials` calls that turn the
 * server's JSON options into a passkey and the passkey back into JSON for the server
 * (`@spy4x/server/webauthn` checks it there).
 *
 * The JSON conversion is the browser's own (`PublicKeyCredential.parseCreationOptionsFromJSON`,
 * `parseRequestOptionsFromJSON` and `toJSON()`), so no base64url code lives here.
 * {@link supportsPasskeys} is false in a browser that lacks them, and the app hides passkeys there.
 *
 * Nothing here reads a global at import time: every function takes an optional
 * {@link PasskeyBrowser} and reads `PublicKeyCredential` and `navigator.credentials` only when the
 * caller passes none, so the module is safe to import during a server render and testable with
 * fakes.
 *
 * @module
 */

/** The `PublicKeyCredential` statics this module calls. The global constructor satisfies it. */
export interface PasskeyStatics {
  parseCreationOptionsFromJSON(
    options: PublicKeyCredentialCreationOptionsJSON,
  ): PublicKeyCredentialCreationOptions
  parseRequestOptionsFromJSON(
    options: PublicKeyCredentialRequestOptionsJSON,
  ): PublicKeyCredentialRequestOptions
  isConditionalMediationAvailable?(): Promise<boolean>
  signalUnknownCredential?(options: { rpId: string; credentialId: string }): Promise<void>
}

/** A credential `navigator.credentials` returns: only its `toJSON` is used. */
export interface PasskeyCredential {
  toJSON(): unknown
}

/** Where the module finds the browser's passkey API. Each field defaults to the global. */
export interface PasskeyBrowser {
  /** Defaults to the global `PublicKeyCredential`. */
  PublicKeyCredential?: PasskeyStatics
  /** Defaults to `navigator.credentials`. */
  credentials?: {
    create(options: CredentialCreationOptions): Promise<PasskeyCredential | Credential | null>
    get(options: CredentialRequestOptions): Promise<PasskeyCredential | Credential | null>
  }
}

/** A passkey as JSON, ready to send to the server. */
export interface PasskeyJSON {
  id: string
  rawId: string
  type: string
  response: Record<string, unknown>
  [key: string]: unknown
}

/** Options for {@link createPasskey} and {@link getPasskey}. */
export interface PasskeyCallOptions {
  /** Cancels the browser's dialog, or a pending autofill request. */
  signal?: AbortSignal
  browser?: PasskeyBrowser
}

/** Whether this browser can create and use passkeys, with the JSON helpers this module needs. */
export function supportsPasskeys(browser: PasskeyBrowser = {}): boolean {
  const statics = staticsOf(browser)
  return typeof statics?.parseCreationOptionsFromJSON === "function" &&
    typeof statics.parseRequestOptionsFromJSON === "function" &&
    credentialsOf(browser) !== undefined
}

/**
 * Whether the browser offers passkeys in a field's autofill (`autocomplete="username webauthn"`),
 * so {@link getPasskey} with `autofill: true` can run while the sign-in page is open. Never throws.
 */
export async function supportsPasskeyAutofill(browser: PasskeyBrowser = {}): Promise<boolean> {
  if (!supportsPasskeys(browser)) return false
  try {
    return (await staticsOf(browser)?.isConditionalMediationAvailable?.()) === true
  } catch {
    return false
  }
}

/**
 * Create a passkey from the server's registration options. Resolves to its JSON, or null when the
 * person closed the dialog or `signal` aborted. Any other failure rejects: `InvalidStateError`
 * means this authenticator already holds one of the person's passkeys (the options' exclude list).
 */
export async function createPasskey(
  options: PublicKeyCredentialCreationOptionsJSON,
  { signal, browser = {} }: PasskeyCallOptions = {},
): Promise<PasskeyJSON | null> {
  const publicKey = required(browser).parseCreationOptionsFromJSON(options)
  return await call(() => credentialsOf(browser)!.create({ publicKey, signal }))
}

/**
 * Sign in with a passkey from the server's authentication options. Resolves to its JSON, or null
 * when the person closed the dialog or `signal` aborted.
 *
 * With `autofill: true` the request waits quietly for the person to pick a passkey in a field's
 * autofill instead of opening a dialog; abort it with `signal` before starting another one.
 */
export async function getPasskey(
  options: PublicKeyCredentialRequestOptionsJSON,
  { signal, browser = {}, autofill = false }: PasskeyCallOptions & { autofill?: boolean } = {},
): Promise<PasskeyJSON | null> {
  const publicKey = required(browser).parseRequestOptionsFromJSON(options)
  return await call(() =>
    credentialsOf(browser)!.get({
      publicKey,
      signal,
      ...(autofill ? { mediation: "conditional" as CredentialMediationRequirement } : {}),
    })
  )
}

/**
 * Tell the passkey provider that the server does not know this credential (it was removed), so it
 * stops offering it. Does nothing in a browser without `signalUnknownCredential`. Never throws.
 */
export async function signalUnknownPasskey(
  rpId: string,
  credentialId: string,
  browser: PasskeyBrowser = {},
): Promise<void> {
  try {
    await staticsOf(browser)?.signalUnknownCredential?.({ rpId, credentialId })
  } catch {
    // The signal is advisory: a provider that refuses it changes nothing for the person.
  }
}

function staticsOf(browser: PasskeyBrowser): PasskeyStatics | undefined {
  return browser.PublicKeyCredential ??
    (globalThis as { PublicKeyCredential?: PasskeyStatics }).PublicKeyCredential
}

function credentialsOf(browser: PasskeyBrowser): PasskeyBrowser["credentials"] {
  return browser.credentials ??
    (globalThis as { navigator?: { credentials?: PasskeyBrowser["credentials"] } }).navigator
      ?.credentials
}

function required(browser: PasskeyBrowser): PasskeyStatics {
  if (!supportsPasskeys(browser)) throw new Error("This browser does not support passkeys")
  return staticsOf(browser)!
}

async function call(
  run: () => Promise<PasskeyCredential | Credential | null>,
): Promise<PasskeyJSON | null> {
  let credential
  try {
    credential = await run()
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name
    if (name === "NotAllowedError" || name === "AbortError") return null
    throw error
  }
  if (!credential || !("toJSON" in credential)) return null
  return credential.toJSON() as PasskeyJSON
}
