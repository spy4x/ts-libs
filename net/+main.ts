/**
 * `@spy4x/net` — outbound-request primitives.
 *
 * Three layers, usable independently:
 *
 *  - `normalizeUrlShape()` — pure shape normalisation for a user-entered URL.
 *    No DNS, no fetching. Use it in a form or a settings field.
 *  - `validatePublicUrl()` — the SSRF guard. Adds scheme/host policy, special-use
 *    host rejection, IP-routability checks and DNS resolution. Use it before any
 *    request issued on a user's behalf. Needs `--allow-net` for the default
 *    resolver, or an injected `DnsResolver`.
 *  - `safeFetch()` — `validatePublicUrl()` applied to a request *and* to every
 *    redirect target, with one abort budget for the whole chain.
 *
 * `bounded-body.ts` is re-exported alongside: reading a response under a hard
 * byte cap and a stall budget is the other half of fetching safely.
 *
 * Zero runtime dependencies — `URL`, `Deno.resolveDns`, `ReadableStream`,
 * `TextDecoder` and `AbortController` only.
 */

export {
  ALLOWED_PROTOCOLS,
  detectScheme,
  EXPLICIT_SCHEME,
  INVALID_CHARACTERS,
  isUrlShapeOk,
  normalizeUrlShape,
  PLAIN_HOSTNAME,
} from "./url-shape.ts"
export type {
  NormalizeUrlShapeResult,
  UrlShapeError,
  UrlShapeErrorCode,
  UrlShapeOk,
} from "./url-shape.ts"

export {
  defaultResolver,
  DENY_NET_ADDRESSES,
  denyNetFlag,
  DnsResolutionError,
  isLocalHostname,
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
  parseIpv6Groups,
  UrlValidationError,
  validatePublicUrl,
} from "./url-policy.ts"
export type { DnsResolver, UrlPolicyErrorCode, ValidatePublicUrlOptions } from "./url-policy.ts"

export {
  CREDENTIAL_HEADERS,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  defaultFetcher,
  safeFetch,
  SafeFetchMethod,
} from "./safe-fetch.ts"
export type { Fetcher, SafeFetchOptions, SafeFetchResult } from "./safe-fetch.ts"

export {
  BodyReadErrorCode,
  BodyReadTimeoutError,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  readContentLength,
} from "./bounded-body.ts"
export type { BodyReadOptions, BodySource } from "./bounded-body.ts"
