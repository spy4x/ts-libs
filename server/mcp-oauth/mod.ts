/**
 * Single-user OAuth 2.1 for remote MCP connectors: the authorization server, the resource-server
 * guard, and the pieces they are built from. See the `server/mcp-oauth` section of the README.
 * @module
 */

export {
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
