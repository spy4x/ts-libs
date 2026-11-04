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
 * The source this was ported from did `Deno.readFile(SPA_DIR +
 * c.req.path)`, which is a path-traversal hole; that part is ported as a fix, not
 * as-is. Its second half — an explicit `app.get("/analyze", spaHandler)` route
 * list — is **not** ported: an SPA fallback is a single flag (`spaFallback`) or
 * the caller's own catch-all route, not a list of page paths.
 *
 * A file is opened, not read whole. `StaticFs.open` returns the file's size and a
 * `ReadableStream` of its bytes, so memory use stays flat for a request whatever
 * the file's size — a directory of large videos costs the same per-request memory
 * as a directory of icons. For a `GET`, the handle is released the first time one
 * of three things happens to the response body: it is read to the end, the client
 * cancels it, or a read fails. **A `GET` response whose body is never read and
 * never cancelled still holds the handle until garbage collection** — this is
 * exactly what a framework does to a `HEAD` response it discards unread, which is
 * why `HEAD` is handled separately: pass `method: "HEAD"` and the handle is closed
 * before `serveStatic` returns, without `serveStatic` ever wrapping or reading the
 * stream. (`denoStaticFs.open` still builds that stream eagerly as `file.readable`
 * — it exists, `serveStatic` just never touches it for `HEAD`.)
 *
 * @module
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

/** A file opened for streaming, returned by {@link StaticFs.open}. */
export interface StaticFileHandle {
  /** Total size in bytes, used for the `Content-Length` header. */
  size: number
  /** File contents, read lazily as the response body is consumed. */
  body: ReadableStream<Uint8Array>
  /**
   * When the file was last modified, or `null` when the platform cannot tell. {@link serveFile}
   * builds its `ETag` and `Last-Modified` from it. Optional: a `StaticFs` written before it was
   * added may leave it out, and {@link serveFile} then sends neither header.
   */
  mtime?: Date | null
  /**
   * Releases the file handle. `serveStatic` never calls this more than once for
   * a handle, so an implementation does not need to guard against a second
   * call. It is not guaranteed to be called at all: a `GET` response whose body
   * is never read and never cancelled leaves the handle to garbage collection,
   * as the module comment above describes.
   */
  close: () => void
}

/** Filesystem surface the static handler needs; injected so tests need no files. */
export interface StaticFs {
  /**
   * Opens a file for streaming. Resolves to `null` when the path does not exist
   * or is not a regular file, so a directory is never streamed as a file.
   */
  open: (path: string) => Promise<StaticFileHandle | null>
  /** Entry metadata, or `null` when it does not exist. */
  stat: (path: string) => Promise<StaticFileInfo | null>
  /** Canonical absolute path, resolving symlinks. */
  realPath: (path: string) => Promise<string>
  /**
   * Opens a file as {@link StaticFs.open} does, with a body that starts at byte `start`, so a
   * range request deep into a video reads nothing before it. Optional: without it,
   * {@link serveFile} opens the file and skips the bytes before `start`.
   */
  openAt?: (path: string, start: number) => Promise<StaticFileHandle | null>
}

/** Options for {@link serveStatic}. */
export interface ServeStaticOptions {
  /** Static root directory, e.g. `./static`. */
  root: string
  /** Filesystem to read through. Defaults to {@link runtimeStaticFs}. */
  fs?: StaticFs
  /**
   * Serve `<root>/index.html` for a path that does not exist, and for one that
   * {@link resolveStaticPath} refuses for an encoded separator, `%2F` or `%5C`
   * (`/tasks/a%2Fb`, an SPA route with a slash inside one segment). The fallback is always that one
   * fixed file, so a refused path never reaches the filesystem. A traversal
   * attempt (`..`, a backslash, a control character) is still not served, nor
   * is a malformed escape (`%zz`) or an empty segment (`/docs//`): those resolve
   * to `undefined`, the caller's `404`.
   * This is the whole SPA story: one flag, not a list of route paths.
   */
  spaFallback?: boolean
  /** `Cache-Control` value to set on served files. Omitted means no header. */
  cacheControl?: string
  /**
   * HTTP method of the request. Defaults to `"GET"`. Pass `"HEAD"` (for
   * example `c.req.method` from Hono) and the response carries the same
   * headers, including the correct `Content-Length`, with no body — and the
   * file handle is closed before `serveStatic` returns, instead of being
   * handed to a stream the caller is never going to read. Any other value is
   * treated the same as `"GET"`.
   */
  method?: string
}

/**
 * File name served for a request path that ends in `/` (`/docs/` serves
 * `docs/index.html`, `/` serves `index.html`) and for the SPA fallback.
 */
const INDEX_FILE = "index.html"

/**
 * Refusals the SPA fallback answers with the shell: an empty path, and an
 * encoded separator such as `%2F`, which an SPA route can carry in one of its own segments
 * (`/tasks/a%2Fb`). A traversal attempt still gets no response.
 */
const SPA_REASONS: ReadonlySet<StaticRejection> = new Set(["empty_path", "encoded_separator"])

/**
 * Serve one request path from the static root.
 *
 * A path that ends in `/` serves that directory's `index.html`. The file name is
 * appended before {@link resolveStaticPath} checks the path, so every traversal
 * guard still applies to the result.
 *
 * @param requestPath `URL.pathname` of the request, still percent-encoded.
 * @param options Root directory plus optional filesystem, SPA flag, cache header
 * and request method.
 * @returns A `200` response with the same content type and `Content-Length`
 * (taken from the file's own size, never from a buffer) whatever the method: a
 * streamed body for `GET`, no body at all for `HEAD` — with the handle already
 * closed in that case. Resolves to `undefined` when the path is refused or the
 * file does not exist. Callers turn `undefined` into their own `404` (or into
 * an SPA route).
 */
export async function serveStatic(
  requestPath: string,
  options: ServeStaticOptions,
): Promise<Response | undefined> {
  const fs = options.fs ?? runtimeStaticFs

  const path = requestPath.endsWith("/") ? `${requestPath}${INDEX_FILE}` : requestPath
  let resolved = resolveStaticPath(path, options.root)
  if (!resolved.ok && options.spaFallback && SPA_REASONS.has(resolved.reason)) {
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

  const handle = await fs.open(realFile).catch(() => null)
  if (!handle) return undefined

  const headers = new Headers({
    "Content-Type": contentTypeFor(realFile),
    "Content-Length": String(handle.size),
    // A static asset is served with the content type this table chose; a browser
    // must not sniff a different one, which is how a `.txt` upload becomes script.
    "X-Content-Type-Options": "nosniff",
  })
  if (options.cacheControl) headers.set("Cache-Control", options.cacheControl)

  // A HEAD response carries no body, so there is nothing to stream and nothing
  // a caller might forget to read or cancel. Close right here instead of
  // handing the handle to a stream a framework's HEAD handling is going to
  // discard unread — that discard is exactly how a `GET` handle leaks until
  // garbage collection, and `HEAD` has no reason to risk the same thing.
  if (options.method === "HEAD") {
    handle.close()
    return new Response(null, { headers })
  }

  try {
    return new Response(closingStream(handle), { headers })
  } catch (error) {
    handle.close()
    throw error
  }
}

/**
 * Wrap a file handle's body so `close` runs exactly once, the first time the
 * stream is fully read, is cancelled by the client, or fails on a read. A
 * `StaticFs` implementation is not required to manage this itself.
 *
 * This only covers a body a caller actually reads or cancels. A `GET`
 * response whose body nobody touches — the shape of a HEAD response most
 * frameworks build for themselves, discarding the one `serveStatic` returned
 * — never calls `pull` or `cancel`, so the handle is not released until
 * garbage collection notices the abandoned stream. `serveStatic` avoids that
 * case for `HEAD` entirely by never calling this function for one.
 */
function closingStream(handle: StaticFileHandle): ReadableStream<Uint8Array> {
  const reader = handle.body.getReader()
  let closed = false
  const closeOnce = () => {
    if (closed) return
    closed = true
    handle.close()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          closeOnce()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (error) {
        closeOnce()
        controller.error(error)
      }
    },
    cancel(reason) {
      closeOnce()
      return reader.cancel(reason)
    },
  })
}

/** Open `path` with Deno, its body starting at byte `start`; `null` when it is no regular file. */
async function openDeno(path: string, start: number): Promise<StaticFileHandle | null> {
  let file: Deno.FsFile
  try {
    file = await Deno.open(path, { read: true })
  } catch {
    return null
  }
  let info: Deno.FileInfo
  try {
    info = await file.stat()
    if (start > 0) await file.seek(start, Deno.SeekMode.Start)
  } catch {
    closeQuietly(file)
    return null
  }
  if (!info.isFile) {
    closeQuietly(file)
    return null
  }
  return {
    size: info.size,
    mtime: info.mtime,
    body: file.readable,
    close: () => closeQuietly(file),
  }
}

/** Filesystem implementation backed by `Deno.*`, the default on Deno. */
export const denoStaticFs: StaticFs = {
  open: (path) => openDeno(path, 0),
  openAt: openDeno,
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

/**
 * Closes a file, ignoring a resource that is already gone. `Deno.FsFile`'s
 * `readable` stream releases the underlying resource itself once fully read or
 * cancelled, so a later explicit close from {@link closingStream} routinely
 * finds nothing left to close.
 */
function closeQuietly(file: Deno.FsFile): void {
  try {
    file.close()
  } catch {
    // already closed by the stream finishing or being cancelled
  }
}

/** A `node:fs/promises` file handle, as far as {@link nodeStaticFs} uses it. */
interface NodeFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number; mtime: Date }>
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

/** `node:fs/promises`, as far as {@link nodeStaticFs} uses it. */
interface NodeFs {
  open(path: string, flags: "r"): Promise<NodeFileHandle>
  stat(path: string): Promise<{ isFile(): boolean }>
  realpath(path: string): Promise<string>
}

let nodeFsModule: Promise<NodeFs> | undefined

/**
 * Load `node:fs/promises` on the first call, with a specifier the type checker does not resolve,
 * as `@spy4x/platform/server/runtime-fs` does, so a Deno program never pulls in Node's types.
 */
const nodeFs = (): Promise<NodeFs> =>
  nodeFsModule ??= import(["node", "fs/promises"].join(":")) as Promise<NodeFs>

/** Bytes read from a Node file handle per pull of the response body. */
const NODE_CHUNK_BYTES = 64 * 1024

/**
 * Filesystem implementation over `node:fs/promises`, for Node and Bun (Bun implements Node's
 * `fs`). The body is read one 64 KiB chunk per pull, so memory stays flat whatever the file's
 * size, and the handle closes once the body is read to the end, cancelled or fails.
 */
export const nodeStaticFs: StaticFs = {
  open: (path) => openNode(path, 0),
  openAt: openNode,
  async stat(path) {
    const fs = await nodeFs()
    try {
      return { isFile: (await fs.stat(path)).isFile() }
    } catch {
      return null
    }
  },
  realPath: async (path) => await (await nodeFs()).realpath(path),
}

/** Open `path` with Node, its body starting at byte `start`; `null` when it is no regular file. */
async function openNode(path: string, start: number): Promise<StaticFileHandle | null> {
  const fs = await nodeFs()
  let file: NodeFileHandle
  try {
    file = await fs.open(path, "r")
  } catch {
    return null
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    file.close().catch(() => {})
  }
  let info: { isFile(): boolean; size: number; mtime: Date }
  try {
    info = await file.stat()
  } catch {
    close()
    return null
  }
  if (!info.isFile()) {
    close()
    return null
  }
  let position = start
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const buffer = new Uint8Array(NODE_CHUNK_BYTES)
        const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position)
        position += bytesRead
        if (bytesRead > 0) return controller.enqueue(buffer.subarray(0, bytesRead))
        close()
        controller.close()
      } catch (error) {
        close()
        controller.error(error)
      }
    },
    cancel: close,
  })
  return { size: info.size, mtime: info.mtime, body, close }
}

/** {@link denoStaticFs} on Deno, {@link nodeStaticFs} elsewhere, chosen on each call. */
const currentStaticFs = (): StaticFs => "Deno" in globalThis ? denoStaticFs : nodeStaticFs

/**
 * The files of the running runtime: {@link denoStaticFs} on Deno, {@link nodeStaticFs} on Node and
 * Bun. The default of {@link serveStatic}.
 */
export const runtimeStaticFs: StaticFs = {
  open: (path) => currentStaticFs().open(path),
  openAt: (path, start) => currentStaticFs().openAt!(path, start),
  stat: (path) => currentStaticFs().stat(path),
  realPath: (path) => currentStaticFs().realPath(path),
}

/** Options for {@link serveFile}. */
export interface ServeFileOptions {
  /** Filesystem to read through. Defaults to {@link runtimeStaticFs}. */
  fs?: StaticFs
  /** `Cache-Control` value to set on the response. Omitted means no header. */
  cacheControl?: string
}

/** A byte range of a file, both ends included. */
interface ByteRange {
  start: number
  end: number
}

/**
 * The one range a `Range` header asks for: a {@link ByteRange}, `"unsatisfiable"` for a range
 * that starts past the end (answered `416`), or `undefined` for a header to ignore — absent,
 * malformed, not in bytes, or asking for several ranges, which is answered with the whole file.
 */
function parseRange(header: string | null, size: number): ByteRange | "unsatisfiable" | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match) return undefined
  const [, first, last] = match
  if (first === "" && last === "") return undefined
  if (first === "") {
    const suffix = Number(last)
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(first)
  const end = last === "" ? Infinity : Number(last)
  if (end < start) return undefined
  if (start >= size) return "unsatisfiable"
  return { start, end: Math.min(end, size - 1) }
}

/** Whether `If-None-Match` lists `etag`, compared weakly as RFC 9110 says for this header. */
function noneMatchHits(header: string, etag: string): boolean {
  const bare = (tag: string) => tag.trim().replace(/^W\//, "")
  return header.split(",").some((tag) => tag.trim() === "*" || bare(tag) === bare(etag))
}

/**
 * Wrap `handle`'s body to skip its first `skip` bytes and end after `length` more, closing the
 * handle exactly once: when the window is sent, the client cancels, or a read fails.
 */
function windowStream(
  handle: StaticFileHandle,
  skip: number,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = handle.body.getReader()
  let toSkip = skip
  let left = length
  let closed = false
  const closeOnce = () => {
    if (closed) return
    closed = true
    handle.close()
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (left > 0) {
          const { done, value } = await reader.read()
          if (done) break
          let chunk = value
          if (toSkip > 0) {
            const dropped = Math.min(toSkip, chunk.byteLength)
            toSkip -= dropped
            chunk = chunk.subarray(dropped)
          }
          if (chunk.byteLength === 0) continue
          if (chunk.byteLength > left) chunk = chunk.subarray(0, left)
          left -= chunk.byteLength
          controller.enqueue(chunk)
          if (left > 0) return
        }
        closeOnce()
        controller.close()
        await reader.cancel().catch(() => {})
      } catch (error) {
        closeOnce()
        controller.error(error)
      }
    },
    cancel(reason) {
      closeOnce()
      return reader.cancel(reason)
    },
  })
}

/**
 * Answer `request` with the file at `path`, on Deno, Node and Bun: the runtime-neutral
 * counterpart of `serveFile` from `@std/http/file-server`.
 *
 * - **Range.** One `bytes=` range is answered `206` with `Content-Range`, which Safari needs to
 *   play a video; a range past the end is `416` with a `Content-Range` that names the size. A malformed
 *   header, or one asking for several ranges, gets the whole file. An `If-Range` other than the
 *   current `Last-Modified` also gets the whole file: the `ETag` is weak, which `If-Range` never
 *   matches.
 * - **Validators.** With a modification time from the `StaticFs`, the response carries a weak
 *   `ETag` (size and time) and `Last-Modified`; a matching `If-None-Match`, or without one an
 *   `If-Modified-Since` no older than the file, is answered `304` with no body.
 * - `Content-Type` comes from the extension ({@link contentTypeFor}), with `nosniff`, and
 *   `Accept-Ranges: bytes`. A `HEAD` request gets the same headers and no body.
 *
 * `path` is used as given: no root, no traversal or symlink check. Pass only a path the caller
 * built itself, or use {@link serveStatic} for a request path.
 *
 * @returns The response, or `undefined` when `path` is missing or not a regular file, for the
 * caller's own `404`.
 *
 * @example
 * ```ts
 * app.get("/video/:file", async (c) =>
 *   await serveFile(c.req.raw, `./video/${c.req.param("file")}`) ?? c.notFound())
 * ```
 */
export async function serveFile(
  request: Request,
  path: string,
  options: ServeFileOptions = {},
): Promise<Response | undefined> {
  const fs = options.fs ?? runtimeStaticFs
  const handle = await fs.open(path).catch(() => null)
  if (!handle) return undefined
  const { size } = handle
  const mtime = handle.mtime ?? null

  const headers = new Headers({
    "Content-Type": contentTypeFor(path),
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  })
  if (options.cacheControl) headers.set("Cache-Control", options.cacheControl)
  const etag = mtime ? `W/"${size.toString(36)}-${mtime.getTime().toString(36)}"` : undefined
  if (etag) headers.set("ETag", etag)
  if (mtime) headers.set("Last-Modified", mtime.toUTCString())

  const noneMatch = request.headers.get("If-None-Match")
  const modifiedSince = Date.parse(request.headers.get("If-Modified-Since") ?? "")
  const notModified = noneMatch !== null
    ? etag !== undefined && noneMatchHits(noneMatch, etag)
    : mtime !== null && !Number.isNaN(modifiedSince) &&
      Math.floor(mtime.getTime() / 1000) * 1000 <= modifiedSince
  if (notModified) {
    handle.close()
    return new Response(null, { status: 304, headers })
  }

  const ifRange = request.headers.get("If-Range")
  // If-Range compares strongly (RFC 9110 13.1.5), so the weak ETag never matches it.
  const rangeAllowed = ifRange === null || (mtime !== null && ifRange === mtime.toUTCString())
  const range = rangeAllowed ? parseRange(request.headers.get("Range"), size) : undefined
  const isHead = request.method === "HEAD"

  if (range === "unsatisfiable") {
    handle.close()
    headers.set("Content-Range", `bytes */${size}`)
    return new Response(null, { status: 416, headers })
  }

  if (range === undefined) {
    headers.set("Content-Length", String(size))
    if (isHead) {
      handle.close()
      return new Response(null, { headers })
    }
    return new Response(closingStream(handle), { headers })
  }

  const length = range.end - range.start + 1
  headers.set("Content-Length", String(length))
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`)
  if (isHead) {
    handle.close()
    return new Response(null, { status: 206, headers })
  }
  let source = handle
  let skip = range.start
  if (range.start > 0 && fs.openAt) {
    handle.close()
    const moved = await fs.openAt(path, range.start).catch(() => null)
    if (!moved) return undefined
    source = moved
    skip = 0
  }
  return new Response(windowStream(source, skip, length), { status: 206, headers })
}
