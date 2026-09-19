// Shared test doubles. Not a `*.test.ts`, so it is imported rather than run.
//
// Everything here is deterministic: the transport is a stub driven from a fixed
// list of responses, and the clock is a fixed instant. No test in this package
// opens a socket, sleeps, or reads the host timezone.

import type { FetchLike } from "./client.ts"

/** The instant every fixture test uses as "now". */
export const FIXED_NOW = new Date("2026-07-01T12:00:00Z")

/** Credentials that are obviously fake, per the repo's fixture rule. */
export const FAKE_USERNAME = "user@example.com"
export const FAKE_PASSWORD = "test-password-not-real"

/** A CalDAV server that does not exist, on a documentation domain. */
export const FAKE_SERVER = "https://caldav.example.com"

/** One recorded request, so a test can assert on the wire format. */
export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** A scripted response: either a `Response` or a rejection. */
export type ScriptedResponse = Response | { throws: unknown }

/** A stub transport that records every call and replays the scripted answers. */
export interface StubTransport {
  /** The injected transport. */
  fetch: FetchLike
  /** Every request the client made, in order. */
  requests: RecordedRequest[]
  /** How many scripted responses are still unplayed. */
  remaining(): number
}

/**
 * Build a transport that answers with `responses` in order.
 *
 * A call past the end of the list fails loudly rather than resolving to an empty
 * response: a test that under-scripts its transport must break, not quietly
 * exercise a branch it did not mean to.
 */
export function stubTransport(responses: ScriptedResponse[]): StubTransport {
  const queue = [...responses]
  const requests: RecordedRequest[] = []
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === "string" ? input : input.toString()
    // Header names are lower-cased, matching what a real server sees and how
    // `Headers` itself iterates: an assertion on a mixed-case key would pass
    // nowhere except in these tests.
    const headers = new Headers(init?.headers)
    const lowered: Record<string, string> = {}
    for (const [name, value] of headers.entries()) lowered[name.toLowerCase()] = value
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: lowered,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    const next = queue.shift()
    if (next === undefined) {
      throw new Error(`stub transport exhausted: unexpected ${init?.method ?? "GET"} ${url}`)
    }
    if (isRejection(next)) return Promise.reject(next.throws)
    return Promise.resolve(next)
  }
  return { fetch, requests, remaining: () => queue.length }
}

/** True when a scripted entry is a rejection rather than a response. */
function isRejection(entry: ScriptedResponse): entry is { throws: unknown } {
  return !(entry instanceof Response)
}

/** Statuses whose responses must not carry a body (RFC 9110 §6.4.1). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/** A `Response` with a status and optional body and headers. */
export function response(
  status: number,
  body = "",
  options: { statusText?: string; headers?: Record<string, string> } = {},
): Response {
  return new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
    status,
    statusText: options.statusText ?? statusText(status),
    headers: options.headers,
  })
}

/** Standard reason phrase for the statuses these tests use. */
function statusText(status: number): string {
  const phrases: Record<number, string> = {
    200: "OK",
    201: "Created",
    204: "No Content",
    207: "Multi-Status",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    412: "Precondition Failed",
    500: "Internal Server Error",
    503: "Service Unavailable",
  }
  return phrases[status] ?? ""
}

/**
 * A minimal XML well-formedness checker for builder output.
 *
 * Deno ships no XML parser and this package has no XML dependency, so the only
 * way to check that a builder emitted *balanced* markup — short of asserting on
 * literals — is to scan the tags. This deliberately does not validate namespaces
 * or content models; it catches the failure mode that matters here, an unclosed
 * or mismatched element, and it is applied to builder output only, never used as
 * evidence that a builder's content is correct.
 */
export function assertWellFormedXml(xml: string): void {
  const stack: string[] = []
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|[^>"])*?)(\/?)>/g
  const stripped = xml.replace(/<\?[\s\S]*?\?>/g, "")
  let match: RegExpExecArray | null
  while ((match = tagPattern.exec(stripped)) !== null) {
    const [, closing, name, , selfClosing] = match as unknown as string[]
    if (closing === "/") {
      const open = stack.pop()
      if (open !== name) {
        throw new Error(`mismatched tag: </${name}> closes <${open ?? "nothing"}>`)
      }
      continue
    }
    if (selfClosing === "/") continue
    stack.push(name!)
  }
  if (stack.length > 0) {
    throw new Error(`unclosed element(s): ${stack.join(", ")}`)
  }
}

/** Octet length of a string as it appears on the wire. */
export function octets(value: string): number {
  return new TextEncoder().encode(value).length
}
