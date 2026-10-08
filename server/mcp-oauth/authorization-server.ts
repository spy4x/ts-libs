/**
 * A single-user OAuth 2.1 authorization server for remote MCP connectors (claude.ai, the Claude
 * apps and Claude Code). Public clients only, identified by Client ID Metadata Documents; S256
 * PKCE only; tokens bound to one resource; codes single-use; refresh tokens rotated, and a reused
 * one revokes its whole grant. The app decides who the owner is through `confirmOwner`.
 * @module
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { encodeBase64Url } from "@std/encoding/base64url"
import { escapeHtml } from "@spy4x/email/html"
import { parseBoundedFormData } from "@spy4x/net/bounded-body"
import { constantTimeEqualsText, randomBase64Url, sha256Hex } from "@spy4x/platform/tokens"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import { createSameOriginCheck } from "../http/same-origin.ts"
import { type ClientMetadataSource, createClientMetadataFetcher } from "./client-metadata.ts"
import type { OAuthStore, PendingAuthorization } from "./model.ts"
import {
  assertRedirectAllowlist,
  DEFAULT_REDIRECT_URIS,
  isLoopbackRedirect,
  redirectUriMatches,
} from "./redirect-uri.ts"
import {
  type AccessTokenVerifier,
  assertScopes,
  canonicalResource,
  createAccessTokenVerifier,
} from "./resource-server.ts"

/** Path of the authorization server metadata document (RFC 8414). */
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server"
/** Path of the authorization endpoint. */
export const AUTHORIZE_PATH = "/authorize"
/** Path of the token endpoint. */
export const TOKEN_PATH = "/token"

/** The scope a client asks for to get a refresh token. Always accepted; refresh tokens always issued. */
export const OFFLINE_ACCESS_SCOPE = "offline_access"

const SECRET_BYTES = 32
const MAX_PARAM_LENGTH = 4096
const MAX_TOKEN_BODY_BYTES = 16 * 1024
const MAX_CONSENT_BODY_BYTES = 4 * 1024
/** S256 output: 32 bytes as unpadded base64url. */
const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
/** RFC 7636 section 4.1. */
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"

/** What the consent page shows and submits. Everything here is escaped by the default page. */
export interface ConsentDetails {
  /** Goes back in the hidden `consent_id` field. Single-use, expires with the consent page. */
  consentId: string
  /** The form's `action`: {@link AUTHORIZE_PATH}. Submit `decision=approve` or `decision=deny`. */
  action: string
  /** The client's `client_id` URL. */
  clientId: string
  /** The host of `clientId`: show this as who is asking, not `clientName`. */
  clientHost: string
  /** The client's self-asserted name. */
  clientName: string
  /** Where the code will be sent. */
  redirectUri: string
  /** The host of `redirectUri`; the MCP spec requires the page to show it. */
  redirectHost: string
  /** True when the code goes to a loopback address, which any local program can listen on. */
  loopbackRedirect: boolean
  /** The MCP server the tokens will work for. */
  resource: string
  /** Scopes asked for. */
  scopes: string[]
}

/** Options for {@link createAuthorizationServer}. */
export interface AuthorizationServerOptions {
  /** The issuer: a bare origin such as `https://auth.example.com`, with no path. */
  issuer: string
  /** The MCP server URLs (audiences) tokens may be issued for, exactly as entered in Claude. */
  resources: readonly string[]
  /** Where codes, tokens and pending consents live. */
  store: OAuthStore
  /**
   * True only when the request comes from the owner, e.g. when the `Remote-User` header that
   * Authelia's forward-auth sets names the owner. Called before anything else on both the consent
   * page and its submission; `false` answers `403` and does nothing.
   */
  confirmOwner(c: Context): boolean | Promise<boolean>
  /**
   * Redirect URIs any client may use; the client's own document must list the URI too. Loopback
   * entries match on any port. Defaults to {@link DEFAULT_REDIRECT_URIS}.
   */
  redirectUris?: readonly string[]
  /** Scopes the server knows, for `scopes_supported`. Defaults to none. */
  scopes?: readonly string[]
  /** Resolves `client_id` URLs. Defaults to {@link createClientMetadataFetcher} with defaults. */
  clients?: ClientMetadataSource
  /** Renders the consent page as HTML. Defaults to a plain built-in page. */
  renderConsent?: (details: ConsentDetails) => string
  /** Access token lifetime in milliseconds. Defaults to 15 minutes. */
  accessTokenTtlMs?: number
  /** Refresh token lifetime in milliseconds, renewed on every rotation. Defaults to 30 days. */
  refreshTokenTtlMs?: number
  /** Authorization code lifetime in milliseconds. Defaults to 60 seconds. */
  codeTtlMs?: number
  /** How long the consent page can be approved, in milliseconds. Defaults to 10 minutes. */
  consentTtlMs?: number
  /** Defaults to the system clock. */
  clock?: Clock
}

/** The authorization server metadata document (RFC 8414). */
export interface AuthorizationServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  response_types_supported: string[]
  grant_types_supported: string[]
  code_challenge_methods_supported: string[]
  token_endpoint_auth_methods_supported: string[]
  client_id_metadata_document_supported: boolean
  authorization_response_iss_parameter_supported: boolean
  scopes_supported?: string[]
}

/** What {@link createAuthorizationServer} returns. */
export interface AuthorizationServer {
  /** Routes for the metadata document, `GET`/`POST /authorize` and `POST /token`. Mount at `/`. */
  app: Hono
  /** The metadata document. */
  metadata: AuthorizationServerMetadata
  /** Checks access tokens this server issued; pass it to `createResourceServer`. */
  verifier: AccessTokenVerifier
}

type Params = Map<string, string>

/**
 * Read form or query parameters. A parameter sent with an empty value counts as absent (RFC 6749
 * section 3.1). Returns `undefined` when a parameter repeats, is not text, or is too long.
 */
function readParams(entries: Iterable<[string, FormDataEntryValue]>): Params | undefined {
  const params: Params = new Map()
  for (const [name, value] of entries) {
    if (typeof value !== "string" || value.length > MAX_PARAM_LENGTH) return undefined
    if (value === "") continue
    if (params.has(name)) return undefined
    params.set(name, value)
  }
  return params
}

function hostOf(url: string): string {
  return new URL(url).host
}

/** The S256 code challenge of a verifier (RFC 7636 section 4.2). */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return encodeBase64Url(new Uint8Array(digest))
}

/** The built-in consent page: what asks, where the code goes, and two buttons. */
export function defaultConsentPage(details: ConsentDetails): string {
  const e = escapeHtml
  const scopes = details.scopes.length > 0 ? details.scopes.join(" ") : "(none)"
  const warning = details.loopbackRedirect
    ? `<p><strong>The code goes to a program on this computer (${
      e(details.redirectHost)
    }). Approve only if you just started this sign-in yourself.</strong></p>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access?</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5}dt{font-weight:600}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
</head>
<body>
<h1>Allow ${e(details.clientHost)} to use ${e(hostOf(details.resource))}?</h1>
<dl>
<dt>Client</dt><dd>${e(details.clientName)} (${e(details.clientId)})</dd>
<dt>Sends the code to</dt><dd>${e(details.redirectHost)} (${e(details.redirectUri)})</dd>
<dt>Server</dt><dd>${e(details.resource)}</dd>
<dt>Scopes</dt><dd>${e(scopes)}</dd>
</dl>
${warning}
<form method="post" action="${e(details.action)}">
<input type="hidden" name="consent_id" value="${e(details.consentId)}">
<button type="submit" name="decision" value="approve">Allow</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>
</body>
</html>`
}

function positive(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result <= 0) throw new TypeError(`${name} must be positive`)
  return result
}

/**
 * Build the authorization server. Mount `app` at the root of the issuer's origin, put the owner's
 * sign-in (Authelia forward-auth) in front of `/authorize`, and keep `/token` and the metadata
 * document public: the client calls them without a browser.
 *
 * The flow: `GET /authorize` checks the owner, the client's metadata document, the redirect URI
 * (allowlist and document both), S256 PKCE, the resource and the scopes, then shows the consent
 * page. Until the redirect URI is known to be good, a refusal is a plain `400` page; after that it
 * is a redirect with an `error`. `POST /authorize` takes the owner's decision and redirects with a
 * single-use code. `POST /token` redeems a code or rotates a refresh token.
 *
 * @throws {TypeError} When `issuer`, a resource, a redirect URI, a scope or a lifetime is invalid.
 */
export function createAuthorizationServer(
  options: AuthorizationServerOptions,
): AuthorizationServer {
  const canonicalIssuer = canonicalResource(options.issuer)
  if (canonicalIssuer === undefined || canonicalIssuer !== new URL(canonicalIssuer).origin) {
    throw new TypeError(`issuer ${options.issuer} must be a bare https origin`)
  }
  const issuer: string = canonicalIssuer
  if (options.resources.length === 0) throw new TypeError("resources must list at least one URL")
  const resources = new Set<string>()
  for (const raw of options.resources) {
    const resource = canonicalResource(raw)
    if (resource === undefined) throw new TypeError(`invalid resource URL ${raw}`)
    resources.add(resource)
  }
  const redirectUris = options.redirectUris ?? DEFAULT_REDIRECT_URIS
  assertRedirectAllowlist(redirectUris)
  const scopes = options.scopes ?? []
  assertScopes(scopes)
  const knownScopes = new Set([...scopes, OFFLINE_ACCESS_SCOPE])
  const accessTtl = positive(options.accessTokenTtlMs, 15 * 60_000, "accessTokenTtlMs")
  const refreshTtl = positive(options.refreshTokenTtlMs, 30 * 24 * 60 * 60_000, "refreshTokenTtlMs")
  const codeTtl = positive(options.codeTtlMs, 60_000, "codeTtlMs")
  const consentTtl = positive(options.consentTtlMs, 10 * 60_000, "consentTtlMs")
  const clock = options.clock ?? systemClock
  const store = options.store
  const clients = options.clients ?? createClientMetadataFetcher({ clock })
  const renderConsent = options.renderConsent ?? defaultConsentPage
  const sameOrigin = createSameOriginCheck({ expectedOrigin: issuer, requireSessionCookie: false })

  const metadata: AuthorizationServerMetadata = {
    issuer,
    authorization_endpoint: issuer + AUTHORIZE_PATH,
    token_endpoint: issuer + TOKEN_PATH,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    ...(scopes.length > 0 ? { scopes_supported: [...scopes] } : {}),
  }

  /** Space-separated, deduplicated scopes, or `undefined` when one is unknown. */
  function grantedScope(requested: string | undefined, allowed: ReadonlySet<string>) {
    if (requested === undefined) return ""
    const asked = [...new Set(requested.split(" ").filter((s) => s !== ""))]
    return asked.every((s) => allowed.has(s)) ? asked.join(" ") : undefined
  }

  function page(c: Context, status: 400 | 403, message: string): Response {
    c.header("Cache-Control", "no-store")
    return c.text(message, status)
  }

  function redirect(c: Context, redirectUri: string, values: Record<string, string | undefined>) {
    const url = new URL(redirectUri)
    for (const [name, value] of Object.entries(values)) {
      if (value !== undefined) url.searchParams.set(name, value)
    }
    url.searchParams.set("iss", issuer)
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    return c.redirect(url.href, 302)
  }

  function tokenError(c: Context, error: string, description: string, status: 400 | 401 = 400) {
    c.header("Cache-Control", "no-store")
    c.header("Pragma", "no-cache")
    return c.json({ error, error_description: description }, status)
  }

  async function issueTokens(
    c: Context,
    grant: { grantId: string; clientId: string; resource: string; scope: string },
  ): Promise<Response> {
    const now = clock.now()
    const fields = {
      grantId: grant.grantId,
      clientId: grant.clientId,
      resource: grant.resource,
      scope: grant.scope,
    }
    const accessToken = randomBase64Url(SECRET_BYTES)
    const refreshToken = randomBase64Url(SECRET_BYTES)
    await store.saveAccessToken(await sha256Hex(accessToken), {
      ...fields,
      expiresAt: now + accessTtl,
    })
    await store.saveRefreshToken(await sha256Hex(refreshToken), {
      ...fields,
      expiresAt: now + refreshTtl,
    })
    c.header("Cache-Control", "no-store")
    c.header("Pragma", "no-cache")
    return c.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(accessTtl / 1000),
      refresh_token: refreshToken,
      ...(grant.scope !== "" ? { scope: grant.scope } : {}),
    })
  }

  const app = new Hono()

  app.get(AUTHORIZATION_SERVER_METADATA_PATH, (c) => c.json(metadata))

  app.get(AUTHORIZE_PATH, async (c) => {
    if (!(await options.confirmOwner(c))) return page(c, 403, "Only the owner can approve access.")
    const params = readParams(new URL(c.req.url).searchParams)
    if (params === undefined) return page(c, 400, "Malformed authorization request.")

    const clientId = params.get("client_id")
    const client = clientId === undefined ? undefined : await clients.load(clientId)
    if (clientId === undefined || client === undefined) return page(c, 400, "Unknown client.")

    const redirectUri = params.get("redirect_uri")
    const redirectAllowed = redirectUri !== undefined &&
      redirectUris.some((known) => redirectUriMatches(redirectUri, known)) &&
      client.redirectUris.some((known) => redirectUriMatches(redirectUri, known))
    if (!redirectAllowed) return page(c, 400, "This redirect URI is not allowed.")

    const state = params.get("state")
    const fail = (error: string, description: string) =>
      redirect(c, redirectUri, { error, error_description: description, state })

    if (params.get("response_type") !== "code") {
      return fail("unsupported_response_type", "response_type must be code")
    }
    const codeChallenge = params.get("code_challenge")
    if (params.get("code_challenge_method") !== "S256") {
      return fail("invalid_request", "code_challenge_method must be S256")
    }
    if (codeChallenge === undefined || !CODE_CHALLENGE.test(codeChallenge)) {
      return fail("invalid_request", "code_challenge must be an S256 challenge")
    }
    const rawResource = params.get("resource")
    if (rawResource === undefined) return fail("invalid_target", "resource is required")
    const resource = canonicalResource(rawResource)
    if (resource === undefined || !resources.has(resource)) {
      return fail("invalid_target", "unknown resource")
    }
    const scope = grantedScope(params.get("scope"), knownScopes)
    if (scope === undefined) return fail("invalid_scope", "unknown scope")

    const consentId = randomBase64Url(SECRET_BYTES)
    const pending: PendingAuthorization = {
      clientId,
      clientName: client.clientName,
      redirectUri,
      codeChallenge,
      resource,
      scope,
      state,
      expiresAt: clock.now() + consentTtl,
    }
    await store.savePending(await sha256Hex(consentId), pending)

    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Frame-Options", "DENY")
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    )
    return c.html(renderConsent({
      consentId,
      action: AUTHORIZE_PATH,
      clientId,
      clientHost: hostOf(clientId),
      clientName: client.clientName,
      redirectUri,
      redirectHost: hostOf(redirectUri),
      loopbackRedirect: isLoopbackRedirect(new URL(redirectUri)),
      resource,
      scopes: scope === "" ? [] : scope.split(" "),
    }))
  })

  app.post(AUTHORIZE_PATH, async (c) => {
    if (sameOrigin(c.req.raw) !== undefined) return page(c, 403, "Cross-site request refused.")
    if (!(await options.confirmOwner(c))) return page(c, 403, "Only the owner can approve access.")
    let params: Params | undefined
    try {
      params = readParams(
        await parseBoundedFormData(c.req.raw, { maxBytes: MAX_CONSENT_BODY_BYTES }),
      )
    } catch {
      params = undefined
    }
    const consentId = params?.get("consent_id")
    const decision = params?.get("decision")
    if (consentId === undefined || (decision !== "approve" && decision !== "deny")) {
      return page(c, 400, "Malformed consent.")
    }
    const pending = await store.takePending(await sha256Hex(consentId))
    if (pending === undefined || pending.expiresAt <= clock.now()) {
      return page(c, 400, "This request has expired. Start again from the app.")
    }
    if (decision === "deny") {
      return redirect(c, pending.redirectUri, {
        error: "access_denied",
        error_description: "The owner denied access",
        state: pending.state,
      })
    }
    const code = randomBase64Url(SECRET_BYTES)
    await store.saveCode(await sha256Hex(code), {
      grantId: randomBase64Url(SECRET_BYTES),
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      resource: pending.resource,
      scope: pending.scope,
      expiresAt: clock.now() + codeTtl,
    })
    return redirect(c, pending.redirectUri, { code, state: pending.state })
  })

  app.post(TOKEN_PATH, async (c) => {
    if (c.req.header("authorization") !== undefined) {
      return tokenError(c, "invalid_client", "only public clients are supported", 401)
    }
    const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase()
    if (contentType !== FORM_CONTENT_TYPE) {
      return tokenError(c, "invalid_request", `body must be ${FORM_CONTENT_TYPE}`)
    }
    let params: Params | undefined
    try {
      params = readParams(await parseBoundedFormData(c.req.raw, { maxBytes: MAX_TOKEN_BODY_BYTES }))
    } catch {
      params = undefined
    }
    if (params === undefined) return tokenError(c, "invalid_request", "malformed request")
    const clientId = params.get("client_id")
    if (clientId === undefined) return tokenError(c, "invalid_request", "client_id is required")
    const rawResource = params.get("resource")
    const resource = rawResource === undefined ? undefined : canonicalResource(rawResource)
    if (rawResource !== undefined && resource === undefined) {
      return tokenError(c, "invalid_target", "invalid resource")
    }

    const grantType = params.get("grant_type")
    if (grantType === "authorization_code") {
      const code = params.get("code")
      const verifier = params.get("code_verifier")
      const redirectUri = params.get("redirect_uri")
      if (code === undefined || redirectUri === undefined) {
        return tokenError(c, "invalid_request", "code and redirect_uri are required")
      }
      if (verifier === undefined || !CODE_VERIFIER.test(verifier)) {
        return tokenError(c, "invalid_request", "a valid code_verifier is required")
      }
      const record = await store.consumeCode(await sha256Hex(code))
      if (record === undefined) return tokenError(c, "invalid_grant", "unknown code")
      if (record.usedAt !== undefined) {
        await store.revokeGrant(record.grantId)
        return tokenError(c, "invalid_grant", "code already used")
      }
      if (record.expiresAt <= clock.now()) return tokenError(c, "invalid_grant", "code expired")
      if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
        return tokenError(c, "invalid_grant", "code was issued to another client or redirect")
      }
      if (resource !== undefined && resource !== record.resource) {
        return tokenError(c, "invalid_target", "code was issued for another resource")
      }
      if (!(await constantTimeEqualsText(await s256(verifier), record.codeChallenge))) {
        return tokenError(c, "invalid_grant", "code_verifier does not match")
      }
      return await issueTokens(c, record)
    }

    if (grantType === "refresh_token") {
      const refreshToken = params.get("refresh_token")
      if (refreshToken === undefined) {
        return tokenError(c, "invalid_request", "refresh_token is required")
      }
      const record = await store.consumeRefreshToken(await sha256Hex(refreshToken))
      if (record === undefined) return tokenError(c, "invalid_grant", "unknown refresh token")
      if (record.usedAt !== undefined) {
        await store.revokeGrant(record.grantId)
        return tokenError(c, "invalid_grant", "refresh token already used")
      }
      if (record.expiresAt <= clock.now()) {
        return tokenError(c, "invalid_grant", "refresh token expired")
      }
      if (record.clientId !== clientId) {
        return tokenError(c, "invalid_grant", "refresh token was issued to another client")
      }
      if (resource !== undefined && resource !== record.resource) {
        return tokenError(c, "invalid_target", "refresh token was issued for another resource")
      }
      const granted = new Set(record.scope === "" ? [] : record.scope.split(" "))
      const scope = params.has("scope") ? grantedScope(params.get("scope"), granted) : record.scope
      if (scope === undefined) return tokenError(c, "invalid_scope", "scope exceeds the grant")
      return await issueTokens(c, { ...record, scope })
    }

    return tokenError(c, "unsupported_grant_type", "grant_type is not supported")
  })

  return { app, metadata, verifier: createAccessTokenVerifier(store, clock) }
}
