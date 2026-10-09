/**
 * Security headers for a same-origin single-page app: a Content-Security-Policy that allows only
 * the app's own origin, framing denied, no referrer, no content sniffing. A thin preset over
 * Hono's `secureHeaders`, which does the header work; this adds the policy and the hashes of the
 * inline blocks in the built page, so the policy needs no `unsafe-inline`.
 *
 * @module
 */

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

/** CSP directives a consumer may widen. Each list is appended to the directive's defaults. */
export type ExtraSources = Partial<
  Record<
    | "scriptSrc"
    | "styleSrc"
    | "imgSrc"
    | "connectSrc"
    | "fontSrc"
    | "mediaSrc"
    | "workerSrc"
    | "manifestSrc",
    readonly string[]
  >
>

/** Options of {@link securityHeaders}. */
export interface SecurityHeadersOptions {
  /**
   * The built `index.html`. The hash of every inline `<script>` and `<style>` block in it is
   * allowed. Omit for a page without inline blocks.
   */
  shellHtml?: string
  /**
   * Sources to allow beyond `'self'`, such as `https://cdn.example.com` in `imgSrc`. A service
   * worker served from the app's own origin needs none: `workerSrc` falls back to `script-src`.
   */
  extraSources?: ExtraSources
}

/**
 * Middleware that sets the headers on every response. Defaults: `default-src 'self'`; scripts and
 * styles from `'self'` plus the hashes of the inline blocks in `shellHtml`; images from `'self'` and
 * `data:`; connections from `'self'`; no objects; `base-uri`, `form-action` `'self'`;
 * `frame-ancestors 'none'`; `X-Frame-Options: DENY`; `Referrer-Policy: no-referrer`;
 * `X-Content-Type-Options: nosniff`.
 */
export async function securityHeaders(
  options: SecurityHeadersOptions = {},
): Promise<MiddlewareHandler> {
  const extra = options.extraSources ?? {}
  const html = options.shellHtml ?? ``
  const more = (key: keyof ExtraSources) => [...extra[key] ?? []]
  const optional = (key: keyof ExtraSources) =>
    extra[key] ? { [key]: [`'self'`, ...more(key)] } : {}
  return secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: [`'self'`],
      scriptSrc: [`'self'`, ...await inlineBlockHashes(html, `script`), ...more(`scriptSrc`)],
      styleSrc: [`'self'`, ...await inlineBlockHashes(html, `style`), ...more(`styleSrc`)],
      imgSrc: [`'self'`, `data:`, ...more(`imgSrc`)],
      connectSrc: [`'self'`, ...more(`connectSrc`)],
      objectSrc: [`'none'`],
      baseUri: [`'self'`],
      formAction: [`'self'`],
      frameAncestors: [`'none'`],
      ...optional(`fontSrc`),
      ...optional(`mediaSrc`),
      ...optional(`workerSrc`),
      ...optional(`manifestSrc`),
    },
    xFrameOptions: `DENY`,
    referrerPolicy: `no-referrer`,
    xContentTypeOptions: `nosniff`,
  })
}
