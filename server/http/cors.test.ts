import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import type { MiddlewareHandler } from "hono/types"
import { cors } from "hono/cors"
import {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  createCorsOriginResolver,
  DEV_ORIGIN_HOSTS,
  resolveAllowedOrigin,
} from "./cors.ts"

/** Two production-style origins, so allowlisting is exercised beyond one entry. */
const ALLOWED = ["https://app.example.com", "https://admin.example.com"]

function resolve(origin: string | undefined | null): string | undefined {
  return resolveAllowedOrigin(origin, { allowedOrigins: ALLOWED })
}

/** The same allowlist in a development build that opts in to the loopback hosts. */
function resolveDev(origin: string | undefined | null): string | undefined {
  return resolveAllowedOrigin(origin, { allowedOrigins: ALLOWED, devHosts: DEV_ORIGIN_HOSTS })
}

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

Deno.test("cors: an allow-listed origin is returned verbatim", () => {
  assertEquals(resolve("https://app.example.com"), "https://app.example.com")
})

Deno.test("cors: a second allow-listed origin is returned verbatim", () => {
  assertEquals(resolve("https://admin.example.com"), "https://admin.example.com")
})

Deno.test("cors: an origin outside the allowlist is refused", () => {
  assertEquals(resolve("https://example.com"), undefined)
  assertEquals(resolve("https://evil.example.com"), undefined)
})

Deno.test("cors: allow-listed origin with a trailing path is refused", () => {
  assertEquals(resolve("https://app.example.com/path"), undefined)
})

Deno.test("cors: an allow-listed origin is not case-folded", () => {
  assertEquals(resolve("HTTPS://APP.EXAMPLE.COM"), undefined)
  assertEquals(resolve("https://App.example.com"), undefined)
})

Deno.test("cors: an allow-listed origin with an explicit default port is refused", () => {
  assertEquals(resolve("https://app.example.com:443"), undefined)
})

Deno.test("cors: an allow-listed origin with a trailing slash is refused", () => {
  assertEquals(resolve("https://app.example.com/"), undefined)
})

Deno.test("cors: localhost http dev origins are allowed on any valid port", () => {
  assertEquals(resolveDev("http://localhost:8000"), "http://localhost:8000")
  assertEquals(resolveDev("http://localhost:5173"), "http://localhost:5173")
  assertEquals(resolveDev("http://localhost:65535"), "http://localhost:65535")
})

Deno.test("cors: localhost with an elided port is allowed", () => {
  assertEquals(resolveDev("http://localhost"), "http://localhost")
})

Deno.test("cors: 127.0.0.1 http dev origins are allowed", () => {
  assertEquals(resolveDev("http://127.0.0.1:8000"), "http://127.0.0.1:8000")
  assertEquals(resolveDev("http://127.0.0.1"), "http://127.0.0.1")
})

Deno.test("cors: 0.0.0.0 and ipv6 loopback dev origins are allowed", () => {
  assertEquals(resolveDev("http://0.0.0.0:8000"), "http://0.0.0.0:8000")
  assertEquals(resolveDev("http://[::1]:8000"), "http://[::1]:8000")
})

Deno.test("cors: a dev origin with a non-numeric port is refused", () => {
  assertEquals(resolveDev("http://localhost:abc"), undefined)
  assertEquals(resolveDev("http://localhost:port"), undefined)
})

Deno.test("cors: a dev origin with port 0 is refused", () => {
  assertEquals(resolveDev("http://localhost:0"), undefined)
})

Deno.test("cors: a dev origin with a port above 65535 is refused", () => {
  assertEquals(resolveDev("http://localhost:65536"), undefined)
  assertEquals(resolveDev("http://localhost:99999"), undefined)
})

Deno.test("cors: a dev origin with a trailing slash is refused", () => {
  assertEquals(resolveDev("http://localhost:8000/"), undefined)
})

Deno.test("cors: a dev origin with userinfo is refused", () => {
  assertEquals(resolveDev("http://user:pass@localhost:8000"), undefined)
})

Deno.test("cors: a dev origin with a path is refused", () => {
  assertEquals(resolveDev("http://localhost:8000/api"), undefined)
})

Deno.test("cors: a dev origin with a query string is refused", () => {
  assertEquals(resolveDev("http://localhost:8000?foo=bar"), undefined)
})

Deno.test("cors: a dev origin with a fragment is refused", () => {
  assertEquals(resolveDev("http://localhost:8000#token"), undefined)
})

Deno.test("cors: https dev origins are refused", () => {
  assertEquals(resolveDev("https://localhost:8000"), undefined)
  assertEquals(resolveDev("https://127.0.0.1:8000"), undefined)
})

Deno.test("cors: a non-http scheme is refused", () => {
  assertEquals(resolve("ftp://localhost"), undefined)
  assertEquals(resolve("file:///etc/passwd"), undefined)
  assertEquals(resolve("javascript:alert(1)"), undefined)
})

Deno.test("cors: a malformed origin is refused", () => {
  assertEquals(resolve("not-a-url"), undefined)
  assertEquals(resolve("//example.com"), undefined)
  assertEquals(resolve("https://"), undefined)
})

Deno.test("cors: an unlisted chrome-extension origin is refused", () => {
  assertEquals(resolve(EXTENSION), undefined)
  assertEquals(resolveDev(EXTENSION), undefined)
})

Deno.test("cors: a listed chrome-extension origin is allowed verbatim, and no other", () => {
  const options = { allowedOrigins: [...ALLOWED, EXTENSION] }
  assertEquals(resolveAllowedOrigin(EXTENSION, options), EXTENSION)
  assertEquals(resolveAllowedOrigin(`${EXTENSION}/`, options), undefined)
  assertEquals(resolveAllowedOrigin(`chrome-extension://${"b".repeat(32)}`, options), undefined)
})

Deno.test("cors: loopback http origins are refused unless the caller passes dev hosts", () => {
  assertEquals(resolve("http://localhost:6666"), undefined)
  assertEquals(resolve("http://localhost"), undefined)
  assertEquals(resolve("http://127.0.0.1"), undefined)
  assertEquals(resolve("http://[::1]:8000"), undefined)
})

Deno.test("cors: an absent, empty or null origin is not a rejection", () => {
  assertEquals(resolve(undefined), undefined)
  assertEquals(resolve(null), undefined)
  assertEquals(resolve(""), undefined)
})

Deno.test("cors: a dev host is still refused when the dev list omits it", () => {
  const options = { allowedOrigins: ALLOWED, devHosts: ["localhost"] }
  assertEquals(resolveAllowedOrigin("http://localhost:5173", options), "http://localhost:5173")
  assertEquals(resolveAllowedOrigin("http://127.0.0.1:5173", options), undefined)
})

Deno.test("cors: a mixed-case dev host is refused, not normalised into the allowlist", () => {
  // `parsed.origin` lowercases the host, so the round-trip check refuses this
  // rather than echoing an origin the browser never sent.
  assertEquals(resolveDev("http://LOCALHOST:8000"), undefined)
  assertEquals(resolveDev("http://LocalHost"), undefined)
})

Deno.test("cors: the resolver accepts an allow-listed origin and refuses the rest", () => {
  const resolver = createCorsOriginResolver({ allowedOrigins: ALLOWED })
  assertEquals(resolver("https://app.example.com", {}), "https://app.example.com")
  assertEquals(resolver("http://localhost:5173", {}), "")
  assertEquals(resolver(EXTENSION, {}), "")
  assertEquals(resolver("https://evil.example.com", {}), "")
  assertEquals(resolver(undefined, {}), "")
})

Deno.test("cors: the resolver fills hono/cors's origin callback slot", () => {
  // Compile-time contract: `hono/cors` must accept the resolver unchanged, so a
  // Hono upgrade that changes the signature fails `deno check`, not the browser.
  const handler: MiddlewareHandler = cors({
    origin: createCorsOriginResolver({ allowedOrigins: ALLOWED }),
    allowMethods: [...CORS_ALLOW_METHODS],
    allowHeaders: [...CORS_ALLOW_HEADERS],
    maxAge: 86400,
  })
  assertStrictEquals(typeof handler, "function")
})

Deno.test("cors: an empty allowlist throws instead of accepting every origin", () => {
  assertThrows(
    () => createCorsOriginResolver({ allowedOrigins: [] }),
    TypeError,
    "requires at least one allowed origin",
  )
})

Deno.test("cors: the dev host list covers loopback and the wildcard bind address", () => {
  assertEquals(DEV_ORIGIN_HOSTS.includes("localhost"), true)
  assertEquals(DEV_ORIGIN_HOSTS.includes("127.0.0.1"), true)
  assertEquals(DEV_ORIGIN_HOSTS.includes("0.0.0.0"), true)
  assertEquals(DEV_ORIGIN_HOSTS.includes("[::1]"), true)
})

Deno.test("cors: the exported allow-lists cover the headers and methods in use", () => {
  assertEquals(CORS_ALLOW_METHODS.includes("POST"), true)
  assertEquals(CORS_ALLOW_METHODS.includes("OPTIONS"), true)
  assertEquals(CORS_ALLOW_HEADERS.includes("Authorization"), true)
  assertEquals(CORS_ALLOW_HEADERS.includes("Content-Type"), true)
})

Deno.test("cors: the allowed request headers name no product-specific header", () => {
  assertEquals(CORS_ALLOW_HEADERS, ["Content-Type", "Authorization"])
})
