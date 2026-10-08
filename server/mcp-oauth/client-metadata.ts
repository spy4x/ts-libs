/**
 * Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document): the client's
 * `client_id` is an HTTPS URL, and the authorization server fetches the JSON document there to
 * learn the client's name and redirect URIs. No registration step, no client database.
 * @module
 */

import { type } from "arktype"
import { readBoundedJson } from "@spy4x/net/bounded-body"
import { type Fetcher, safeFetch } from "@spy4x/net/safe-fetch"
import type { DnsResolver } from "@spy4x/net/url-policy"
import { type Clock, systemClock } from "@spy4x/platform/universal/time"

/** What the server keeps from a client's metadata document. */
export interface ClientMetadata {
  /** The document's URL, equal to its own `client_id` field. */
  clientId: string
  /** The `client_name`, or the `client_id` host when the document has none. Self-asserted. */
  clientName: string
  /** The `redirect_uris` the client registered for itself. */
  redirectUris: readonly string[]
}

/** Resolves a `client_id` to its metadata. */
export interface ClientMetadataSource {
  /** The client's metadata, or `undefined` when the client must be refused. Never throws. */
  load(clientId: string): Promise<ClientMetadata | undefined>
}

/** Options for {@link createClientMetadataFetcher}. */
export interface ClientMetadataFetcherOptions {
  /**
   * Hosts a `client_id` may live on, such as `["claude.ai"]`. Default: any public host. The fetch
   * goes through the SSRF guard of `@spy4x/net/safe-fetch` either way, so a private or loopback
   * address is never fetched.
   */
  trustedHosts?: readonly string[]
  /** How long a fetched document is reused, in milliseconds. Defaults to 10 minutes. */
  cacheMs?: number
  /** Largest document accepted, in bytes. Defaults to 5 KiB, the draft's suggested ceiling. */
  maxBytes?: number
  /** Budget for the whole fetch, body included, in milliseconds. Defaults to 5 seconds. */
  timeoutMs?: number
  /** Clock for the cache. Defaults to the system clock. */
  clock?: Clock
  /** Network seam for tests. Defaults to the platform `fetch`. */
  fetcher?: Fetcher
  /** DNS seam for tests. Defaults to the system resolver. */
  resolver?: DnsResolver
}

const DEFAULT_CACHE_MS = 10 * 60_000
const DEFAULT_MAX_BYTES = 5 * 1024
const DEFAULT_TIMEOUT_MS = 5_000
/** Longest `client_name` shown, in characters. */
const MAX_CLIENT_NAME_LENGTH = 100
/** Control and format characters (bidi overrides, zero-width marks) a name could hide behind. */
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu

/** A self-asserted name made safe to show: no invisible characters, at most 100 characters. */
function displayName(name: string | undefined): string {
  const chars = Array.from(name?.replace(INVISIBLE, "").trim() ?? "")
  if (chars.length <= MAX_CLIENT_NAME_LENGTH) return chars.join("")
  return chars.slice(0, MAX_CLIENT_NAME_LENGTH - 1).join("").trimEnd() + "…"
}

/** `application/json` or any `+json` type, parameters ignored. */
function isJsonContentType(value: string | null): boolean {
  const type = value?.split(";")[0].trim().toLowerCase() ?? ""
  return type === "application/json" || /^application\/[a-z0-9.+-]+\+json$/.test(type)
}

const metadataDocument = type({
  client_id: "string",
  "client_name?": "string",
  redirect_uris: "string[] > 0",
  "token_endpoint_auth_method?": "string",
})

/**
 * Is this a well-formed `client_id` URL? It must be `https:`, have a path other than `/`, and
 * carry no fragment, user info or dot segments. It must already be in the form `URL` would
 * print, so two spellings of one URL cannot name two clients.
 */
export function isClientIdUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === "https:" && url.pathname !== "/" && url.hash === "" &&
    url.username === "" && url.password === "" && url.href === value
}

/**
 * Build a {@link ClientMetadataSource} that fetches each document over HTTPS through the SSRF
 * guard, follows no redirect, reads at most `maxBytes`, and accepts the document only when it is
 * valid JSON whose `client_id` equals its URL, lists at least one redirect URI, and declares no
 * token endpoint authentication other than `none` (this server has public clients only). A good
 * document is cached for `cacheMs`; a refusal is not cached.
 */
export function createClientMetadataFetcher(
  options: ClientMetadataFetcherOptions = {},
): ClientMetadataSource {
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS
  const clock = options.clock ?? systemClock
  const trusted = options.trustedHosts && new Set(options.trustedHosts.map((h) => h.toLowerCase()))
  const cache = new Map<string, { metadata: ClientMetadata; until: number }>()

  async function fetchDocument(clientId: string): Promise<ClientMetadata | undefined> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const { response } = await safeFetch(clientId, {
      fetcher: options.fetcher,
      resolver: options.resolver,
      maxRedirects: 0,
      timeoutMs,
      headers: { accept: "application/json" },
    })
    if (response.status !== 200 || !isJsonContentType(response.headers.get("content-type"))) {
      await response.body?.cancel()
      return undefined
    }
    const raw = await readBeforeDeadline(response, deadline - Date.now())
    const document = metadataDocument(raw)
    if (document instanceof type.errors) return undefined
    if (document.client_id !== clientId) return undefined
    const method = document.token_endpoint_auth_method
    if (method !== undefined && method !== "none") return undefined
    return {
      clientId,
      clientName: displayName(document.client_name) || new URL(clientId).host,
      redirectUris: document.redirect_uris,
    }
  }

  /**
   * Read the JSON body within what is left of the budget. `safeFetch`'s timer stops once the
   * headers arrive, and the body reader's own timer only bounds the wait for each chunk, so a body
   * that drips one byte at a time would otherwise outlast the budget. On expiry the response body
   * is cancelled and the read rejects.
   */
  async function readBeforeDeadline(response: Response, remainingMs: number): Promise<unknown> {
    if (remainingMs <= 0 || response.body === null) {
      await response.body?.cancel()
      throw new Error("client metadata fetch timed out")
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), remainingMs)
    try {
      const body = response.body.pipeThrough(new TransformStream(), { signal: controller.signal })
      return await readBoundedJson({ headers: response.headers, body }, {
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        timeoutMs: remainingMs,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async load(clientId) {
      if (!isClientIdUrl(clientId)) return undefined
      if (trusted && !trusted.has(new URL(clientId).hostname)) return undefined
      const now = clock.now()
      const hit = cache.get(clientId)
      if (hit && hit.until > now) return hit.metadata
      cache.delete(clientId)
      let metadata: ClientMetadata | undefined
      try {
        metadata = await fetchDocument(clientId)
      } catch {
        return undefined
      }
      if (metadata !== undefined && cacheMs > 0) {
        cache.set(clientId, { metadata, until: now + cacheMs })
      }
      return metadata
    },
  }
}
