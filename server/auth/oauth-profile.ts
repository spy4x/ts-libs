/**
 * Cleans the display fields of an {@link OAuthProfile}: the person's name and avatar URL. Both are
 * text a provider sends and anyone can set on their provider account, so they are untrusted. The
 * readers in `oauth-google.ts` and `oauth-github.ts` clean them, and `createOAuthSignIn` cleans
 * every profile again, so a provider config an app writes cannot pass them through raw either.
 * Internal: not an entry point of the package; `oauth.ts` re-exports the two limits.
 *
 * @module
 */

import type { OAuthProfile } from "./oauth.ts"

/** Longest {@link OAuthProfile.name} kept, in UTF-16 code units; a longer name is cut. */
export const MAX_OAUTH_NAME_LENGTH = 200
/** Longest {@link OAuthProfile.avatarUrl} kept, in characters; a longer URL is dropped. */
export const MAX_OAUTH_AVATAR_URL_LENGTH = 2048

/** A lone surrogate: half of a surrogate pair without its other half. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** `value` without the characters no database text column stores: NUL and lone surrogates. */
function dropUnstorable(value: string): string {
  return value.replaceAll("\u0000", "").replace(LONE_SURROGATE, "")
}

/**
 * The provider's name for the person, ready to show and store: NUL and lone surrogates dropped,
 * trimmed, and cut to {@link MAX_OAUTH_NAME_LENGTH} without splitting a surrogate pair. Undefined
 * when `value` is not a string or nothing is left.
 */
export function cleanOAuthName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  let name = dropUnstorable(value).trim()
  if (name.length > MAX_OAUTH_NAME_LENGTH) {
    // Cutting can leave the high half of a pair at the end; dropping it again removes that half.
    name = dropUnstorable(name.slice(0, MAX_OAUTH_NAME_LENGTH)).trimEnd()
  }
  return name === "" ? undefined : name
}

/**
 * The provider's picture of the person as an absolute `https:` URL, normalised by `URL`, or
 * undefined when `value` is not a string, not an `https:` URL, carries a user name or password, or
 * is longer than {@link MAX_OAUTH_AVATAR_URL_LENGTH}. Anything else (`javascript:`, `data:`,
 * `http:`) would let a provider account choose what a page loads or runs.
 */
export function cleanOAuthAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_OAUTH_AVATAR_URL_LENGTH) return undefined
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined
  // `href` is ASCII (non-ASCII is percent- or punycode-encoded), but it can grow while encoding.
  return url.href.length > MAX_OAUTH_AVATAR_URL_LENGTH ? undefined : url.href
}

/**
 * A profile whose display fields are not checked yet: `name` and `avatarUrl` may be anything a
 * provider sent.
 */
export type UncleanOAuthProfile = Omit<OAuthProfile, "name" | "avatarUrl"> & {
  name?: unknown
  avatarUrl?: unknown
}

/**
 * `profile` with `name` and `avatarUrl` cleaned by {@link cleanOAuthName} and
 * {@link cleanOAuthAvatarUrl}. A field that does not survive is left out, not set to undefined.
 * Every other field is kept as it was.
 */
export function cleanOAuthProfile(profile: UncleanOAuthProfile): OAuthProfile {
  const { name, avatarUrl, ...rest } = profile
  const cleaned: OAuthProfile = rest
  const cleanName = cleanOAuthName(name)
  if (cleanName !== undefined) cleaned.name = cleanName
  const cleanAvatarUrl = cleanOAuthAvatarUrl(avatarUrl)
  if (cleanAvatarUrl !== undefined) cleaned.avatarUrl = cleanAvatarUrl
  return cleaned
}
