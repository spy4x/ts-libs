/**
 * Security headers for a same-origin single-page app: a Content-Security-Policy that allows only
 * the app's own origin, framing denied, no referrer, no content sniffing. A thin preset over
 * Hono's `secureHeaders`, which does the header work; this adds the policy and the hashes of the
 * inline blocks in the built page, so the policy needs no `unsafe-inline`.
 *
 * The same headers are available as data ({@link securityHeaderList}) for a server that is not
 * Hono, where {@link withSecurityHeaders} puts them on a `Response` and {@link withScriptNonce}
 * allows one render's nonce, and as nginx configuration
 * ({@link nginxAddHeaders}) for a page nginx serves.
 *
 * @module
 */

import { Hono } from "hono"
import { secureHeaders } from "hono/secure-headers"
import type { MiddlewareHandler } from "hono"

/** The base64 SHA-256 CSP source of each inline `<script>` or `<style>` block in `html`. */
export async function inlineBlockHashes(
  html: string,
  tag: "script" | "style",
): Promise<string[]> {
  const hashes: string[] = []
  for (const match of html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, `g`))) {
    const attributes = match[1] ?? ``
    const body = match[2]
    if (/\ssrc=/.test(attributes) || body === ``) continue
    const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(body))
    hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`)
  }
  return hashes
}

/**
 * CSP directives a consumer may widen. Each list is appended to the directive's defaults. Each
 * value is one source, such as `https://cdn.example.com` or `blob:`: {@link securityHeaderList}
 * throws on an empty value and on one that holds whitespace, `;`, `,` or a character outside
 * printable ASCII, because such a value would add a source or a whole directive to the policy.
 */
export type ExtraSources = Partial<
  Record<
    | "scriptSrc"
    | "styleSrc"
    | "imgSrc"
    | "connectSrc"
    | "fontSrc"
    | "mediaSrc"
    | "workerSrc"
    | "manifestSrc"
    | "formAction"
    | "styleSrcAttr",
    readonly string[]
  >
>

/** Options of {@link securityHeaders} and {@link securityHeaderList}. */
export interface SecurityHeadersOptions {
  /**
   * The built `index.html`. The hash of every inline `<script>` and `<style>` block in it is
   * allowed. Omit for a page without inline blocks.
   */
  shellHtml?: string
  /**
   * Sources to allow beyond `'self'`, such as `https://cdn.example.com` in `imgSrc`. A service
   * worker served from the app's own origin needs none: `workerSrc` falls back to `script-src`.
   * `formAction` also limits where a form's post may be redirected, so a page whose form ends on
   * another origin names that origin there. `styleSrcAttr` adds a `style-src-attr` directive, which
   * has no default and is written only when the list is not empty: `["'unsafe-inline'"]` allows
   * `style` attributes, such as colours a component sets from data, while `<style>` blocks and
   * stylesheets stay on `style-src`.
   */
  extraSources?: ExtraSources
}

/** One source: printable ASCII with no space, and neither separator of a policy. */
const ONE_SOURCE = /^[\x21-\x2b\x2d-\x3a\x3c-\x7e]+$/

/**
 * Throws when a value of `extra` is not one CSP source. The message names the key and the
 * position, never the value, which may come from the environment and may hold a credential.
 */
function assertSources(extra: ExtraSources): void {
  for (const [key, values] of Object.entries(extra)) {
    values?.forEach((value, index) => {
      if (typeof value !== "string" || !ONE_SOURCE.test(value)) {
        throw new Error(
          `extraSources.${key}[${index}] is not one CSP source: it is empty, or holds whitespace, ` +
            `";", "," or a character outside printable ASCII`,
        )
      }
    })
  }
}

/**
 * The headers {@link securityHeaders} sets, as `[name, value]` pairs with the names in lower case,
 * for a server the middleware cannot run in: pass the list to `new Headers(list)`, set each pair
 * on a response, or render it with {@link nginxAddHeaders}. The middleware sets exactly this list,
 * so the two cannot differ.
 *
 * Throws when a value in `extraSources` is not one CSP source (see {@link ExtraSources}).
 *
 * @example
 * ```ts
 * const headers = await securityHeaderList({ extraSources: { formAction: ["https://app.example.com"] } })
 * const response = new Response("ok")
 * for (const [name, value] of headers) response.headers.set(name, value)
 * ```
 */
export async function securityHeaderList(
  options: SecurityHeadersOptions = {},
): Promise<[name: string, value: string][]> {
  const extra = options.extraSources ?? {}
  assertSources(extra)
  const html = options.shellHtml ?? ``
  const more = (key: keyof ExtraSources) => [...extra[key] ?? []]
  const optional = (key: keyof ExtraSources) =>
    extra[key] ? { [key]: [`'self'`, ...more(key)] } : {}
  const middleware = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: [`'self'`],
      scriptSrc: [`'self'`, ...await inlineBlockHashes(html, `script`), ...more(`scriptSrc`)],
      styleSrc: [`'self'`, ...await inlineBlockHashes(html, `style`), ...more(`styleSrc`)],
      imgSrc: [`'self'`, `data:`, ...more(`imgSrc`)],
      connectSrc: [`'self'`, ...more(`connectSrc`)],
      objectSrc: [`'none'`],
      baseUri: [`'self'`],
      formAction: [`'self'`, ...more(`formAction`)],
      frameAncestors: [`'none'`],
      ...optional(`fontSrc`),
      ...optional(`mediaSrc`),
      ...optional(`workerSrc`),
      ...optional(`manifestSrc`),
      ...(extra.styleSrcAttr?.length ? { styleSrcAttr: more(`styleSrcAttr`) } : {}),
    },
    xFrameOptions: `DENY`,
    referrerPolicy: `no-referrer`,
    xContentTypeOptions: `nosniff`,
  })
  // Hono's `secureHeaders` does the header work and offers the result only on a response, so the
  // list is read once from an empty one.
  const app = new Hono().use(middleware).get(`/`, (c) => c.body(null))
  return [...(await app.request(`/`)).headers]
}

/** A CSP nonce: base64 or base64url characters with up to two `=`, which hex also matches. */
const NONCE = /^[A-Za-z0-9+/_-]+={0,2}$/

/**
 * A copy of `headers` whose Content-Security-Policy also allows scripts that carry `nonce`, for a
 * page rendered with a nonce made for that render (Fresh puts one on each inline script it writes).
 * `'nonce-<nonce>'` is appended to `script-src`; every other header and directive is kept.
 *
 * Only a nonce of base64 or hex characters is used. Any other value, a non-string included, returns
 * the list unchanged, because it could add a source or a directive to the policy.
 *
 * @example
 * ```ts
 * const headers = await securityHeaderList()
 * const page = withSecurityHeaders(response, withScriptNonce(headers, renderNonce))
 * ```
 */
export function withScriptNonce(
  headers: Iterable<readonly [name: string, value: string]>,
  nonce: unknown,
): [name: string, value: string][] {
  const list = [...headers].map(([name, value]): [string, string] => [name, value])
  if (typeof nonce !== `string` || !NONCE.test(nonce)) return list
  return list.map(([name, value]) => {
    if (name.toLowerCase() !== `content-security-policy`) return [name, value]
    const directives = value.split(`; `).map((directive) =>
      directive === `script-src` || directive.startsWith(`script-src `)
        ? `${directive} 'nonce-${nonce}'`
        : directive
    )
    return [name, directives.join(`; `)]
  })
}

/**
 * Middleware that sets the headers on every response. Defaults: `default-src 'self'`; scripts and
 * styles from `'self'` plus the hashes of the inline blocks in `shellHtml`; images from `'self'` and
 * `data:`; connections from `'self'`; no objects; `base-uri`, `form-action` `'self'`;
 * `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`;
 * `X-Content-Type-Options: nosniff`. It sets the list {@link securityHeaderList} returns for the
 * same options, and removes `X-Powered-By`.
 */
export async function securityHeaders(
  options: SecurityHeadersOptions = {},
): Promise<MiddlewareHandler> {
  const headers = await securityHeaderList(options)
  return async function securityHeaders(c, next) {
    await next()
    for (const [name, value] of headers) c.res.headers.set(name, value)
    c.res.headers.delete(`X-Powered-By`)
  }
}

/**
 * A copy of `response` that carries `headers`, for a server {@link securityHeaders} cannot run in
 * (Fresh, `Deno.serve`, a worker). It follows the middleware's rules: each header of the list
 * replaces the response's own header of that name, every other header is kept, and `X-Powered-By`
 * is removed.
 *
 * It returns a copy because a response may refuse a change to its headers: one from `fetch` or
 * `Response.redirect` throws when a header is set on it. The copy takes over the body, so use the
 * copy and drop the original. The status and status text are kept.
 *
 * A response that cannot be rebuilt is returned as it is, without the headers: a WebSocket
 * upgrade (status 101), and any other status outside 200 to 599. Copying an upgrade response would
 * break the upgrade, and it carries no page for the policy to protect.
 *
 * @throws TypeError when the body of `response` was already read.
 *
 * @example
 * ```ts
 * const headers = await securityHeaderList()
 * Deno.serve(async (request) => withSecurityHeaders(await handle(request), headers))
 * ```
 */
export function withSecurityHeaders(
  response: Response,
  headers: Iterable<readonly [name: string, value: string]>,
): Response {
  if (response.status < 200 || response.status > 599) return response
  const merged = new Headers(response.headers)
  for (const [name, value] of headers) merged.set(name, value)
  merged.delete(`X-Powered-By`)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  })
}

/** Options of {@link nginxAddHeaders}. */
export interface NginxAddHeadersOptions {
  /**
   * The nginx variables a value may name, each written as in the configuration, such as
   * `$csp_error_tracker`. Any other `$` in a value is refused. Default: none.
   */
  allowedVariables?: readonly string[]
}

/** A header name nginx reads as one word: letters, digits, `-` and `_`. */
const NGINX_HEADER_NAME = /^[A-Za-z0-9_-]+$/
/** An nginx variable as a value names it: `$` and the longest run of name characters. */
const NGINX_VARIABLE = /^\$[A-Za-z0-9_]+$/
/** What ends a quoted nginx string or its line: `"`, `\` and every control character. */
// deno-lint-ignore no-control-regex
const NGINX_UNSAFE = /["\\\x00-\x1f\x7f]/

/**
 * Renders headers as nginx configuration for an `include` file: one
 * `add_header <name> "<value>" always;` line each, every line ended by a newline, so nginx sends
 * them with error pages too. It returns the text and writes no file.
 *
 * A value is written inside a quoted string, where nginx expands `$name`. So this throws, naming
 * the header and never its value, when a value holds:
 *
 * - a double quote or a backslash, which could end the string;
 * - a newline, a carriage return or any other control character;
 * - a `$` that does not start one of `allowedVariables` exactly: another variable, a longer name
 *   that starts with an allowed one, `${name}` or a lone `$`.
 *
 * It also throws on a header name that is not letters, digits, `-` and `_`, and on an entry of
 * `allowedVariables` that is not `$` and a variable name.
 *
 * @example
 * ```ts
 * const headers = await securityHeaderList({ extraSources: { connectSrc: ["$csp_tracker"] } })
 * const conf = nginxAddHeaders(headers, { allowedVariables: ["$csp_tracker"] })
 * // add_header content-security-policy "default-src 'self'; … connect-src 'self' $csp_tracker; …" always;
 * ```
 */
export function nginxAddHeaders(
  headers: Iterable<readonly [name: string, value: string]>,
  options: NginxAddHeadersOptions = {},
): string {
  const allowed = new Set(options.allowedVariables ?? [])
  for (const variable of allowed) {
    if (!NGINX_VARIABLE.test(variable)) {
      throw new Error(`allowedVariables holds an entry that is not "$" and an nginx variable name`)
    }
  }
  let text = ``
  for (const [name, value] of headers) {
    if (!NGINX_HEADER_NAME.test(name)) {
      throw new Error(`A header name cannot be written into nginx configuration`)
    }
    if (NGINX_UNSAFE.test(value)) {
      throw new Error(
        `The value of ${name} cannot be written into nginx configuration: it holds a double ` +
          `quote, a backslash or a control character`,
      )
    }
    for (const [variable] of value.matchAll(/\$[A-Za-z0-9_]*/g)) {
      if (!allowed.has(variable)) {
        throw new Error(
          `The value of ${name} cannot be written into nginx configuration: it holds a "$" that ` +
            `starts no allowed variable`,
        )
      }
    }
    text += `add_header ${name} "${value}" always;\n`
  }
  return text
}
