/**
 * The resource-server half: the protected resource metadata document (RFC 9728) and a Hono guard
 * that answers `401` with a `WWW-Authenticate: Bearer resource_metadata="…"` challenge and accepts
 * only access tokens issued for this exact resource.
 * @module
 */

import type { Handler, MiddlewareHandler } from "hono"
import { sha256Hex } from "@spy4x/platform/tokens"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"
import { bearerTokenFromHeaders } from "../http/bearer-auth.ts"
import type { OAuthStore } from "./model.ts"

/** The well-known path prefix of a protected resource metadata document. */
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource"

/** Longest access token the verifier will look up. Ours are 43 characters. */
const MAX_TOKEN_LENGTH = 512

/**
 * The canonical form of a resource URL (RFC 8707, as the MCP spec uses it): parsed by `URL`, so
 * scheme and host are lower case and a default port is dropped, and without the trailing `/` of a
 * bare origin. `https:` is required, except `http:` on a loopback host for local development.
 * Returns `undefined` for anything else, and for a URL with a fragment or user info.
 */
export function canonicalResource(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && loopback)
  if (!scheme || url.hash !== "" || value.includes("#")) return undefined
  if (url.username !== "" || url.password !== "") return undefined
  return url.pathname === "/" && url.search === "" ? url.origin : url.href
}

/** One scope token as RFC 6749 section 3.3 defines it: printable ASCII but space, `"` and `\`. */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

/**
 * Check a configured scope list at startup.
 *
 * @throws {TypeError} Naming the first entry that is not a valid scope token.
 */
export function assertScopes(scopes: readonly string[]): void {
  for (const scope of scopes) {
    if (!SCOPE_TOKEN.test(scope)) throw new TypeError(`invalid scope ${JSON.stringify(scope)}`)
  }
}

/** What a valid access token grants. */
export interface VerifiedAccessToken {
  /** The `client_id` the token was issued to. */
  clientId: string
  /** The canonical resource the token is bound to. */
  resource: string
  /** Granted scopes, space separated; empty when none were asked for. */
  scope: string
  /** Epoch milliseconds when the token stops working. */
  expiresAt: number
}

/** Looks up an access token. */
export interface AccessTokenVerifier {
  /** The grant behind an unexpired token, or `undefined`. Does not check the audience. */
  verify(token: string): Promise<VerifiedAccessToken | undefined>
}

/**
 * Build an {@link AccessTokenVerifier} over the authorization server's store. Use it in a resource
 * server that runs apart from the authorization server but shares its store.
 */
export function createAccessTokenVerifier(
  store: OAuthStore,
  clock: Clock = systemClock,
): AccessTokenVerifier {
  return {
    async verify(token) {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return undefined
      const record = await store.findAccessToken(await sha256Hex(token))
      if (record === undefined || record.expiresAt <= clock.now()) return undefined
      return {
        clientId: record.clientId,
        resource: record.resource,
        scope: record.scope,
        expiresAt: record.expiresAt,
      }
    },
  }
}

/** Options for {@link createResourceServer}. */
export interface ResourceServerOptions {
  /** This MCP server's URL exactly as the user enters it in Claude, path included. */
  resource: string
  /** The issuer of the authorization server, listed as the one entry of `authorization_servers`. */
  issuer: string
  /** Checks presented tokens: the authorization server's `verifier`, or one over its store. */
  verifier: AccessTokenVerifier
  /** `scopes_supported`, and the `scope` of the `401` challenge. Omitted when empty. */
  scopes?: readonly string[]
}

/** The protected resource metadata document (RFC 9728). */
export interface ProtectedResourceMetadata {
  resource: string
  authorization_servers: string[]
  bearer_methods_supported: string[]
  scopes_supported?: string[]
}

/** Hono variables the guard sets. */
export interface ResourceGuardEnv {
  Variables: {
    /** The grant behind the request's access token. */
    oauth: VerifiedAccessToken
  }
}

/** What {@link createResourceServer} returns. */
export interface ResourceServer {
  /** The canonical resource URL. */
  resource: string
  /** The path to serve {@link ResourceServer.metadataHandler} at, on the resource's origin. */
  metadataPath: string
  /** The absolute URL the `401` challenge points to. */
  metadataUrl: string
  /** The document itself. */
  metadata: ProtectedResourceMetadata
  /** Serves the document as JSON. */
  metadataHandler: Handler
  /** Refuses a request without a valid token for this resource; sets `c.var.oauth` otherwise. */
  guard: MiddlewareHandler<ResourceGuardEnv>
}

/**
 * Build the metadata document and the guard for one MCP server. Mount the handler at
 * `metadataPath` and the guard in front of the MCP endpoint:
 *
 * ```ts
 * const rs = createResourceServer({ resource: "https://mcp.example.com/mcp", issuer, verifier })
 * app.get(rs.metadataPath, rs.metadataHandler)
 * app.use("/mcp", rs.guard)
 * ```
 *
 * A request with no token gets `401` and `WWW-Authenticate: Bearer resource_metadata="…"`; one
 * with an unknown, expired or other-resource token gets the same plus `error="invalid_token"`.
 * The token is read from the `Authorization` header only, never from the query string.
 *
 * @throws {TypeError} When `resource` or `issuer` is not a valid resource URL.
 */
export function createResourceServer(options: ResourceServerOptions): ResourceServer {
  const resource = canonicalResource(options.resource)
  if (resource === undefined) throw new TypeError(`invalid resource URL ${options.resource}`)
  const issuer = canonicalResource(options.issuer)
  if (issuer === undefined) throw new TypeError(`invalid issuer URL ${options.issuer}`)
  const url = new URL(resource)
  const metadataPath = PROTECTED_RESOURCE_METADATA_PATH + (url.pathname === "/" ? "" : url.pathname)
  const metadataUrl = url.origin + metadataPath
  const scopes = options.scopes ?? []
  assertScopes(scopes)
  const metadata: ProtectedResourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    ...(scopes.length > 0 ? { scopes_supported: [...scopes] } : {}),
  }
  const scopeParam = scopes.length > 0 ? `, scope="${scopes.join(" ")}"` : ""
  const challenge = (error?: string) =>
    "Bearer " + (error ? `error="${error}", ` : "") + `resource_metadata="${metadataUrl}"` +
    scopeParam

  const guard: MiddlewareHandler<ResourceGuardEnv> = async (c, next) => {
    const token = bearerTokenFromHeaders(c.req.raw.headers)
    if (token === undefined) {
      c.header("WWW-Authenticate", challenge())
      // RFC 6750 section 3.1: a request that carries no credentials gets no error code.
      return c.text("Authentication required", 401)
    }
    const verified = await options.verifier.verify(token)
    if (verified === undefined || verified.resource !== resource) {
      c.header("WWW-Authenticate", challenge("invalid_token"))
      return c.json({ error: "invalid_token", error_description: "Token invalid or expired" }, 401)
    }
    c.set("oauth", verified)
    await next()
  }

  return {
    resource,
    metadataPath,
    metadataUrl,
    metadata,
    metadataHandler: (c) => c.json(metadata),
    guard,
  }
}
