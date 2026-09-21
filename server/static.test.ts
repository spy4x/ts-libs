import { assertEquals, assertRejects, assertStrictEquals, assertStringIncludes } from "@std/assert"
import {
  contentTypeFor,
  denoStaticFs,
  isPathInsideRoot,
  KNOWN_EXTENSIONS,
  resolveStaticPath,
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
  for (const path of ["/../secret", "/%2e%2e/secret", "/a%2Fb", "/a\\b", "/", "/./x"]) {
    const response = await serveStatic(path, { root: ROOT, fs: spy.fs })
    assertEquals(response, undefined, `${path} was served`)
  }
  assertEquals(spy.opened, [], "a refused path was read from disk")
  assertEquals(spy.real, [], "a refused path was resolved on disk")
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
