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
 * `redirect-path.ts` checks a "go here next" value, such as `?next=` after
 * sign-in, so following it cannot leave the site.
 *
 * `ip.ts` parses one IP address into a canonical spelling and checks it against
 * CIDR ranges, for example to trust a header only from a known proxy, and masks
 * one for display.
 *
 * `user-agent.ts` turns a `User-Agent` header into a display label such as
 * "Safari on iPhone", for a list of signed-in devices.
 *
 * Zero runtime dependencies — `URL`, `Deno.resolveDns` (`node:dns/promises` on
 * Node and Bun), `ReadableStream`, `TextDecoder` and `AbortController` only.
 *
 * | You have                        | You need                                     | Call                           |
 * | ------------------------------- | -------------------------------------------- | ------------------------------ |
 * | A URL a user typed into a form  | To reject typos and non-http schemes         | `normalizeUrlShape(input)`     |
 * | A URL you are about to request  | To know the destination is publicly routable | `validatePublicUrl(input)`     |
 * | A URL plus redirects            | To know every hop is publicly routable       | `safeFetch(input)`             |
 * | A response body of unknown size | To read it without OOM or hanging            | `readBoundedText(response, …)` |
 *
 * `normalizeUrlShape()` is pure: no DNS, no I/O, no permissions. It trims, adds a
 * missing `https://`, lowercases the scheme and host, strips a default port, keeps
 * everything else, and refuses non-http(s) schemes and hostnames without a dot.
 * Use it for input fields — a user typing `example.com/foo` should see the
 * normalised value immediately, and a request is not being made.
 *
 * `validatePublicUrl()` layers the security check on top: it parses, rejects
 * special-use hostnames and embedded credentials, then verifies the destination is
 * globally routable — IP literals against the classifier tables, DNS names by
 * resolving A **and** AAAA and refusing the URL if **any** answer is non-public or
 * the lookup fails. Use it before issuing any request on a user's behalf.
 *
 * They are separate exports and neither calls the other, on purpose:
 *
 * - shape refuses anything whose host has no dot, so `localhost`, `127.0.0.1` and
 *   `[::1]` arrive from shape as `invalid_hostname`. That is right for a form
 *   ("that is not a domain") and wrong for the guard, which must report
 *   `special_use` / `non_public_ip` so a caller can branch and log accurately.
 * - shape drops nothing but the default port; the guard must keep a non-default
 *   port and canonicalise the rest through the parser.
 * - only the guard needs `--allow-net`. A caller that never leaves shape pays
 *   nothing and grants nothing.
 *
 * Both share one implementation of everything above the host rules — scheme
 * detection, the invalid-character pattern, the parse step and the error messages
 * — so the two can never disagree about what a URL _is_, only about which hosts
 * are allowed.
 *
 * ## Permissions
 *
 * `validatePublicUrl()` and `safeFetch()` need `--allow-net` **only to run DNS
 * resolution**. Nothing here makes a network request of its own; `safeFetch` does,
 * through the platform `fetch`, and that needs `--allow-net` regardless.
 *
 * ```bash
 * deno run --allow-net server.ts                       # default resolver
 * deno test --no-prompt --allow-read --allow-env       # this package's tests: hermetic
 * ```
 *
 * `normalizeUrlShape()` and `bounded-body.ts` need no permissions at all.
 *
 * ## Explicitly out of scope
 *
 * - **No caching, retries or circuit breaking.** Wrap `safeFetch` or use a client
 *   built on it.
 * - **No response-body policy.** Size and time only; content type, charset and
 *   malware scanning belong to the caller.
 * - **No DNS pinning.** The guard resolves a host and then `fetch` resolves it
 *   again. Pinning the connection to the address that was checked needs a custom
 *   dispatcher, which the platform `fetch` does not expose. The gap is real, and
 *   from outside the module it is narrowed rather than closed: with the
 *   `--deny-net` list a second answer of `127.0.0.1`, `[::1]` or `[::]` is refused
 *   at connect time, and a second answer of `0.0.0.0` still reaches services on
 *   the machine. See "The second lookup, and how to close it" above for what the
 *   list covers, what it costs and what is left.
 * - **No allow-list or deny-list of hosts.** The policy is "publicly routable",
 *   not "these domains". A caller with a stricter rule injects a resolver.
 * - **No HTML parsing, scraping or content extraction.**
 * - **No HTTP client features** — no cookies, proxy, TLS pinning, auth or
 *   multipart. `safeFetch` returns a `Response`; the caller does the rest.
 * - **No egress controls for non-HTTP protocols.** `ftp:` and friends are
 *   rejected at parse time, not audited.
 *
 * @module
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

export { resolveDns, resolveTxt } from "./dns.ts"
export type { AddressRecordType, DnsLookupOptions } from "./dns.ts"

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
  parseBoundedFormData,
  PayloadTooLargeError,
  readBoundedBody,
  readBoundedJson,
  readBoundedText,
  readContentLength,
} from "./bounded-body.ts"
export type { BodyReadOptions, BodySource } from "./bounded-body.ts"

export {
  CLOUDFLARE_IP_RANGES,
  ipHint,
  ipInRanges,
  isLoopbackHost,
  normalizeIp,
  parseIp,
} from "./ip.ts"
export type { ParsedIp } from "./ip.ts"

export { safeRedirectPath } from "./redirect-path.ts"
export type { SafeRedirectPathOptions } from "./redirect-path.ts"

export { deviceName, UNKNOWN_DEVICE } from "./user-agent.ts"
