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

`defaultResolver` is the production implementation: it asks `Deno.resolveDns`
for A and AAAA in parallel and returns both sets, so **every family that answers
is checked**. It distinguishes the two ways a lookup can come back empty:

- **NODATA** (`Deno.resolveDns` throws `Deno.errors.NotFound`) means the name
  exists but has no record of that type. That is a legitimate empty family and
  it is tolerated — most of the public web is A-only, and refusing those hosts
  would make the guard useless as a default.
- **Any other error** (SERVFAIL, timeout, refused, malformed reply) propagates
  and the guard raises `dns_failure`. An _unanswerable_ family is unverifiable,
  and unverifiable must never be read as safe.

A host that answers neither family propagates as NODATA and is refused: "no
records at all" is not a routable destination. An empty family is not a bypass —
the family that does answer is still checked for routability.

## Permissions

`validatePublicUrl()` and `safeFetch()` need `--allow-net` **only to run DNS
resolution**. Nothing here makes a network request of its own; `safeFetch` does,
through the platform `fetch`, and that needs `--allow-net` regardless.

```bash
deno run --allow-net server.ts                       # default resolver
deno test --no-prompt --allow-read --allow-env       # this package's tests: hermetic
```

`normalizeUrlShape()` and `bounded-body.ts` need no permissions at all.

## The second lookup, and how to close it

The guard resolves the hostname, decides the address is public, and then hands
the **name** to `fetch` — which resolves it again. Whoever runs the DNS server
for that name chooses both answers. Answer with a public address the first time
and `127.0.0.1` the second, and the request goes somewhere the guard never
looked. This is DNS rebinding, it is a standard attack rather than a theoretical
one, and no amount of care inside this module closes it: the platform `fetch`
accepts a name, not the address that was checked.

What does close it is the runtime. Deno applies `--deny-net` at connection time,
against the address the connection is actually going to, so a second answer
pointing inside the network is refused by the process rather than by the guard.
The list is exported so it does not have to be retyped:

```ts
import { DENY_NET_ADDRESSES, denyNetFlag } from "@ts-libs/net/url-policy"

console.log(denyNetFlag())
// --deny-net=10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,…,[::1]
```

Print it once and paste the result into the task, the Dockerfile or the unit
file that starts the process — permissions are fixed when a process starts, so
nothing the process itself calls can apply them:

```bash
deno run --allow-net --deny-net=10.0.0.0/8,127.0.0.0/8,169.254.0.0/16,… server.ts
```

Verified on Deno 2.9.7, with a server listening on `127.0.0.1` in another
process: without the flag the fetch returns the internal service's body, with it
the fetch fails with `Requires net access to "127.0.0.1:<port>"`.

Three things about this layer are worth knowing before you rely on it:

- **It covers IPv4 ranges and one IPv6 address.** `--deny-net` takes a CIDR range
  for IPv4, but not for IPv6: `--deny-net=fc00::/7` stops the process from
  starting (`ipv6 addresses must be enclosed in square brackets`), and
  `[fc00::]/7` is not a host it accepts either. Only single addresses such as
  `[::1]` can be written, so unique-local and link-local IPv6 have the guard
  itself as their only layer.
- **A denied range cannot be listened on either.** `0.0.0.0/8` is therefore not
  in the list — denying it stops `Deno.serve` binding its default wildcard
  address, and an application that cannot start tends to lose the whole flag. An
  application that listens on `127.0.0.1` behind a proxy has to drop
  `127.0.0.0/8` as well, and gives up loopback cover in exchange.
- **It is a second layer, not the first.** `validatePublicUrl` still has to run:
  the deny list says nothing about `javascript:` locations, credentials in a URL,
  or a name that resolves internally on the first lookup.

## `safeFetch` — the redirect problem

The platform default follows redirects _inside_ `fetch`, where a guard cannot
see them: validating only the URL you pass in means a public host can bounce you
to `http://169.254.169.254/` and the runtime will happily fetch it.

`safeFetch` therefore requests `redirect: "manual"` and re-validates every
`Location` through `validatePublicUrl` before issuing the next request. Relative
and protocol-relative locations are resolved against the current URL first, so a
`Location: /admin` cannot smuggle you elsewhere. One `AbortController` and one
timer cover the whole chain, the redirect count is capped
(`DEFAULT_MAX_REDIRECTS = 3` hops, i.e. **up to 4 requests** — the original plus
one per followed `Location`), each redirect body is cancelled before anything
that can throw, and a 301/302/303 downgrades a non-`GET`/`HEAD` request to `GET`
per RFC 9110.

Taking redirects away from the platform `fetch` also takes away its header
rules, so they are applied here: `Authorization`, `Cookie` and
`Proxy-Authorization` (`CREDENTIAL_HEADERS`) are dropped as soon as a hop lands
on a different origin, and stay dropped for the rest of the chain — a bounce
back to the first site does not get them back, and neither does a further hop
inside the second one. Scheme, host and port all count as a change of origin. A
redirect refused by the policy, and a `Location` the URL parser cannot read,
both raise `UrlValidationError` with code `invalid_redirect` or `non_public_ip`
— never a bare `TypeError` — after the redirect body has been cancelled.

Two things about that rule are worth knowing before you rely on it:

- **`headers` is parsed by the platform `Headers` before anything reads it**, so
  a `Headers`, an array of name/value pairs and a plain object all behave the
  same way. That is a security decision rather than a convenience: an array of
  pairs read as a plain record gives back the _indices_ as header names, so a
  credential crossed to the other origin under the name `0` with the secret
  still in the value, and a `Headers` object read the same way lost every header
  instead. Anything the platform refuses — a malformed pair, an invalid name, a
  value with a newline in it — is refused here as `UrlValidationError` with code
  `invalid_format`, before any request is made.
- **Only the three standard names are dropped**, exactly as the platform does
  it. A house header that carries a secret — `X-Api-Key`, `X-Auth-Token` — does
  follow a redirect to another origin. Add it to the request only where it is
  needed, or do not send it through `safeFetch`.

`Fetcher` is the injection seam for the transport; `url` in the result is
always the canonical URL that actually answered.

## Body reading

`readBoundedText`, `readBoundedJson` and `readBoundedBody` take a `Request` or a
`Response` and enforce two independent limits:

- **a hard byte cap** (`maxBytes`, default 5 MiB), checked against both the
  declared `Content-Length` and the running total, so a missing or lying header
  cannot get past it;
- **a stall budget** (`timeoutMs`, default 10s), the maximum wait for the _next_
  chunk — so a slow-but-live transfer is allowed to finish while a hung one
  fails fast with `BodyReadTimeoutError`. `timeoutMs: 0` turns it off, which is
  a thing to ask for deliberately rather than by saying nothing.

Failures are typed: `PayloadTooLargeError`, `BodyReadTimeoutError`, and the
platform `SyntaxError` for malformed JSON. The reader is cancelled and unlocked
on every exit path.

## Explicitly out of scope

- **No caching, retries or circuit breaking.** Wrap `safeFetch` or use a client
  built on it.
- **No response-body policy.** Size and time only; content type, charset and
  malware scanning belong to the caller.
- **No DNS pinning.** The guard resolves a host and then `fetch` resolves it
  again. Pinning the connection to the address that was checked needs a custom
  dispatcher, which the platform `fetch` does not expose. The gap is real and it
  is closed from outside the module — see "The second lookup, and how to close
  it" above.
- **No allow-list or deny-list of hosts.** The policy is "publicly routable",
  not "these domains". A caller with a stricter rule injects a resolver.
- **No HTML parsing, scraping or content extraction.**
- **No HTTP client features** — no cookies, proxy, TLS pinning, auth or
  multipart. `safeFetch` returns a `Response`; the caller does the rest.
- **No egress controls for non-HTTP protocols.** `ftp:` and friends are
  rejected at parse time, not audited.
