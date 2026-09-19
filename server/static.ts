/**
 * Static-file serving for a single root directory.
 *
 * Two things make this safe enough to expose:
 *
 * 1. **Path traversal is refused before any filesystem call.** A request path is
 *    percent-decoded **once**, split on `/`, and every segment is checked, so
 *    `..`, a backslash, an absolute path, a NUL byte and any segment that is not
 *    a plain name are rejected. Double-encoding resolves to the control-character
 *    check or to a name that does not exist, never to an escaped path.
 * 2. **Symlink escape is refused at read time.** The adapter compares the
 *    realpath of the resolved file against the realpath of the root, so a symlink
 *    inside the root that points outside it is not served. Only the realpath can
 *    tell — the path string is already inside the root.
 *
 * The `offer-lens` source this was ported from did `Deno.readFile(SPA_DIR +
 * c.req.path)`, which is a path-traversal hole; that part is ported as a fix, not
 * as-is. Its second half — an explicit `app.get("/analyze", spaHandler)` route
 * list — is **not** ported: an SPA fallback is a single flag (`spaFallback`) or
 * the caller's own catch-all route, not a list of page paths.
 *
 * The native `Response` streams a `ReadableStream` body, so a large asset is not
 * buffered twice; `Deno.readFile` returns the bytes and Deno's `Response`
 * implementation streams them.
 */

/** Result of resolving a request path against the static root. */
export type StaticPathResolution =
  | { ok: true; filePath: string; relativePath: string }
  | { ok: false; reason: StaticRejection }

/** Why a request path was refused. */
export type StaticRejection =
  | "empty_path"
  | "not_a_file_path"
  | "encoded_separator"
  | "parent_segment"
  | "absolute_path"
  | "backslash"
  | "control_character"

/** Extension to content type. `enum` is not usable: the keys are file extensions. */
const MIME_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/vnd.microsoft.icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  webmanifest: "application/manifest+json",
}

/** Every extension the MIME table knows, for docs and for tests. */
export const KNOWN_EXTENSIONS: readonly string[] = Object.keys(MIME_TYPES)

/**
 * Content type for a path, from its extension, case-insensitively.
 *
 * Unknown extensions get `application/octet-stream`, never a guess: serving an
 * unknown file as `text/html` would turn any upload directory into stored XSS.
 */
export function contentTypeFor(path: string): string {
  const lastDot = path.lastIndexOf(".")
  const lastSlash = path.lastIndexOf("/")
  if (lastDot <= lastSlash + 1) return "application/octet-stream"
  const extension = path.slice(lastDot + 1).toLowerCase()
  return MIME_TYPES[extension] ?? "application/octet-stream"
}

/** True when every path segment is a plain name. */
function isSafeSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === "..") return false
  if (segment.includes("\\")) return false
  // Control characters, including NUL, never appear in a real filename and are
  // how a truncated path string is smuggled past a later check.
  // deno-lint-ignore no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(segment)
}

/**
 * Join a request pathname to a static root, refusing anything that could escape it.
 *
 * The pathname is decoded once. A `%2F` or `%5C` that decodes into a separator is
 * refused outright rather than re-split: accepting it would make the decode order
 * part of the security boundary.
 *
 * @param requestPath `URL.pathname` of the request, still percent-encoded.
 * @param root Absolute or workspace-relative static root directory, without a
 * trailing slash.
 * @returns `{ ok: true, filePath, relativePath }` or `{ ok: false, reason }`.
 */
export function resolveStaticPath(requestPath: string, root: string): StaticPathResolution {
  if (requestPath.includes("%2f") || requestPath.includes("%2F")) {
    return { ok: false, reason: "encoded_separator" }
  }
  if (requestPath.includes("%5c") || requestPath.includes("%5C")) {
    return { ok: false, reason: "encoded_separator" }
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    // A lone `%` or a bad escape sequence is not a path.
    return { ok: false, reason: "not_a_file_path" }
  }

  if (decoded.includes("\\")) return { ok: false, reason: "backslash" }
  // deno-lint-ignore no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(decoded)) {
    return { ok: false, reason: "control_character" }
  }

  const withoutLeadingSlash = decoded.startsWith("/") ? decoded.slice(1) : decoded
  if (withoutLeadingSlash.startsWith("/")) return { ok: false, reason: "absolute_path" }
  if (withoutLeadingSlash === "" || withoutLeadingSlash.endsWith("/")) {
    return { ok: false, reason: "empty_path" }
  }

  const segments = withoutLeadingSlash.split("/")
  for (const segment of segments) {
    if (segment === "..") return { ok: false, reason: "parent_segment" }
    if (!isSafeSegment(segment)) return { ok: false, reason: "not_a_file_path" }
  }

  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root
  return {
    ok: true,
    filePath: `${normalizedRoot}/${segments.join("/")}`,
    relativePath: segments.join("/"),
  }
}

/**
 * True when `candidate` is inside `root`.
 *
 * Used by the adapter on **resolved** paths (realpath), because that is the only
 * form in which a symlink cannot lie.
 */
export function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`)
}

/** Statistics the adapter needs from a filesystem entry. */
export interface StaticFileInfo {
  isFile: boolean
}

/** Filesystem surface the static handler needs; injected so tests need no files. */
export interface StaticFs {
  /** File bytes. Throws when the path does not exist or is a directory. */
  readFile: (path: string) => Promise<Uint8Array<ArrayBuffer>>
  /** Entry metadata, or `null` when it does not exist. */
  stat: (path: string) => Promise<StaticFileInfo | null>
  /** Canonical absolute path, resolving symlinks. */
  realPath: (path: string) => Promise<string>
}

/** Options for {@link serveStatic}. */
export interface ServeStaticOptions {
  /** Static root directory, e.g. `./static`. */
  root: string
  /** Filesystem to read through. Defaults to {@link denoStaticFs}. */
  fs?: StaticFs
  /**
   * Serve `<root>/index.html` for a path that does not exist. This is the whole
   * SPA story: one flag, not a list of route paths.
   */
  spaFallback?: boolean
  /** `Cache-Control` value to set on served files. Omitted means no header. */
  cacheControl?: string
}

/** File name served for a directory request and for the SPA fallback. */
const INDEX_FILE = "index.html"

/**
 * Serve one request path from the static root.
 *
 * @param requestPath `URL.pathname` of the request, still percent-encoded.
 * @param options Root directory plus optional filesystem, SPA flag and cache header.
 * @returns A `200` response with the file's bytes and content type, or
 * `undefined` when the path is refused or the file does not exist. Callers turn
 * `undefined` into their own `404` (or into an SPA route).
 */
export async function serveStatic(
  requestPath: string,
  options: ServeStaticOptions,
): Promise<Response | undefined> {
  const fs = options.fs ?? denoStaticFs

  let resolved = resolveStaticPath(requestPath, options.root)
  if (!resolved.ok && resolved.reason === "empty_path" && options.spaFallback) {
    resolved = resolveStaticPath(`/${INDEX_FILE}`, options.root)
  }
  if (!resolved.ok) return undefined

  let filePath = resolved.filePath
  if (options.spaFallback) {
    const exists = await fs.stat(filePath).catch(() => null)
    if (!exists?.isFile) {
      const fallback = resolveStaticPath(`/${INDEX_FILE}`, options.root)
      if (!fallback.ok) return undefined
      filePath = fallback.filePath
    }
  }

  // Symlink check on the resolved path: the string is inside the root, the
  // target may not be.
  const [realFile, realRoot] = await Promise.all([
    fs.realPath(filePath).catch(() => null),
    fs.realPath(options.root).catch(() => null),
  ])
  if (!realFile || !realRoot || !isPathInsideRoot(realFile, realRoot)) return undefined

  const bytes = await fs.readFile(realFile).catch(() => null)
  if (!bytes) return undefined

  const headers = new Headers({
    "Content-Type": contentTypeFor(realFile),
    // A static asset is served with the content type this table chose; a browser
    // must not sniff a different one, which is how a `.txt` upload becomes script.
    "X-Content-Type-Options": "nosniff",
  })
  if (options.cacheControl) headers.set("Cache-Control", options.cacheControl)

  return new Response(bytes, { headers })
}

/** Filesystem implementation backed by `Deno.*`, used when none is injected. */
export const denoStaticFs: StaticFs = {
  readFile: (path) => Deno.readFile(path) as Promise<Uint8Array<ArrayBuffer>>,
  async stat(path) {
    try {
      const info = await Deno.stat(path)
      return { isFile: info.isFile }
    } catch {
      return null
    }
  },
  realPath: (path) => Deno.realPath(path),
}
