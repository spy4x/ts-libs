/**
 * Single-user OAuth 2.1 for remote MCP connectors: the authorization server, the resource-server
 * guard, and the pieces they are built from. See the `server/mcp-oauth` section of the README.
 *
 * A single-user OAuth 2.1 authorization server, so one person can connect their own remote MCP
 * server to claude.ai, the Claude apps and Claude Code, plus the Hono guard the MCP server puts in
 * front of its endpoint. It follows Claude's connector requirements
 * (<https://claude.com/docs/connectors/building/authentication>) and the MCP authorization spec
 * (2025-11-25).
 *
 * The authorization server and the MCP server run on two hosts. Every route to the issuer's host
 * passes Authelia's forward-auth, and `/authorize` requires a signed-in owner there. Clients call
 * `/token` and the metadata documents without a browser session, so Authelia bypasses those paths
 * for the issuer's host. The MCP host cannot sit behind forward-auth, because Claude calls it with a
 * bearer token and no browser session.
 *
 * ```ts
 * import { Hono } from "hono"
 * import {
 *   createAuthorizationServer,
 *   createClientMetadataFetcher,
 *   createResourceServer,
 * } from "@spy4x/server/mcp-oauth"
 * import { MemoryOAuthStore } from "@spy4x/server/mcp-oauth/memory-store"
 *
 * const issuer = "https://auth.example.com"
 * const resource = "https://mcp.example.com/mcp"
 * const as = createAuthorizationServer({
 *   issuer,
 *   resources: [resource],
 *   store: new MemoryOAuthStore(),
 *   // Fetch client documents only from Claude's host; see "Trust only the clients you use" below.
 *   clients: createClientMetadataFetcher({ trustedHosts: ["claude.ai"] }),
 *   // Trustworthy only because every route to auth.example.com passes forward-auth,
 *   // which strips a Remote-User header the client sent.
 *   confirmOwner: (c) => c.req.header("remote-user") === "owner",
 * })
 * const authApp = new Hono().route("/", as.app) // served on auth.example.com only
 *
 * const rs = createResourceServer({ resource, issuer, verifier: as.verifier })
 * const mcpApp = new Hono() // served on mcp.example.com; never mount as.app here
 * mcpApp.get(rs.metadataPath, rs.metadataHandler)
 * mcpApp.use("/mcp", rs.guard)
 * ```
 *
 * Forward-auth on the MCP host would break Claude, so `as.app` must not be reachable there. If it
 * were, anyone could send `Remote-User: owner` and approve themselves. As a second line,
 * `/authorize` answers `403` to any request whose host is not the issuer's. In a real deployment the
 * two hosts share one store: one process serving both, or a shared `OAuthStore`.
 *
 * **Trust only the clients you use.** Anyone can call `GET /authorize`, and the `client_id` they name
 * is a URL the server fetches. The default fetcher fetches any public URL, through the SSRF guard
 * below, so an anonymous caller chooses where your server sends requests. In production, pass
 * `createClientMetadataFetcher({ trustedHosts: ["claude.ai"] })` as `clients`, as the example does.
 * Claude's documents are `https://claude.ai/oauth/mcp-oauth-client-metadata` (claude.ai and the
 * Claude apps) and `https://claude.ai/oauth/claude-code-client-metadata` (Claude Code), so that one
 * host covers all of them. The default stays open because narrowing it would break every app that
 * serves another client today.
 *
 * **The metadata cache is capped.** A fetched document is reused for `cacheMs` (10 minutes). The cache
 * keeps at most `maxEntries` documents (default 1 000, about 5 MB): storing one first drops expired
 * entries, then the oldest while the cache is full, so a caller naming endless `client_id` URLs cannot
 * grow it.
 *
 * **Pending consents are capped.** Each `GET /authorize` stores a pending consent of up to about
 * 5 KB for 10 minutes, for anyone who calls it. `MemoryOAuthStore` keeps at most `maxPending` of them
 * (default 1 000, about 5 MB) and drops the oldest when a new one would pass the cap; the owner then
 * reloads the sign-in. `KvOAuthStore` keeps them on disk with no cap; rate-limit `/authorize` to bound
 * that.
 *
 * ## What it does
 *
 * - **Discovery.** `GET /.well-known/oauth-authorization-server` advertises S256 PKCE, public
 *   clients (`none`) and `client_id_metadata_document_supported`, the pair Claude needs before it
 *   uses a Client ID Metadata Document. The resource server serves its RFC 9728 document at
 *   `/.well-known/oauth-protected-resource/<path>`, and its `401` carries
 *   `WWW-Authenticate: Bearer resource_metadata="…"`.
 * - **Clients.** A `client_id` is an HTTPS URL. The server fetches the JSON document there through
 *   the SSRF guard of `@spy4x/net/safe-fetch` (no redirects, 5 KiB cap, 5 seconds for the whole
 *   fetch including the body, cached 10 minutes) and accepts it only when it is served as JSON, its
 *   `client_id` equals the URL, and it asks for no client secret. The self-asserted `client_name` is
 *   shown without control or format characters and cut to 100 characters. `trustedHosts` narrows
 *   which hosts may serve one.
 * - **Run with `--deny-net`.** The SSRF guard checks the address a host resolves to, but `fetch`
 *   resolves it again, so a DNS-rebinding host can pass the check and then point at a private
 *   address. Deno's `--deny-net` is checked at connect time and closes that gap: start the server
 *   with the flag `denyNetFlag()` from `@spy4x/net/url-policy` returns. It denies loopback and the
 *   private ranges, so the process cannot reach a database or service on those addresses either;
 *   see `net/README.md` for what it covers and what it cannot.
 * - **Redirects.** The redirect URI must be on the server's allowlist and in the client's own
 *   document. The default allowlist is `https://claude.ai/api/mcp/auth_callback` plus
 *   `http://localhost/callback` and `http://127.0.0.1/callback`, which match on any port for Claude
 *   Code. Until the redirect URI has passed, a refusal is a `400` page, never a redirect.
 * - **Consent.** `GET /authorize` answers `403` unless the request's host is the issuer's, then
 *   calls `confirmOwner` (when set) and does nothing else for anyone else. It then shows a consent page naming
 *   the client's host and the redirect host, asking the owner to approve only a sign-in they just
 *   started, with an extra warning when the code goes to a loopback address. The page cannot be
 *   framed. Approving posts a single-use, 10-minute consent id back to `/authorize`; that post must
 *   reach the issuer's host, be same-origin, pass `confirmOwner` again and, with `ownerPassword`
 *   set, carry the owner password. `renderConsent` replaces the built-in page.
 * - **Codes.** Single-use, 60 seconds, bound to the client, redirect URI, PKCE challenge and
 *   resource. A replayed code is refused and revokes every token the first exchange issued.
 * - **Tokens.** Opaque 256-bit random strings; the store keeps only their SHA-256 digest. Access
 *   tokens last 15 minutes and are bound to one resource: the guard refuses a token issued for
 *   another MCP server. Refresh tokens last 30 days and rotate on every use; a reused one revokes the
 *   whole grant. A grant ends 90 days after the owner approved it (`grantTtlMs`): rotation never
 *   moves that end, and no token outlives it, so the owner approves each client again at least that
 *   often. A revoked grant also refuses tokens saved after the revocation, so a replay that
 *   races the first redemption leaves no working token. A refresh that names another resource or a
 *   wider scope is refused without spending the token; one from another client spends it. The PKCE
 *   verifier is compared in constant time. `offline_access` is accepted but not advertised, since
 *   refresh tokens are always issued.
 * - **Revocation.** `POST /revoke` (RFC 7009) lets a client sign itself out. It takes `token` and
 *   an optional `token_type_hint`, which is ignored: both kinds are looked up. A refresh token
 *   revokes its whole grant, as a reused one does, and an access token only itself. The answer is
 *   `200` with an empty body whether the token was live, unknown, expired or already revoked, so the
 *   endpoint cannot be used to find out which tokens exist. Like `/token`, it takes public clients
 *   only: client authentication answers `401 invalid_client`. The metadata advertises it as
 *   `revocation_endpoint`.
 * - **Errors.** RFC 6749 codes: `invalid_grant` for every bad code or refresh token, `invalid_target`
 *   for a foreign resource, `invalid_client` for any client authentication.
 *
 * ## Without forward-auth: `ownerPassword`
 *
 * An app with no forward-auth in front of `/authorize` asks the owner for a password on the consent
 * page instead of passing `confirmOwner`. Make the hash once with the `password-hash` CLI of
 * `server/sign-in`, under the pepper the app runs with:
 *
 * ```ts
 * import { createPasswordHasher } from "@spy4x/server/sign-in"
 *
 * const as = createAuthorizationServer({
 *   issuer,
 *   resources: [resource],
 *   store,
 *   ownerPassword: {
 *     hash: Deno.env.get("OWNER_PASSWORD_HASH")!,
 *     hasher: createPasswordHasher({ pepper: Deno.env.get("AUTH_PEPPER")! }),
 *   },
 * })
 * ```
 *
 * The default consent page then shows a labelled password input named `owner_password`
 * (`OWNER_PASSWORD_FIELD`; a custom `renderConsent` gets it as `passwordField`). Showing the page needs
 * no password, since nothing is granted until the form is submitted. Approving needs it; denying does
 * not, because a denial only sends the client away with `access_denied`. A missing password (`400`) or
 * a wrong one (`403`) shows the page again with the error in a `role="alert"` paragraph tied to the
 * input, and the same consent can still be approved. With both `confirmOwner` and `ownerPassword`
 * set, both must pass: `confirmOwner` on every request, the password on an approval. At least one of
 * them is required.
 *
 * **Wrong passwords are capped per address.** After 10 wrong passwords from one client address within
 * 15 minutes, that address's approvals answer `429` with a `Retry-After` header until the oldest of
 * them is 15 minutes old; the owner can still approve from another address. After 100 wrong
 * passwords from all addresses together within 24 hours, every approval answers `429`: that ceiling
 * stops guessing spread over many addresses. A locked-out approval is refused before the hasher runs,
 * so a flood of guesses costs no PBKDF2 work. The counts live in the store, so `KvOAuthStore` keeps
 * them across a restart. Only wrong passwords count: a missing one and the right one do not. Denials
 * and tokens already issued keep working.
 *
 * Pass `clientAddress` so the server knows the address. Use the same one the app's rate limiter
 * uses, read through the same trusted proxies, or a client can pick its own by sending a forged
 * `X-Forwarded-For`:
 *
 * ```ts
 * import { clientIp, clientIpBucket } from "@spy4x/platform/rate-limit/client-ip"
 *
 * ownerPassword: {
 *   hash,
 *   hasher,
 *   // One IPv6 /64 counts as one address, as it does for the rate limiter.
 *   clientAddress: (c) =>
 *     clientIpBucket(clientIp(c.req.raw, peerAddress, "x-forwarded-for", { trustedProxies })),
 * }
 * ```
 *
 * Without `clientAddress`, every request shares one address, so a single guesser locks the owner
 * out. Change the caps with `maxFailures` and `windowMs` per address, and `maxTotalFailures` (ten
 * times `maxFailures` by default, and always more) and `totalWindowMs` for the server.
 *
 * When a burst of parallel guesses keeps rewriting the server-wide count, `KvOAuthStore` gives up
 * after 32 conflicting writes. The approval then answers `429` with `Retry-After: 1`, the consent
 * stays usable, and the attempt is not counted against the address.
 *
 * The trade-off: anyone who can reach `POST /authorize` can keep every approval refused. The
 * server-wide ceiling is 100 wrong passwords a day by default, and one address may send 10 every 15
 * minutes, so one address reaches it in two and a half hours and ten addresses in a minute. After
 * that, about 100 wrong passwords a day keep it reached, for as long as the sender keeps going. With
 * `KvOAuthStore` a restart does not end it. Clients that already have tokens are not affected; only
 * new approvals are refused.
 *
 * No design avoids this without a cost: the ceiling exists to cap guesses that come from many
 * addresses, so lifting it for an unknown address would hand every new address a free guess. To make
 * it harder, put a rate limiter per address in front of `POST /authorize`
 * (`@spy4x/platform/rate-limit/hono`), block the sending addresses at the proxy, or raise
 * `maxTotalFailures`. To take it away, put `/authorize` behind forward-auth and pass `confirmOwner`
 * instead of `ownerPassword`: the owner then signs in at the proxy, and wrong passwords sent to the app
 * cannot block that.
 *
 * ## Approving while the limit is reached
 *
 * Two ways let the owner approve while wrong passwords keep every approval refused.
 *
 * **A. Forward-auth, where a proxy exists: preferred.** Put `/authorize` behind an identity-aware
 * proxy such as Authelia and pass `confirmOwner` instead of `ownerPassword`, as the first example
 * does. The owner signs in at the proxy, so wrong passwords sent to the app cannot lock them out, and
 * there is no lockout to work around.
 *
 * **B. A one-time approval code, from a shell.** For an app without a proxy, `createApprovalCode`
 * makes a code the owner types into the consent page's password input instead of the password. It
 * approves one pending consent, and neither the password check nor the lockout applies to it. Wrap it
 * in the app's command-line interface, run where the app's store lives:
 *
 * ```ts
 * import { createApprovalCode } from "@spy4x/server/mcp-oauth"
 * import { KvOAuthStore } from "@spy4x/server/mcp-oauth/kv-store"
 *
 * const kv = await Deno.openKv(path) // the database the app's KvOAuthStore uses
 * const { code, expiresAt } = await createApprovalCode(new KvOAuthStore(kv))
 * console.log(`Type this into the password field before ${new Date(expiresAt)}: ${code}`)
 * kv.close()
 * ```
 *
 * A code is `approve_` followed by 43 base64url characters (256 random bits; `APPROVAL_CODE_SHAPE`),
 * and the store keeps only its SHA-256 digest. The server looks a typed value up as a code only when
 * it has that shape, so a typed password never reaches the store, not even as a digest. The first
 * approval spends it, atomically, so two parallel approvals cannot both use it; a denial does not
 * spend it. It stops working after 5 minutes (`ttlMs`, at most 15 minutes). No route of the
 * authorization server makes one, so only someone with a shell on the server can. A code needs the
 * same store the server uses, so it cannot work with `MemoryOAuthStore` from another process.
 *
 * To let the owner in another way while it lasts, delete the server-wide count. It is the key
 * `[...prefix, "attempts", "total"]` (`["mcp-oauth", "attempts", "total"]` with the default prefix).
 * The store reads it on every approval, so no restart is needed. `MemoryOAuthStore` starts empty on
 * every restart.
 *
 * ```ts
 * const kv = await Deno.openKv(path) // the database the app's KvOAuthStore uses
 * await kv.delete(["mcp-oauth", "attempts", "total"])
 * kv.close()
 * ```
 *
 * The sender's next wrong passwords count again, so block them first.
 *
 * ## Listing and revoking grants
 *
 * Each redeemed code saves a `GrantRecord`: the client, the resource, the scope, when it started and
 * when it ends. `store.listGrants()` returns the grants that have not ended, oldest first, so the
 * owner can see which clients are connected. `store.revokeGrant(grant.grantId, grant.expiresAt)`
 * signs one client out: it deletes the grant's tokens and record and refuses new tokens for it until
 * the grant would have ended anyway. Every other client stays signed in.
 *
 * ```ts
 * const grants = await store.listGrants()
 * for (const grant of grants) {
 *   console.log(grant.grantId, new URL(grant.clientId).host, new Date(grant.createdAt))
 * }
 * const grant = grants[0] // the one to sign out
 * await store.revokeGrant(grant.grantId, grant.expiresAt)
 * ```
 *
 * A grant issued before this release has no record until its client next refreshes, at most an
 * access-token lifetime after the client is next used. Its 90 days start from that refresh.
 *
 * `MemoryOAuthStore` signs every client out on a restart or deploy. `KvOAuthStore` keeps the same
 * records in Deno KV, which needs no service beside the app: open the database on a mounted volume
 * and run the app with `--unstable-kv`.
 *
 * ```ts
 * import { KvOAuthStore } from "@spy4x/server/mcp-oauth/kv-store"
 *
 * const kv = await Deno.openKv("/data/oauth.kv") // a path on the mounted volume
 * const store = new KvOAuthStore(kv) // keys under ["mcp-oauth"]; pass `prefix` to change that
 * ```
 *
 * Every write is one atomic operation. Taking a pending consent and redeeming a code or a refresh
 * token read the record and commit with a versionstamp check, retrying on a conflict, so of two
 * concurrent redemptions only one succeeds. Each record is written with `expireIn` set from its
 * `expiresAt`, so Deno KV deletes it once it has expired. A token is saved with a check on its
 * grant's revocation key, and `revokeGrant` finds a grant's tokens through an index
 * `[...prefix, "grant", grantId, kind, key]`. Grant records sit under `[...prefix, "grants", grantId]`
 * password attempt counts under `[...prefix, "attempts", key]`, and approval codes under
 * `[...prefix, "approval", key]`. Another process can open the same
 * file to list or revoke grants while the app runs. The store does not close the handle.
 *
 * ## What it does not do
 *
 * - No dynamic client registration. Claude, the Claude apps and Claude Code all use a Client ID
 *   Metadata Document when the metadata advertises it, so the registration endpoint would only add
 *   attack surface.
 * - No confidential clients, no `client_credentials` grant, no OpenID Connect.
 * - No rate limiting beyond the cap on wrong owner passwords: mount
 *   `@spy4x/platform/rate-limit/hono` in front of `/authorize` and `/token`.
 * - No store over another database. `MemoryOAuthStore` loses every grant on restart, after which
 *   Claude asks the owner to connect again; `KvOAuthStore` keeps them. For anything else, implement
 *   `OAuthStore` and run it through the same rules; `consumeCode`, `consumeRefreshToken`,
 *   `takePending`, `takeApprovalCode` and `takeAttempt` must be atomic.
 * - No issuer with a path: the issuer is a bare origin, and the endpoints sit at its root.
 *
 * @module
 */

export {
  APPROVAL_CODE_PREFIX,
  APPROVAL_CODE_SHAPE,
  type ApprovalCode,
  type ApprovalCodeOptions,
  createApprovalCode,
  DEFAULT_APPROVAL_CODE_TTL_MS,
  MAX_APPROVAL_CODE_TTL_MS,
} from "./approval-code.ts"
export {
  AUTHORIZATION_SERVER_METADATA_PATH,
  type AuthorizationServer,
  type AuthorizationServerMetadata,
  type AuthorizationServerOptions,
  AUTHORIZE_PATH,
  type ConsentDetails,
  createAuthorizationServer,
  defaultConsentPage,
  OFFLINE_ACCESS_SCOPE,
  OWNER_PASSWORD_FIELD,
  type OwnerPassword,
  REVOKE_PATH,
  TOKEN_PATH,
} from "./authorization-server.ts"
export {
  type ClientMetadata,
  type ClientMetadataFetcherOptions,
  type ClientMetadataSource,
  createClientMetadataFetcher,
  isClientIdUrl,
} from "./client-metadata.ts"
export {
  type AccessTokenRecord,
  type ApprovalCodeRecord,
  type CodeRecord,
  type GrantRecord,
  type OAuthStore,
  OAuthStoreContentionError,
  type PendingAuthorization,
  type RefreshTokenRecord,
} from "./model.ts"
export {
  assertRedirectAllowlist,
  CLAUDE_REDIRECT_URI,
  DEFAULT_REDIRECT_URIS,
  isLoopbackRedirect,
  redirectUriMatches,
} from "./redirect-uri.ts"
export {
  type AccessTokenVerifier,
  assertScopes,
  canonicalResource,
  createAccessTokenVerifier,
  createResourceServer,
  PROTECTED_RESOURCE_METADATA_PATH,
  type ProtectedResourceMetadata,
  type ResourceGuardEnv,
  type ResourceServer,
  type ResourceServerOptions,
  type VerifiedAccessToken,
} from "./resource-server.ts"
