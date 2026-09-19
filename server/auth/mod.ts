/**
 * The `@ts-libs/server/auth` surface.
 *
 * Import from a subpath when only one piece is wanted (`@ts-libs/server/auth/otp`
 * for the code path, `@ts-libs/server/auth/types` for a contract) and from here
 * when assembling the whole thing.
 */

export * from "./types.ts"
export * from "./constants.ts"
export * from "./crypto.ts"
export * from "./events.ts"
export * from "./random.ts"
export * from "./session.ts"
export * from "./cache.ts"
export * from "./account-linking.ts"
export { Auth, createAuth } from "./lib.ts"
export type { AuthOptions, OAuth2InstanceOptions } from "./lib.ts"
export { KeyManager } from "./managers/key.ts"
export type { NewKey } from "./managers/key.ts"
export { UserManager } from "./managers/user.ts"
export { AnonymousProvider } from "./providers/anonymous.ts"
export type { AnonymousProviderOptions } from "./providers/anonymous.ts"
export { EmailPasswordProvider } from "./providers/email-password.ts"
export type { EmailPasswordProviderOptions } from "./providers/email-password.ts"
export { MagicLinkProvider } from "./providers/magic-link.ts"
export type { MagicLinkProviderOptions } from "./providers/magic-link.ts"
export { OtpProvider } from "./providers/otp.ts"
export type { OtpProviderOptions } from "./providers/otp.ts"
export { OAuth2FlowError, OAuth2Provider } from "./providers/oauth2.ts"
export type { OAuth2Profile, OAuth2ProviderOptions } from "./providers/oauth2.ts"
export type { EventPublisher, ProviderDeps } from "./providers/provider.ts"
export { PostgresAdapter, REQUIRED_COLUMNS } from "./postgres-adapter.ts"
export type { Sql } from "./postgres-adapter.ts"
export { MemoryAdapter, MemoryAdapterConstraintError } from "./testing/memory-adapter.ts"
