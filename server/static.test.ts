import { assertEquals, assertRejects, assertStrictEquals, assertStringIncludes } from "@std/assert"
import {
  contentTypeFor,
  denoStaticFs,
  isPathInsideRoot,
  KNOWN_EXTENSIONS,
  nodeStaticFs,
  resolveStaticPath,
  runtimeStaticFs,
  serveFile,
  serveStatic,
  type StaticFileHandle,
  type StaticFs,
} from "./static.ts"

/** Root used by the pure path tests. No filesystem is touched. */
const ROOT = "/srv/app/static"

/**
 * Static root for the read tests, resolved from this module's own URL.
 *
 * From `server/static.test.ts` that is `server/__fixtures__`.
 */
const FIXTURE_ROOT = new URL("./__fixtures__", import.meta.url).pathname.replace(/\/$/, "")

/** Filesystem over the committed fixture directory, using only `--allow-read`. */
const fixtureFs: StaticFs = denoStaticFs

/** Where a spy filesystem was asked to look, for assertions about refusal. */
interface FsSpy {
  fs: StaticFs
  /** Paths `open` was called with. */
  opened: string[]
  /** Paths whose handle's `close` was called. One entry per close call. */
  closed: string[]
  real: string[]
}

/**
 * A single-chunk `ReadableStream` for a spy filesystem's handle, plus a size
 * derived from the same bytes so `Content-Length` matches what was served.
 */
function singleChunkBody(text: string): { size: number; body: ReadableStream<Uint8Array> } {
  const bytes = new TextEncoder().encode(text)
  return {
    size: bytes.length,
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

/**
 * Filesystem over an in-memory file map that records every path it was asked for.
 *
 * A refusal test asserts `opened` and `real` stayed empty: "returned undefined"
 * alone would also be true for a filesystem that was probed and found nothing.
 */
function spyFs(files: Record<string, string>): FsSpy {
  const opened: string[] = []
  const closed: string[] = []
  const real: string[] = []
  const fs: StaticFs = {
    open: (path) => {
      opened.push(path)
      const text = files[path]
      if (text === undefined) return Promise.resolve(null)
      const { size, body } = singleChunkBody(text)
      return Promise.resolve({
        size,
        body,
        close: () => closed.push(path),
      })
    },
    stat: (path) => Promise.resolve(files[path] === undefined ? null : { isFile: true }),
    realPath: (path) => {
      real.push(path)
      return Promise.resolve(path)
    },
  }
  return { fs, opened, closed, real }
}

Deno.test("static: a plain file path resolves under the root", () => {
  assertEquals(resolveStaticPath("/app.js", ROOT), {
    ok: true,
    filePath: "/srv/app/static/app.js",
    relativePath: "app.js",
  })
})

Deno.test("static: a nested path resolves under the root", () => {
  assertEquals(resolveStaticPath("/assets/icons/logo.svg", ROOT).ok, true)
  const resolved = resolveStaticPath("/assets/icons/logo.svg", ROOT)
  assertStrictEquals(resolved.ok, true)
  if (resolved.ok) {
    assertEquals(resolved.filePath, "/srv/app/static/assets/icons/logo.svg")
  }
})

Deno.test("static: a percent-encoded filename is decoded once", () => {
  const resolved = resolveStaticPath("/na%C3%AFve%20caf%C3%A9.css", ROOT)
  assertStrictEquals(resolved.ok, true)
  if (resolved.ok) {
    assertEquals(resolved.filePath, "/srv/app/static/naïve café.css")
  }
})

Deno.test("static: a parent segment is refused", () => {
  for (const path of ["/../secret", "/assets/../../secret", "/a/b/../../../secret"]) {
    assertEquals(resolveStaticPath(path, ROOT), { ok: false, reason: "parent_segment" })
  }
})

Deno.test("static: a percent-encoded parent segment is refused", () => {
  for (const path of ["/%2e%2e/secret", "/assets/%2e%2e/%2e%2e/secret"]) {
    assertEquals(resolveStaticPath(path, ROOT), { ok: false, reason: "parent_segment" })
  }
})

Deno.test("static: an encoded separator is refused rather than re-split", () => {
  for (const path of ["/a%2Fb", "/a%2fb", "/a%5Cb", "/a%5cb"]) {
    assertEquals(resolveStaticPath(path, ROOT), { ok: false, reason: "encoded_separator" })
  }
})

Deno.test("static: a raw backslash is refused", () => {
  assertEquals(resolveStaticPath("/..\\secret", ROOT), { ok: false, reason: "backslash" })
  assertEquals(resolveStaticPath("/a\\b", ROOT), { ok: false, reason: "backslash" })
})

Deno.test("static: an absolute or UNC-style path is refused", () => {
  // `//etc/passwd` survives the leading-slash strip as `/etc/passwd`.
  assertEquals(resolveStaticPath("//etc/passwd", ROOT), { ok: false, reason: "absolute_path" })
})

Deno.test("static: a NUL byte or control character is refused", () => {
  assertEquals(resolveStaticPath("/app.js%00.png", ROOT), {
    ok: false,
    reason: "control_character",
  })
  assertEquals(resolveStaticPath("/app%0a.js", ROOT), { ok: false, reason: "control_character" })
  assertEquals(resolveStaticPath("/app\u007f.js", ROOT), {
    ok: false,
    reason: "control_character",
  })
})

Deno.test("static: a malformed escape sequence is refused, not thrown", () => {
  assertEquals(resolveStaticPath("/100%.js", ROOT), { ok: false, reason: "not_a_file_path" })
  assertEquals(resolveStaticPath("/%zz.js", ROOT), { ok: false, reason: "not_a_file_path" })
})

Deno.test("static: a directory-style or empty path is refused", () => {
  assertEquals(resolveStaticPath("/", ROOT), { ok: false, reason: "empty_path" })
  assertEquals(resolveStaticPath("/assets/", ROOT), { ok: false, reason: "empty_path" })
  assertEquals(resolveStaticPath("", ROOT), { ok: false, reason: "empty_path" })
})

Deno.test("static: a dot segment is refused", () => {
  assertEquals(resolveStaticPath("/./app.js", ROOT), { ok: false, reason: "not_a_file_path" })
})

Deno.test("static: double-encoded traversal cannot reach a parent segment", () => {
  // `%252e%252e` decodes to the literal text `%2e%2e`, which is not a parent
  // segment, so it resolves to a file name that cannot exist. It must never be
  // decoded a second time into `..`.
  const resolved = resolveStaticPath("/%252e%252e/secret", ROOT)
  assertStrictEquals(resolved.ok, true)
  if (resolved.ok) {
    assertEquals(resolved.relativePath, "%2e%2e/secret")
    assertStrictEquals(resolved.relativePath.includes(".."), false)
  }
})

Deno.test("static: a root with a trailing slash is normalised", () => {
  assertEquals(resolveStaticPath("/app.js", "/srv/app/static/"), {
    ok: true,
    filePath: "/srv/app/static/app.js",
    relativePath: "app.js",
  })
})

Deno.test("static: isPathInsideRoot accepts the root and its children only", () => {
  assertEquals(isPathInsideRoot("/srv/app/static/app.js", ROOT), true)
  assertEquals(isPathInsideRoot("/srv/app/static", ROOT), true)
  assertEquals(isPathInsideRoot("/srv/app/static/assets/app.js", ROOT), true)
  // The classic prefix bug: `/srv/app/static-secrets` starts with the root string.
  assertEquals(isPathInsideRoot("/srv/app/static-secrets/app.js", ROOT), false)
  assertEquals(isPathInsideRoot("/srv/app/private/app.js", ROOT), false)
  assertEquals(isPathInsideRoot("/etc/passwd", ROOT), false)
})

Deno.test("static: content types come from the extension, case-insensitively", () => {
  assertEquals(contentTypeFor("index.html"), "text/html; charset=utf-8")
  assertEquals(contentTypeFor("app.js"), "text/javascript; charset=utf-8")
  assertEquals(contentTypeFor("app.mjs"), "text/javascript; charset=utf-8")
  assertEquals(contentTypeFor("styles.CSS"), "text/css; charset=utf-8")
  assertEquals(contentTypeFor("data.json"), "application/json")
  assertEquals(contentTypeFor("logo.svg"), "image/svg+xml")
  assertEquals(contentTypeFor("font.woff2"), "font/woff2")
  assertEquals(contentTypeFor("manifest.webmanifest"), "application/manifest+json")
})

Deno.test("static: an unknown extension is never served as html", () => {
  assertEquals(contentTypeFor("payload.bin"), "application/octet-stream")
  assertEquals(contentTypeFor("index.html.txt"), "text/plain; charset=utf-8")
  assertEquals(contentTypeFor("README"), "application/octet-stream")
  assertEquals(contentTypeFor("dir.d/file"), "application/octet-stream")
})

Deno.test("static: every text type in the MIME table declares a charset", () => {
  for (const extension of KNOWN_EXTENSIONS) {
    const type = contentTypeFor(`file.${extension}`)
    assertStrictEquals(type.length > 0, true)
    assertStrictEquals(
      /^text\//.test(type) ? type.includes("charset=utf-8") : true,
      true,
      `${extension} is text but declares no charset`,
    )
  }
})

Deno.test("static: a fixture file is served with its bytes and content type", async () => {
  const response = await serveStatic("/index.html", { root: FIXTURE_ROOT, fs: fixtureFs })
  assertStrictEquals(response !== undefined, true)
  const text = await response!.text()
  assertStringIncludes(text, "ts-libs static fixture")
  assertEquals(response!.headers.get("content-type"), "text/html; charset=utf-8")
  assertEquals(response!.headers.get("x-content-type-options"), "nosniff")
  assertEquals(response!.status, 200)
})

Deno.test("static: a refused path never reaches the filesystem", async () => {
  const spy = spyFs({})
  const paths = [
    "/../secret",
    "/%2e%2e/secret",
    "/a%2Fb",
    "/a\\b",
    "/./x",
    "/../",
    "/%2e%2e/",
    "//",
  ]
  for (const path of paths) {
    const response = await serveStatic(path, { root: ROOT, fs: spy.fs })
    assertEquals(response, undefined, `${path} was served`)
  }
  assertEquals(spy.opened, [], "a refused path was read from disk")
  assertEquals(spy.real, [], "a refused path was resolved on disk")
})

Deno.test("static: a path ending in a slash serves that directory's index.html", async () => {
  const spy = spyFs({
    [`${ROOT}/index.html`]: "root index",
    [`${ROOT}/docs/index.html`]: "docs index",
  })

  const root = await serveStatic("/", { root: ROOT, fs: spy.fs })
  const docs = await serveStatic("/docs/", { root: ROOT, fs: spy.fs })
  const docsWithFallback = await serveStatic("/docs/", {
    root: ROOT,
    fs: spy.fs,
    spaFallback: true,
  })
  const missing = await serveStatic("/assets/", { root: ROOT, fs: spy.fs })

  assertEquals(await root?.text(), "root index")
  assertEquals(await docs?.text(), "docs index")
  assertEquals(await docsWithFallback?.text(), "docs index")
  assertEquals(docs?.headers.get("content-type"), "text/html; charset=utf-8")
  assertEquals(missing, undefined)
})

Deno.test("static: a traversal path cannot read a file outside the root", async () => {
  // Even with a filesystem that would happily return `/etc/passwd`, the guard has
  // to stop the read. This is the security case the source had no protection for.
  const spy = spyFs({ "/etc/passwd": "root:x:0:0:root:/root:/bin/sh" })
  const response = await serveStatic("/../etc/passwd", { root: ROOT, fs: spy.fs })
  assertEquals(response, undefined)
  assertEquals(spy.opened, [])
})

Deno.test("static: a symlink escaping the root is refused", async () => {
  // The request path is inside the root; only the realpath reveals that the
  // target is not. `open` throws if it is ever reached: this refusal must
  // happen before any file is opened.
  const fs: StaticFs = {
    open: () => {
      throw new Error("open must not be called for a path outside the root")
    },
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => {
      if (path === ROOT) return Promise.resolve(ROOT)
      return Promise.resolve("/srv/app/static-passwd")
    },
  }
  const response = await serveStatic("/passwd", { root: ROOT, fs })
  assertEquals(response, undefined)
})

Deno.test("static: a missing file is not served when the SPA fallback is off", async () => {
  const response = await serveStatic("/missing.js", { root: FIXTURE_ROOT, fs: fixtureFs })
  assertEquals(response, undefined)
})

Deno.test("static: the SPA fallback serves index.html for a missing path", async () => {
  const response = await serveStatic("/some/app/route", {
    root: FIXTURE_ROOT,
    fs: fixtureFs,
    spaFallback: true,
  })
  assertStrictEquals(response !== undefined, true)
  assertStringIncludes(await response!.text(), "ts-libs static fixture")
  assertEquals(response!.headers.get("content-type"), "text/html; charset=utf-8")
})

Deno.test("static: the SPA fallback still refuses a traversal path", async () => {
  const spy = spyFs({})
  const response = await serveStatic("/../secret", {
    root: ROOT,
    fs: spy.fs,
    spaFallback: true,
  })
  assertEquals(response, undefined)
  assertEquals(spy.opened, [], "the SPA fallback read a traversal path")
})

Deno.test("static: the SPA fallback refuses a backslash, a control character and a malformed escape", async () => {
  const spy = spyFs({ [`${ROOT}/index.html`]: "shell" })
  const paths = ["/a\\b", "/a%00b", "/a%0Ab", "/a%7Fb", "/a%zz", "/a%"]

  for (const path of paths) {
    const response = await serveStatic(path, { root: ROOT, fs: spy.fs, spaFallback: true })
    assertEquals(response, undefined, `served the shell for ${JSON.stringify(path)}`)
  }
  assertEquals(spy.opened, [], "the SPA fallback read a refused path")
})

// A doubled slash leaves an empty segment, which `resolveStaticPath` refuses as `not_a_file_path`.
// The fallback does not answer it: it is no route an SPA links to, and serving it would need a
// rejection reason of its own.
Deno.test("static: the SPA fallback does not answer a path with a doubled slash", async () => {
  const spy = spyFs({ [`${ROOT}/index.html`]: "shell" })

  assertEquals(
    await serveStatic("/docs//", { root: ROOT, fs: spy.fs, spaFallback: true }),
    undefined,
  )
  assertEquals(spy.opened, [])
})

Deno.test("static: the SPA fallback serves the shell for a path refused for an encoded slash", async () => {
  const spy = spyFs({ [`${ROOT}/index.html`]: "shell" })

  const response = await serveStatic("/tasks/a%2Fb", { root: ROOT, fs: spy.fs, spaFallback: true })

  assertEquals(await response?.text(), "shell")
  assertEquals(spy.opened, [`${ROOT}/index.html`])
})

Deno.test("static: the SPA fallback serves index.html for the root path", async () => {
  const response = await serveStatic("/", {
    root: FIXTURE_ROOT,
    fs: fixtureFs,
    spaFallback: true,
  })
  assertStrictEquals(response !== undefined, true)
  assertStringIncludes(await response!.text(), "ts-libs static fixture")
})

Deno.test("static: the SPA fallback does not swallow an existing file", async () => {
  const response = await serveStatic("/app.css", {
    root: FIXTURE_ROOT,
    fs: fixtureFs,
    spaFallback: true,
  })
  assertStrictEquals(response !== undefined, true)
  assertEquals(response!.headers.get("content-type"), "text/css; charset=utf-8")
  assertStringIncludes(await response!.text(), "color-scheme")
})

Deno.test("static: cache-control is set only when configured", async () => {
  const plain = await serveStatic("/app.css", { root: FIXTURE_ROOT, fs: fixtureFs })
  assertEquals(plain?.headers.get("cache-control"), null)

  const cached = await serveStatic("/app.css", {
    root: FIXTURE_ROOT,
    fs: fixtureFs,
    cacheControl: "public, max-age=31536000, immutable",
  })
  assertEquals(cached?.headers.get("cache-control"), "public, max-age=31536000, immutable")
})

Deno.test("static: a file that disappears between stat and open is not served", async () => {
  const fs: StaticFs = {
    open: () => Promise.reject(new Error("ENOENT")),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }
  const response = await serveStatic("/gone.css", { root: ROOT, fs })
  assertEquals(response, undefined)
})

Deno.test("static: the content-length header comes from the file's size", async () => {
  const spy = spyFs({ "/srv/app/static/app.css": "body { color: red }" })
  const response = await serveStatic("/app.css", { root: ROOT, fs: spy.fs })
  assertStrictEquals(response !== undefined, true)
  assertEquals(response!.headers.get("content-length"), "19")
})

Deno.test("static: a real fixture file's content-length matches its size on disk", async () => {
  const response = await serveStatic("/app.css", { root: FIXTURE_ROOT, fs: fixtureFs })
  assertStrictEquals(response !== undefined, true)
  const info = await Deno.stat(`${FIXTURE_ROOT}/app.css`)
  assertEquals(response!.headers.get("content-length"), String(info.size))
})

Deno.test("static: the body streams in more than one chunk, unread by the module", async () => {
  const chunks = ["first-", "second-", "third-", "fourth-", "fifth-chunk"]
  const encoder = new TextEncoder()
  const encoded = chunks.map((chunk) => encoder.encode(chunk))
  const totalSize = encoded.reduce((sum, chunk) => sum + chunk.length, 0)

  let pullCount = 0
  let index = 0
  let closeCount = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount++
      if (index < encoded.length) {
        controller.enqueue(encoded[index])
        index++
      } else {
        controller.close()
      }
    },
  })
  const fs: StaticFs = {
    open: () =>
      Promise.resolve(
        {
          size: totalSize,
          body,
          close: () => {
            closeCount++
          },
        } satisfies StaticFileHandle,
      ),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }

  const response = await serveStatic("/video.mp4", { root: ROOT, fs })
  assertStrictEquals(response !== undefined, true)
  assertEquals(response!.headers.get("content-length"), String(totalSize))

  // The stream's own backpressure-driven pulling has, at most, primed a couple of
  // chunks ahead by the time `serveStatic` returns. If the module instead
  // buffered the whole file before answering (e.g. via `.arrayBuffer()`), every
  // one of the five chunks would already be pulled at this point.
  assertStrictEquals(
    pullCount < chunks.length,
    true,
    `expected fewer than ${chunks.length} pulls before the caller reads anything, got ${pullCount}`,
  )
  assertStrictEquals(closeCount, 0, "the handle was closed before the body was read")

  const reader = response!.body!.getReader()
  const received: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received.push(value)
  }
  assertStrictEquals(received.length, chunks.length, "the file did not arrive as separate chunks")
  assertEquals(
    received.map((chunk) => new TextDecoder().decode(chunk)).join(""),
    chunks.join(""),
  )
  assertStrictEquals(closeCount, 1, "the handle was not closed exactly once after a full read")
})

Deno.test("static: the handle is closed when the client cancels the stream", async () => {
  let index = 0
  let closeCount = 0
  const chunks = ["one-", "two-", "three"]
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]))
        index++
      } else {
        controller.close()
      }
    },
  })
  const fs: StaticFs = {
    open: () =>
      Promise.resolve(
        {
          size: chunks.join("").length,
          body,
          close: () => {
            closeCount++
          },
        } satisfies StaticFileHandle,
      ),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }

  const response = await serveStatic("/video.mp4", { root: ROOT, fs })
  assertStrictEquals(response !== undefined, true)

  const reader = response!.body!.getReader()
  await reader.read() // read exactly one chunk, well short of the whole file
  assertStrictEquals(closeCount, 0, "the handle was closed before the client cancelled")

  await reader.cancel("client aborted")
  assertStrictEquals(closeCount, 1, "the handle was not closed after the client cancelled")
})

Deno.test("static: the handle is closed when an error happens after the open", async () => {
  let closeCount = 0
  const fs: StaticFs = {
    open: () =>
      Promise.resolve(
        {
          size: 10,
          // Accessing `body` throws, simulating a failure between a successful
          // open and the response being constructed.
          get body(): ReadableStream<Uint8Array> {
            throw new Error("boom")
          },
          close: () => {
            closeCount++
          },
        } satisfies StaticFileHandle,
      ),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }

  await assertRejects(() => serveStatic("/broken.bin", { root: ROOT, fs }), Error, "boom")
  assertStrictEquals(closeCount, 1, "the handle was not closed after the post-open error")
})

Deno.test("static: the handle is closed when the underlying stream errors mid-read", async () => {
  let closeCount = 0
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++
      if (pulls === 1) {
        controller.enqueue(new TextEncoder().encode("partial-"))
        return
      }
      controller.error(new Error("disk read failed"))
    },
  })
  const fs: StaticFs = {
    open: () =>
      Promise.resolve(
        {
          size: 100,
          body,
          close: () => {
            closeCount++
          },
        } satisfies StaticFileHandle,
      ),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }

  const response = await serveStatic("/flaky.bin", { root: ROOT, fs })
  assertStrictEquals(response !== undefined, true)

  const reader = response!.body!.getReader()
  await reader.read() // the one chunk that arrives before the read fails
  assertStrictEquals(closeCount, 0, "the handle was closed before the read actually failed")

  await assertRejects(() => reader.read(), Error, "disk read failed")
  assertStrictEquals(closeCount, 1, "the handle was not closed after the read failed")
})

Deno.test("static: a HEAD request gets a bodiless response with the handle already closed", async () => {
  let closeCount = 0
  let bodyAccessed = false
  const fs: StaticFs = {
    open: () =>
      Promise.resolve(
        {
          size: 42,
          // Accessing `body` at all would mean a stream was opened for a HEAD
          // request; the getter throws so any such access fails the test
          // instead of silently succeeding.
          get body(): ReadableStream<Uint8Array> {
            bodyAccessed = true
            throw new Error("a HEAD request must never read the body")
          },
          close: () => {
            closeCount++
          },
        } satisfies StaticFileHandle,
      ),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
  }

  const response = await serveStatic("/video.mp4", { root: ROOT, fs, method: "HEAD" })
  assertStrictEquals(response !== undefined, true)
  assertEquals(response!.body, null)
  assertEquals(response!.headers.get("content-length"), "42")
  assertEquals(response!.status, 200)
  assertStrictEquals(closeCount, 1, "the handle was not closed before the HEAD response returned")
  assertStrictEquals(bodyAccessed, false, "a HEAD request opened a stream for the body")
})

Deno.test("static: a GET request for the same path still streams normally", async () => {
  const spy = spyFs({ "/srv/app/static/app.css": "body { color: red }" })
  const response = await serveStatic("/app.css", { root: ROOT, fs: spy.fs, method: "GET" })
  assertStrictEquals(response !== undefined, true)
  assertStrictEquals(response!.body !== null, true)
  assertEquals(await response!.text(), "body { color: red }")
})

Deno.test("static: a real file is fully readable start to finish through denoStaticFs", async () => {
  const response = await serveStatic("/index.html", { root: FIXTURE_ROOT, fs: fixtureFs })
  assertStrictEquals(response !== undefined, true)
  const reader = response!.body!.getReader()
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  assertEquals(String(total), response!.headers.get("content-length"))
})

Deno.test("static: denoStaticFs refuses to open a directory as a file", async () => {
  const handle = await denoStaticFs.open(FIXTURE_ROOT)
  assertEquals(handle, null)
})

Deno.test("static: nodeStaticFs streams a file over several chunks, byte for byte", async () => {
  // llms-full.txt is far larger than one 64 KiB chunk.
  const path = new URL("../llms-full.txt", import.meta.url).pathname
  const handle = await nodeStaticFs.open(path)
  assertStrictEquals(handle !== null, true)
  const expected = await Deno.readFile(path)
  assertEquals(handle!.size, expected.byteLength)
  assertEquals(new Uint8Array(await new Response(handle!.body).arrayBuffer()), expected)
})

Deno.test("static: nodeStaticFs serves a real file through serveStatic", async () => {
  const response = await serveStatic("/index.html", { root: FIXTURE_ROOT, fs: nodeStaticFs })
  assertStrictEquals(response !== undefined, true)
  const body = await response!.text()
  assertEquals(body, await Deno.readTextFile(`${FIXTURE_ROOT}/index.html`))
  assertEquals(
    response!.headers.get("content-length"),
    String(new TextEncoder().encode(body).length),
  )
})

Deno.test("static: nodeStaticFs answers null for a directory or a missing path", async () => {
  assertEquals(await nodeStaticFs.open(FIXTURE_ROOT), null)
  assertEquals(await nodeStaticFs.open(`${FIXTURE_ROOT}/missing.txt`), null)
  assertEquals(await nodeStaticFs.stat(`${FIXTURE_ROOT}/missing.txt`), null)
  assertEquals(await nodeStaticFs.stat(FIXTURE_ROOT), { isFile: false })
  assertEquals(await nodeStaticFs.stat(`${FIXTURE_ROOT}/index.html`), { isFile: true })
  assertEquals(await nodeStaticFs.realPath(FIXTURE_ROOT), await Deno.realPath(FIXTURE_ROOT))
})

Deno.test("static: runtimeStaticFs reads through denoStaticFs on Deno", async () => {
  // Count calls to Deno.open, which only denoStaticFs makes.
  const realOpen = Deno.open
  let denoOpens = 0
  Deno.open = (...args: Parameters<typeof Deno.open>) => {
    denoOpens++
    return realOpen(...args)
  }
  try {
    const handle = await runtimeStaticFs.open(`${FIXTURE_ROOT}/index.html`)
    assertStrictEquals(handle !== null, true)
    handle!.close()
  } finally {
    Deno.open = realOpen
  }
  assertEquals(denoOpens, 1)
  assertEquals(await runtimeStaticFs.open(FIXTURE_ROOT), null)
  assertEquals(await runtimeStaticFs.realPath(FIXTURE_ROOT), await Deno.realPath(FIXTURE_ROOT))
})

Deno.test("static: nodeStaticFs closes the file once the body is read or cancelled", async () => {
  // Count closes on Node's FileHandle class, the one nodeStaticFs opens through.
  const fs = await import(["node", "fs/promises"].join(":")) as {
    open(path: string): Promise<{ close(): Promise<void> }>
  }
  const probe = await fs.open(`${FIXTURE_ROOT}/index.html`)
  const prototype = Object.getPrototypeOf(probe) as { close(): Promise<void> }
  await probe.close()
  const realClose = prototype.close
  let closes = 0
  prototype.close = function (this: unknown) {
    closes++
    return realClose.call(this)
  }
  try {
    const read = await nodeStaticFs.open(`${FIXTURE_ROOT}/index.html`)
    await new Response(read!.body).arrayBuffer()
    assertEquals(closes, 1)
    const cancelled = await nodeStaticFs.open(`${FIXTURE_ROOT}/index.html`)
    await cancelled!.body.cancel()
    assertEquals(closes, 2)
    cancelled!.close()
    assertEquals(closes, 2)
  } finally {
    prototype.close = realClose
  }
})

/** Ten known bytes, modified at a fixed time, with a count of open and closed handles. */
function memoryFile(withOpenAt: boolean) {
  const bytes = new TextEncoder().encode("0123456789")
  const mtime = new Date("2026-11-05T10:00:00.500Z")
  const state = { opened: 0, closed: 0, openedAt: [] as number[] }
  const handle = (start: number): StaticFileHandle => {
    state.opened++
    return {
      size: bytes.byteLength,
      mtime,
      // Two chunks, so a range has to cross a chunk boundary.
      body: ReadableStream.from([bytes.slice(start, 6), bytes.slice(Math.max(start, 6))]),
      close: () => state.closed++,
    }
  }
  const fs: StaticFs = {
    open: (path) => Promise.resolve(path === "/v.mp4" ? handle(0) : null),
    stat: () => Promise.resolve({ isFile: true }),
    realPath: (path) => Promise.resolve(path),
    ...(withOpenAt
      ? {
        openAt: (_path: string, start: number) => {
          state.openedAt.push(start)
          return Promise.resolve(handle(start))
        },
      }
      : {}),
  }
  return { fs, state, mtime }
}

const get = (headers: Record<string, string> = {}, method = "GET") =>
  new Request("http://localhost/v.mp4", { method, headers })

for (const withOpenAt of [true, false]) {
  const label = withOpenAt ? "with openAt" : "without openAt"

  Deno.test(`serveFile: answers one range with 206, ${label}`, async () => {
    const { fs, state } = memoryFile(withOpenAt)
    const response = await serveFile(get({ Range: "bytes=4-7" }), "/v.mp4", { fs })
    assertEquals(response!.status, 206)
    assertEquals(await response!.text(), "4567")
    assertEquals(response!.headers.get("content-range"), "bytes 4-7/10")
    assertEquals(response!.headers.get("content-length"), "4")
    assertEquals(state.opened, state.closed)
    assertEquals(state.openedAt, withOpenAt ? [4] : [])
  })

  Deno.test(`serveFile: a range past the first chunk, ${label}`, async () => {
    const { fs } = memoryFile(withOpenAt)
    const response = await serveFile(get({ Range: "bytes=7-8" }), "/v.mp4", { fs })
    assertEquals([response!.status, await response!.text()], [206, "78"])
  })
}

Deno.test("serveFile: reads open-ended and suffix ranges, and clamps the end", async () => {
  const { fs } = memoryFile(true)
  const read = async (range: string) => {
    const response = await serveFile(get({ Range: range }), "/v.mp4", { fs })
    return [response!.status, await response!.text(), response!.headers.get("content-range")]
  }
  assertEquals(await read("bytes=7-"), [206, "789", "bytes 7-9/10"])
  assertEquals(await read("bytes=-3"), [206, "789", "bytes 7-9/10"])
  assertEquals(await read("bytes=-30"), [206, "0123456789", "bytes 0-9/10"])
  assertEquals(await read("bytes=8-99"), [206, "89", "bytes 8-9/10"])
  assertEquals(await read("bytes=0-1"), [206, "01", "bytes 0-1/10"])
})

Deno.test("serveFile: a range past the end is 416, and a bad or multiple range gets it all", async () => {
  const { fs, state } = memoryFile(true)
  const past = await serveFile(get({ Range: "bytes=10-" }), "/v.mp4", { fs })
  assertEquals([past!.status, past!.headers.get("content-range")], [416, "bytes */10"])
  assertEquals(past!.body, null)
  for (const range of ["bytes=5-2", "bytes=0-1,4-5", "items=0-1", "bytes=-"]) {
    const whole = await serveFile(get({ Range: range }), "/v.mp4", { fs })
    assertEquals([whole!.status, await whole!.text()], [200, "0123456789"])
  }
  assertEquals(state.opened, state.closed)
})

Deno.test("serveFile: sends validators and answers a matching If-None-Match with 304", async () => {
  const { fs, state, mtime } = memoryFile(true)
  const first = await serveFile(get(), "/v.mp4", { fs, cacheControl: "public, max-age=60" })
  const etag = first!.headers.get("etag")!
  assertEquals(etag.startsWith('W/"'), true)
  assertEquals(first!.headers.get("last-modified"), mtime.toUTCString())
  assertEquals(first!.headers.get("content-type"), "video/mp4")
  assertEquals(first!.headers.get("accept-ranges"), "bytes")
  assertEquals(first!.headers.get("cache-control"), "public, max-age=60")
  assertEquals(await first!.text(), "0123456789")
  const again = await serveFile(get({ "If-None-Match": `"other", ${etag.slice(2)}` }), "/v.mp4", {
    fs,
  })
  assertEquals([again!.status, again!.body, again!.headers.get("etag")], [304, null, etag])
  const changed = await serveFile(get({ "If-None-Match": '"other"' }), "/v.mp4", { fs })
  assertEquals(changed!.status, 200)
  await changed!.body!.cancel()
  assertEquals(state.opened, state.closed)
})

Deno.test("serveFile: If-Modified-Since works to the second, and If-None-Match wins", async () => {
  const { fs, mtime } = memoryFile(true)
  const status = async (headers: Record<string, string>) => {
    const response = await serveFile(get(headers), "/v.mp4", { fs })
    await response!.body?.cancel()
    return response!.status
  }
  assertEquals(await status({ "If-Modified-Since": mtime.toUTCString() }), 304)
  assertEquals(
    await status({ "If-Modified-Since": new Date(mtime.getTime() - 1000).toUTCString() }),
    200,
  )
  assertEquals(await status({ "If-Modified-Since": "not a date" }), 200)
  assertEquals(
    await status({ "If-Modified-Since": mtime.toUTCString(), "If-None-Match": '"other"' }),
    200,
  )
})

Deno.test("serveFile: If-Range other than Last-Modified ignores the range", async () => {
  const { fs, mtime } = memoryFile(true)
  const etag = (await serveFile(get({ Range: "bytes=0-0" }), "/v.mp4", { fs }))!.headers.get(
    "etag",
  )!
  const read = async (ifRange: string) => {
    const response = await serveFile(get({ Range: "bytes=2-3", "If-Range": ifRange }), "/v.mp4", {
      fs,
    })
    return [response!.status, await response!.text()]
  }
  assertEquals(await read(etag), [200, "0123456789"])
  assertEquals(await read(mtime.toUTCString()), [206, "23"])
  assertEquals(await read('W/"stale"'), [200, "0123456789"])
})

Deno.test("serveFile: HEAD sends headers only and closes the file", async () => {
  const { fs, state } = memoryFile(true)
  const whole = await serveFile(get({}, "HEAD"), "/v.mp4", { fs })
  assertEquals([whole!.status, whole!.body, whole!.headers.get("content-length")], [
    200,
    null,
    "10",
  ])
  const part = await serveFile(get({ Range: "bytes=1-2" }, "HEAD"), "/v.mp4", { fs })
  assertEquals([part!.status, part!.body, part!.headers.get("content-length")], [206, null, "2"])
  assertEquals(state.opened, state.closed)
})

Deno.test("serveFile: a missing file is undefined, for the caller's 404", async () => {
  const { fs } = memoryFile(true)
  assertEquals(await serveFile(get(), "/missing.mp4", { fs }), undefined)
})

for (
  const [name, fs] of [["denoStaticFs", denoStaticFs], ["nodeStaticFs", nodeStaticFs]] as const
) {
  Deno.test(`static: ${name}.openAt starts the body at the given byte, with mtime`, async () => {
    const path = new URL("../llms-full.txt", import.meta.url).pathname
    const expected = await Deno.readFile(path)
    const handle = await fs.openAt!(path, 100_000)
    assertEquals(handle!.size, expected.byteLength)
    assertEquals(handle!.mtime instanceof Date, true)
    assertEquals(
      new Uint8Array(await new Response(handle!.body).arrayBuffer()),
      expected.subarray(100_000),
    )
    assertEquals(await fs.openAt!(FIXTURE_ROOT, 0), null)
  })

  Deno.test(`serveFile: a range deep in a real file through ${name}`, async () => {
    const path = new URL("../llms-full.txt", import.meta.url).pathname
    const expected = await Deno.readFile(path)
    const response = await serveFile(get({ Range: "bytes=70000-200000" }), path, { fs })
    assertEquals(response!.status, 206)
    assertEquals(
      new Uint8Array(await response!.arrayBuffer()),
      expected.subarray(70_000, 200_001),
    )
  })
}
