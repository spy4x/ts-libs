/**
 * A small error reporter that posts Sentry's envelope format, which GlitchTip and Sentry accept.
 * It runs in a browser, a worker and on a server, and imports nothing.
 *
 * What it never sends: cookies, request or response headers and bodies, form values, query strings
 * or fragments. It reads no `document`, `localStorage` or `navigator`. A message and a stack trace
 * are free text, so secrets named in them (`token=…`, `Bearer …`, a URL's query) are masked first.
 *
 * It fails open: a tracker that is down, slow or unreachable never throws into the app. Without a
 * DSN it is off and makes no request.
 */

/** Where a report goes: the envelope URL and the public key a DSN carries. */
export interface ParsedDsn {
  /** `https://host/api/<project>/envelope/`, with any path prefix of the DSN kept. */
  endpoint: string
  /** The DSN's public key. It only identifies the project; it cannot read anything back. */
  publicKey: string
}

/** What the reporter needs; only `dsn` is required, and an empty one turns the reporter off. */
export interface ErrorReporterOptions {
  /** `https://<publicKey>@<host>/<project>`. Missing, empty or invalid means off. */
  dsn: string | undefined
  /** The deployment, such as `prod`. */
  environment?: string
  /** The build, such as a commit sha. */
  release?: string
  /** Share of errors sent, from 0 to 1. Defaults to 1. */
  sampleRate?: number
  /**
   * Most reports sent in one session (one page load, or one process), or in one `windowMs` when
   * that is set. Defaults to 20.
   */
  maxPerSession?: number
  /**
   * Makes the cap a rate: the count starts again every `windowMs` milliseconds, so a process that
   * runs for weeks keeps reporting. Unset, the cap lasts the whole session.
   */
  windowMs?: number
  /** The page's address, read when a report is made. Its query and fragment are dropped. */
  pageUrl?: () => string | undefined
  /** Path segments that follow one of these names are secrets (`invite` masks `/invite/<token>`). */
  redactPathAfter?: string[]
  /** Replaces the global `fetch`; tests use it. */
  fetch?: typeof fetch
  /** Replaces `Math.random`; tests use it. */
  random?: () => number
  /** Replaces the clock, in milliseconds; tests use it. */
  now?: () => number
}

/** Extra facts one report may carry. Nothing else of the surroundings is ever read. */
export interface ReportContext {
  /** Short labels, such as the API's request id. Values are masked like any text. */
  tags?: Record<string, string>
  /** The request that failed on a server: its method and path, never its query or headers. */
  request?: { method: string; path: string }
}

/** The target of `install`: `window`, or anything with `addEventListener`. */
export interface ErrorEventTarget {
  // deno-lint-ignore no-explicit-any
  addEventListener(type: string, listener: (event: any) => void): void
}

/** What `createErrorReporter` returns. */
export interface ErrorReporter {
  /** `false` when there is no valid DSN: no call to this reporter makes a request. */
  readonly enabled: boolean
  /** Reports one thrown value. Resolves to whether a report was sent; never rejects. */
  report(error: unknown, context?: ReportContext): Promise<boolean>
  /** Reports every `error` and `unhandledrejection` event of `target`. Does nothing when off. */
  install(target: ErrorEventTarget): void
}

/** The DSN's endpoint and key, or `null` when `dsn` is not a valid `https://key@host/project`. */
export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn) return null
  try {
    const url = new URL(dsn)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    const parts = url.pathname.split("/").filter(Boolean)
    const project = parts.pop()
    if (!url.username || !project) return null
    const prefix = parts.length ? `/${parts.join("/")}` : ""
    return {
      endpoint: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`,
      publicKey: decodeURIComponent(url.username),
    }
  } catch {
    return null
  }
}

const MASK = "<REDACTED>"
/** Longest free text masked and sent: the masking patterns slow down sharply on long input. */
const MAX_TEXT = 4000
/** Longest function name kept in a stack frame. */
const MAX_FUNCTION = 200
/** Most stack frames kept, newest first. */
const MAX_FRAMES = 50
/** Longest stack line matched against the frame patterns. */
const MAX_FRAME_LINE = 1000
const SECRET_NAME = String
  .raw`(?:pass(?:word|wd)?|pwd|token|secret|api[_-]?key|auth(?:orization)?|cookie|session|otp)`

/** `url` as origin and path only, with credentials, query and fragment dropped. */
export function scrubUrl(url: string, redactPathAfter: string[] = []): string {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split("/")
    for (let i = 1; i < segments.length; i++) {
      if (redactPathAfter.includes(segments[i - 1]) && segments[i]) segments[i] = MASK
    }
    // `origin` is "null" for every scheme but http(s) and ws(s), such as `file:` or `postgres:`.
    const origin = parsed.origin !== "null"
      ? parsed.origin
      : `${parsed.protocol}${/^[^:]+:\/\//.test(url) ? `//${parsed.host}` : ""}`
    return `${origin}${segments.join("/")}`
  } catch {
    // Not a URL the platform can parse: a relative script path, or an address an error quotes
    // because it is malformed. Drop everything up to the last `@` after `://`, then the query.
    return url.replace(/^([a-z][a-z\d+.-]*:\/\/)\S*@/i, "$1").split(/[?#]/)[0]
  }
}

/**
 * Free text with the secrets it may carry masked: URLs lose their query, `Bearer` values, and the
 * value of anything named like a password, token, cookie or key.
 */
export function scrubText(text: string, redactPathAfter: string[] = []): string {
  return text.slice(0, MAX_TEXT)
    // A header line is secret to its end: `Cookie: a=1; b=2`, `Authorization: Basic …`.
    .replace(/\b(authorization|proxy-authorization|set-cookie|cookie)\s*:[^\n]*/gi, `$1: ${MASK}`)
    .replace(/\b[a-z][a-z\d+.-]{0,30}:\/\/[^\s"'<>)]+/gi, (url) => scrubUrl(url, redactPathAfter))
    // A relative path loses its query and fragment: `GET /reset?code=…`.
    .replace(/(^|[\s"'(=:[])(\/[^\s"'<>)?#]*)[?#][^\s"'<>)]*/g, "$1$2")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, MASK)
    .replace(/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(
      new RegExp(
        String
          .raw`(["']?\b[\w-]*${SECRET_NAME}[\w-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&"'}]+)`,
        "gi",
      ),
      `$1${MASK}`,
    )
}

/** One frame of Sentry's stack trace. */
interface Frame {
  filename?: string
  function?: string
  lineno?: number
  colno?: number
}

/** Frames of a V8 or Firefox/Safari stack, oldest call first as Sentry wants them. */
function parseFrames(stack: string, redactPathAfter: string[]): Frame[] {
  const frames: Frame[] = []
  for (const raw of stack.split("\n").slice(0, MAX_FRAMES + 1)) {
    // A real frame line is short; the first line carries the whole message, and the patterns
    // below slow down sharply on long input.
    const line = raw.trim().slice(0, MAX_FRAME_LINE)
    const v8 = /^at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?$/.exec(line)
    const gecko = /^(.*?)@(.*?):(\d+):(\d+)$/.exec(line)
    const match = v8 ?? gecko
    if (!match) continue
    const [, fn, file, lineno, colno] = match
    frames.push({
      filename: scrubUrl(file.replace(/^async /, ""), redactPathAfter),
      function: fn ? scrubText(fn.slice(0, MAX_FUNCTION), redactPathAfter) : undefined,
      lineno: Number(lineno),
      colno: Number(colno),
    })
  }
  return frames.reverse()
}

function hex32(): string {
  return crypto.randomUUID().replace(/-/g, "")
}

function asError(value: unknown): { type: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return { type: value.name || "Error", message: value.message, stack: value.stack }
  }
  if (typeof value === "string") return { type: "Error", message: value }
  try {
    return { type: "Error", message: `Non-error thrown: ${String(value)}` }
  } catch {
    return { type: "Error", message: "Non-error thrown" }
  }
}

/** Creates the reporter. Cheap and side-effect free until `report` or `install` is called. */
export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const dsn = parseDsn(options.dsn)
  const redact = options.redactPathAfter ?? []
  const sampleRate = options.sampleRate ?? 1
  const maxPerSession = options.maxPerSession ?? 20
  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  let sent = 0
  let windowStart = now()

  async function report(error: unknown, context: ReportContext = {}): Promise<boolean> {
    try {
      if (!dsn) return false
      if (options.windowMs !== undefined && now() - windowStart >= options.windowMs) {
        windowStart = now()
        sent = 0
      }
      if (sent >= maxPerSession) return false
      if (random() >= sampleRate) return false
      sent++
      const { type, message, stack } = asError(error)
      const pageUrl = options.pageUrl?.()
      const tags: Record<string, string> = {}
      for (const [name, value] of Object.entries(context.tags ?? {})) {
        tags[name] = scrubText(String(value), redact)
      }
      const event = {
        event_id: hex32(),
        timestamp: now() / 1000,
        platform: "javascript",
        level: "error",
        environment: options.environment,
        release: options.release,
        tags,
        exception: {
          values: [{
            type: scrubText(type, redact),
            value: scrubText(message, redact),
            stacktrace: stack ? { frames: parseFrames(stack, redact) } : undefined,
          }],
        },
        request: context.request
          ? {
            method: context.request.method,
            url: scrubUrl(`http://host${context.request.path}`, redact).replace("http://host", ""),
          }
          : pageUrl
          ? { url: scrubUrl(pageUrl, redact) }
          : undefined,
      }
      const envelope = [
        JSON.stringify({ event_id: event.event_id, sent_at: new Date(now()).toISOString() }),
        JSON.stringify({ type: "event" }),
        JSON.stringify(event),
      ].join("\n")
      const url = `${dsn.endpoint}?sentry_version=7&sentry_key=${encodeURIComponent(dsn.publicKey)}`
      const response = await (options.fetch ?? fetch)(url, {
        method: "POST",
        // Not application/json or a custom header: a plain text post needs no CORS preflight.
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: envelope,
        keepalive: true,
        credentials: "omit",
      })
      // The body is never read; letting go of it frees the connection on a long-running server.
      await response.body?.cancel()
      return response.ok
    } catch {
      return false
    }
  }

  return {
    enabled: dsn !== null,
    report,
    install(target) {
      if (!dsn) return
      target.addEventListener("error", (event: { error?: unknown; message?: string }) => {
        void report(event.error ?? event.message ?? "Unknown error")
      })
      target.addEventListener("unhandledrejection", (event: { reason?: unknown }) => {
        void report(event.reason)
      })
    },
  }
}
