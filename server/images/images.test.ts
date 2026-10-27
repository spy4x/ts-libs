import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { CommandSpawner, SpawnOptions } from "@spy4x/platform/server/run-command"
import { ImageRefusal, processImage } from "./mod.ts"

interface Call {
  command: string
  options: SpawnOptions
}

/**
 * A fake `vips`: `vipsheader -a` answers `header`, `thumbnail` writes nothing and answers
 * `thumbnailCode`, and `vipsheader <outputs>` reports each output at its width with a 4:3 ratio.
 */
function fakeVips(header: { code?: number; stdout: string }, thumbnailCode = 0) {
  const calls: Call[] = []
  const answer = (code: number, stdout = "") => ({
    output: () =>
      Promise.resolve({
        success: code === 0,
        code,
        stdout: new TextEncoder().encode(stdout),
        stderr: new TextEncoder().encode(code === 0 ? "" : "vips: something broke"),
      }),
  })
  const spawn: CommandSpawner = (command, options) => {
    calls.push({ command, options })
    if (command === "vips") return answer(thumbnailCode)
    if (options.args[0] === "-a") return answer(header.code ?? 0, header.stdout)
    const lines = options.args.map((path) => {
      const width = Number(path.match(/(\d+)\.\w+$/)![1])
      return `${path}: ${width}x${width * 3 / 4} uchar, 3 bands, srgb, heifload`
    })
    return answer(0, lines.join("\n") + "\n")
  }
  return { calls, spawn }
}

const header = (width: number, height: number, loader = "jpegload", orientation = 1) => ({
  stdout:
    `width: ${width}\nheight: ${height}\norientation: ${orientation}\nvips-loader: ${loader}\n`,
})

describe("processImage", () => {
  it("makes AVIF and WebP at each width, never wider than the image", async () => {
    const vips = fakeVips(header(1000, 750))
    const result = await processImage("/tmp/in", "/tmp/out", { spawn: vips.spawn })
    assertEquals(
      result.output?.map(({ path, type, width, height }) => [path, type, width, height]),
      [
        ["/tmp/out/480.avif", "image/avif", 480, 360],
        ["/tmp/out/960.avif", "image/avif", 960, 720],
        ["/tmp/out/1000.avif", "image/avif", 1000, 750],
        ["/tmp/out/480.webp", "image/webp", 480, 360],
        ["/tmp/out/960.webp", "image/webp", 960, 720],
        ["/tmp/out/1000.webp", "image/webp", 1000, 750],
      ],
    )
  })

  it("measures a photo turned a quarter by its orientation by its upright width", async () => {
    const vips = fakeVips(header(4000, 3000, "jpegload", 6))
    const result = await processImage("/in", "/out", { widths: [5000], spawn: vips.spawn })
    assertEquals(result.output?.map(({ path }) => path), ["/out/3000.avif", "/out/3000.webp"])
  })

  it("turns every variant upright and strips its metadata, with untrusted loaders blocked", async () => {
    const vips = fakeVips(header(1000, 750))
    await processImage("/in", "/out", { widths: [480], spawn: vips.spawn })
    const thumbnails = vips.calls.filter(({ command }) => command === "vips")
    assertEquals(thumbnails.map(({ options }) => options.args.slice(0, 4)), [
      ["thumbnail", "/in", "/out/480.avif[keep=none]", "480"],
      ["thumbnail", "/in", "/out/480.webp[keep=none]", "480"],
    ])
    for (const { options } of vips.calls) {
      assertEquals(options.env?.VIPS_BLOCK_UNTRUSTED, "1")
    }
  })

  it("refuses a file vips cannot read", async () => {
    const vips = fakeVips({ code: 1, stdout: "" })
    assertEquals(await processImage("/in", "/out", { spawn: vips.spawn }), {
      success: false,
      error: ImageRefusal.Unreadable,
    })
  })

  it("refuses a format other than JPEG, PNG, WebP or HEIC without decoding it", async () => {
    for (const loader of ["svgload", "pdfload", "gifload", "magickload"]) {
      const vips = fakeVips(header(100, 100, loader))
      const result = await processImage("/in", "/out", { spawn: vips.spawn })
      assertEquals(result.error, ImageRefusal.Format, loader)
      assertEquals(vips.calls.length, 1, loader)
    }
  })

  it("refuses an image over the pixel limit without decoding it", async () => {
    const vips = fakeVips(header(20_001, 5_000))
    const result = await processImage("/in", "/out", { spawn: vips.spawn })
    assertEquals(result.error, ImageRefusal.TooLarge)
    assertEquals(vips.calls.length, 1)
  })

  it("throws when vips cannot start or fails to write a variant, so a retry can follow", async () => {
    const missing: CommandSpawner = () => {
      throw new Deno.errors.NotFound("vipsheader")
    }
    await assertRejects(() => processImage("/in", "/out", { spawn: missing }), Error, "vips")
    const broken = fakeVips(header(1000, 750), 1)
    await assertRejects(() => processImage("/in", "/out", { spawn: broken.spawn }), Error, "broke")
  })

  it("throws for a path vips would read as an option, or a width that is not a whole number", async () => {
    const vips = fakeVips(header(1000, 750))
    for (const [input, out] of [["-in", "/out"], ["/in[shrink=2]", "/out"], ["/in", "/o[x]"]]) {
      await assertRejects(() => processImage(input, out, { spawn: vips.spawn }), Error, "option")
    }
    for (const widths of [[], [0], [480.5]]) {
      await assertRejects(() => processImage("/in", "/out", { widths, spawn: vips.spawn }), Error)
    }
    assertEquals(vips.calls.length, 0)
  })
})
