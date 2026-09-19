# `@ts-libs/net`

Outbound-request primitives for Deno: a URL shape normaliser, an SSRF guard, a
redirect-safe `fetch`, and bounded body readers.

Zero runtime dependencies. Platform APIs only — `URL`, `Deno.resolveDns`,
`AbortController`, `ReadableStream`, `TextDecoder`. Nothing here imports `@std/*`
or any npm package, and nothing here ever will without a stated reason.

```
net/+main.ts          barrel: everything below
net/url-shape.ts      normalizeUrlShape()   — shape only
net/url-policy.ts     validatePublicUrl()   — the SSRF guard
net/safe-fetch.ts     safeFetch()           — guard + redirect re-validation
net/bounded-body.ts   readBoundedText/Json/Body, readContentLength
```

## Two-tier API: which one do you want?

| You have                        | You need                                     | Call                           |
| ------------------------------- | -------------------------------------------- | ------------------------------ |
| A URL a user typed into a form  | To reject typos and non-http schemes         | `normalizeUrlShape(input)`     |
| A URL you are about to request  | To know the destination is publicly routable | `validatePublicUrl(input)`     |
| A URL plus redirects            | To know every hop is publicly routable       | `safeFetch(input)`             |
| A response body of unknown size | To read it without OOM or hanging            | `readBoundedText(response, …)` |

`normalizeUrlShape()` is pure: no DNS, no I/O, no permissions. It trims, adds a
missing `https://`, lowercases the scheme and host, strips a default port, keeps
everything else, and refuses non-http(s) schemes and hostnames without a dot.
Use it for input fields — a user typing `example.com/foo` should see the
normalised value immediately, and a request is not being made.

`validatePublicUrl()` layers the security check on top: it parses, rejects
special-use hostnames and embedded credentials, then verifies the destination is
globally routable — IP literals against the classifier tables, DNS names by
resolving A **and** AAAA and refusing the URL if **any** answer is non-public or
the lookup fails. Use it before issuing any request on a user's behalf.

They are separate exports and neither calls the other, on purpose:

- shape refuses anything whose host has no dot, so `localhost`, `127.0.0.1` and
  `[::1]` arrive from shape as `invalid_hostname`. That is right for a form
  ("that is not a domain") and wrong for the guard, which must report
  `special_use` / `non_public_ip` so a caller can branch and log accurately.
- shape drops nothing but the default port; the guard must keep a non-default
  port and canonicalise the rest through the parser.
- only the guard needs `--allow-net`. A caller that never leaves shape pays
  nothing and grants nothing.

Both share one implementation of everything above the host rules — scheme
detection, the invalid-character pattern, the parse step and the error messages
— so the two can never disagree about what a URL _is_, only about which hosts
are allowed.

## The injectable resolver

```ts
import { type DnsResolver, validatePublicUrl } from "@ts-libs/net/url-policy"

export const staticResolver: DnsResolver = {
  resolve: (host) => Promise.resolve(host === "example.com" ? ["93.184.216.34"] : []),
}

const canonical = await validatePublicUrl("https://example.com/x", { resolver: staticResolver })
```

`DnsResolver` is a one-method interface, and it is the only side-effecting part
of the guard. Injecting it is what makes the test suite deterministic and
hermetic — **no test in this package touches the network** — and it is also the
seam for anything the system resolver cannot express:

- an allow-list (resolve from your own table, never call out);
- a latency bound (`Promise.race` the lookup against your own timeout);
- DNS-over-HTTPS, a cache, or a fixture in a request-handling test.

`defaultResolver` is the production implementation: it asks
`Deno.resolveDns` for A and AAAA in parallel and returns both sets. If **either
family fails to resolve**, the result is empty and the guard raises
`dns_failure` — a partially resolved host is never treated as safe, because an
unverifiable family is exactly the gap an SSRF guard must not leave open.

## Permissions

`validatePublicUrl()` and `safeFetch()` need `--allow-net` **only to run DNS
resolution**. Nothing here makes a network request of its own; `safeFetch` does,
through the platform `fetch`, and that needs `--allow-net` regardless.

```bash
deno run --allow-net server.ts                       # default resolver
deno test --no-prompt --allow-read --allow-env       # this package's tests: hermetic
```

`normalizeUrlShape()` and `bounded-body.ts` need no permissions at all.

## `safeFetch` — the redirect problem

The platform default follows redirects _inside_ `fetch`, where a guard cannot
see them: validating only the URL you pass in means a public host can bounce you
to `http://169.254.169.254/` and the runtime will happily fetch it.

`safeFetch` therefore requests `redirect: "manual"` and re-validates every
`Location` through `validatePublicUrl` before issuing the next request. Relative
and protocol-relative locations are resolved against the current URL first, so a
`Location: /admin` cannot smuggle you elsewhere. One `AbortController` and one
timer cover the whole chain, the redirect count is capped
(`DEFAULT_MAX_REDIRECTS = 3`), each redirect body is cancelled before the next
hop, and a 301/302/303 downgrades a non-`GET` request to `GET` per RFC 9110.

`Fetcher` is the injection seam for the transport; `url` in the result is
always the canonical URL that actually answered.

## Body reading

`readBoundedText`, `readBoundedJson` and `readBoundedBody` take a `Request` or a
`Response` and enforce two independent limits:

- **a hard byte cap** (`maxBytes`, default 5 MiB), checked against both the
  declared `Content-Length` and the running total, so a missing or lying header
  cannot get past it;
- **a stall budget** (`timeoutMs`, default 0 = off), the maximum wait for the
  _next_ chunk — so a slow-but-live transfer is allowed to finish while a hung
  one fails fast with `BodyReadTimeoutError`.

Failures are typed: `PayloadTooLargeError`, `BodyReadTimeoutError`, and the
platform `SyntaxError` for malformed JSON. The reader is cancelled and unlocked
on every exit path.

## Explicitly out of scope

- **No caching, retries or circuit breaking.** Wrap `safeFetch` or use a client
  built on it.
- **No response-body policy.** Size and time only; content type, charset and
  malware scanning belong to the caller.
- **No DNS pinning.** The guard resolves a host and then `fetch` resolves it
  again, so a TOCTOU rebind between the two is theoretically possible. Closing
  that needs a custom dispatcher pinned to a resolved IP, which is not something
  the platform `fetch` exposes today. Documented rather than pretended.
- **No allow-list or deny-list of hosts.** The policy is "publicly routable",
  not "these domains". A caller with a stricter rule injects a resolver.
- **No HTML parsing, scraping or content extraction.**
- **No HTTP client features** — no cookies, proxy, TLS pinning, auth or
  multipart. `safeFetch` returns a `Response`; the caller does the rest.
- **No egress controls for non-HTTP protocols.** `ftp:` and friends are
  rejected at parse time, not audited.
