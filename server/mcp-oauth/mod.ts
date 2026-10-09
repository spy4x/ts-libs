/**
 * Single-user OAuth 2.1 for remote MCP connectors: the authorization server, the resource-server
 * guard, and the pieces they are built from. See the `server/mcp-oauth` section of the README.
 * @module
 */

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
  TOKEN_PATH,
} from "./authorization-server.ts"
export {
  type ClientMetadata,
  type ClientMetadataFetcherOptions,
  type ClientMetadataSource,
  createClientMetadataFetcher,
  isClientIdUrl,
} from "./client-metadata.ts"
export type {
  AccessTokenRecord,
  CodeRecord,
  OAuthStore,
  PendingAuthorization,
  RefreshTokenRecord,
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
