# `@spy4x/net`

Outbound-request primitives for Deno: a URL shape normaliser, an SSRF guard, a
redirect-safe `fetch`, and bounded body readers. Plus an IP address parser and a
CIDR range check, for deciding which proxy to believe about a client's address,
and a check for a "go here next" path, so a link cannot redirect off the site.

Zero runtime dependencies. Platform APIs only — `URL`, `Deno.resolveDns` (`node:dns/promises` on Node and Bun),
`AbortController`, `ReadableStream`, `TextDecoder`. Nothing here imports `@std/*`
or any npm package, and nothing here ever will without a stated reason.

## Install

```bash
deno add jsr:@spy4x/net
```

Runs on: server (Deno), with `./redirect-path`, `./url-shape` and `./user-agent` also in a browser
bundle.

## Modules

Each module's usage is in its module doc, shown by `deno doc` and on JSR.

- [`@spy4x/net`](+main.ts): Outbound-request primitives.
- [`@spy4x/net/url-shape`](url-shape.ts): Shape-only URL normalisation for user-entered URLs.
- [`@spy4x/net/url-policy`](url-policy.ts): URL policy — validates that a URL is publicly routable.
- [`@spy4x/net/dns`](dns.ts): `resolveDns` and `resolveTxt`.
- [`@spy4x/net/safe-fetch`](safe-fetch.ts): Safe HTTP fetch.
- [`@spy4x/net/bounded-body`](bounded-body.ts): Bounded body reading — a hard byte cap plus a stalled-body timeout.
- [`@spy4x/net/ip`](ip.ts): IP address parsing and CIDR range checks.
- [`@spy4x/net/redirect-path`](redirect-path.ts): The one check for a "go here next" value that anyone can set, such as `?next=` on a sign-in page.
- [`@spy4x/net/user-agent`](user-agent.ts): A display label for the device behind a `User-Agent` header.

```
```
