/**
 * `@ts-libs/caldav` — dependency-free CalDAV/WebDAV primitives.
 *
 * Four layers, each usable on its own:
 *
 *  - `types.ts` — domain shapes, error codes, the `{ success, output, error }`
 *    envelope every fallible operation returns;
 *  - `ical.ts` — RFC 5545 builder and parser (folding, unfolding and TEXT
 *    escaping come from `@ts-libs/time/ics-core`, not from here);
 *  - `xml.ts` — request-body builders and namespace-prefix-agnostic response
 *    readers, no XML dependency on either side;
 *  - `client.ts` / `query.ts` — a `fetch`-injected client and the query engine
 *    that fans out over it with per-calendar error isolation.
 *
 * `caldav/README.md` records the interop rules this encodes and what is out of
 * scope.
 */

export * from "./types.ts"
export * from "./ical.ts"
export * from "./xml.ts"
export * from "./client.ts"
export * from "./query.ts"
