import { assertEquals, assertRejects } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import type { CommandSpawner, SpawnOptions } from "@spy4x/platform/server/run-command"
import { ImageRefusal, processImage } from "./mod.ts"

interface Call {
  command: string
  options: SpawnOptions
}

/** What the fake `vipsheader` knows about the input: field name to value. */
type Fields = Record<string, string>

/**
 * A fake `vips`. `vipsheader -f <name>` answers `fields[name]`, or fails like a missing field;
 * `vipsheader -a` prints `exifText` and then the fields, as the real one prints EXIF text before
 * `orientation`. `thumbnail` writes nothing and answers `thumbnailCode`. `vipsheader <outputs>`
 * reports each output at `madeWidth` of the width in its name, with a 4:3 ratio.
 */
function fakeVips(
  fields: Fields,
  { thumbnailCode = 0, exifText = "", madeWidth = (width: number) => width } = {},
) {
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
    const [flag, name] = options.args
    if (command === "vips") return answer(thumbnailCode)
    if (flag === "-f") return name in fields ? answer(0, `${fields[name]}\n`) : answer(1)
    if (flag === "-a") {
      const dump = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")
      return answer(0, `${exifText}${dump}\n`)
    }
    const lines = options.args.map((path) => {
      const width = madeWidth(Number(path.match(/(\d+)\.\w+$/)![1]))
      return `${path}: ${width}x${width * 3 / 4} uchar, 3 bands, srgb, heifload`
    })
    return answer(0, lines.join("\n") + "\n")
  }
  const thumbnails = () => calls.filter(({ command }) => command === "vips")
  return { calls, spawn, thumbnails }
}

const header = (width: number, height: number, loader = "jpegload", orientation = 1): Fields => ({
  "vips-loader": loader,
  width: String(width),
  height: String(height),
  orientation: String(orientation),
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

  it("strips every variant's metadata and blocks untrusted loaders on every call", async () => {
    const vips = fakeVips(header(1000, 750))
    await processImage("/in", "/out", { widths: [480], spawn: vips.spawn })
    assertEquals(vips.thumbnails().map(({ options }) => options.args.slice(0, 4)), [
      ["thumbnail", "/in", "/out/480.avif[keep=none]", "480"],
      ["thumbnail", "/in", "/out/480.webp[keep=none]", "480"],
    ])
    for (const { options } of vips.calls) {
      assertEquals(options.env?.VIPS_BLOCK_UNTRUSTED, "1")
    }
  })

  it("reads the orientation libvips reports, not one forged in the photo's EXIF text", async () => {
    const exifText = "exif-ifd0-ImageDescription: x\norientation: 6\ny\n"
    const vips = fakeVips({ ...header(900, 1700), orientation: "1" }, { exifText })
    const result = await processImage("/in", "/out", { spawn: vips.spawn })
    assertEquals(result.output?.map(({ path }) => path), [
      "/out/480.avif",
      "/out/900.avif",
      "/out/480.webp",
      "/out/900.webp",
    ])
  })

  it("treats a photo with no orientation field as upright", async () => {
    const { orientation: _, ...fields } = header(900, 1700, "heifload")
    const vips = fakeVips(fields)
    const result = await processImage("/in", "/out", { widths: [5000], spawn: vips.spawn })
    assertEquals(result.output?.map(({ width }) => width), [900, 900])
  })

  it("drops a variant that came out as wide as a narrower one of its type", async () => {
    const vips = fakeVips(header(1000, 750), { madeWidth: (width) => Math.min(width, 900) })
    const result = await processImage("/in", "/out", { spawn: vips.spawn })
    assertEquals(result.output?.map(({ path, width }) => [path, width]), [
      ["/out/480.avif", 480],
      ["/out/960.avif", 900],
      ["/out/480.webp", 480],
      ["/out/960.webp", 900],
    ])
  })

  it("refuses a file vips cannot read", async () => {
    const vips = fakeVips({})
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
      assertEquals(vips.thumbnails().length, 0, loader)
    }
  })

  it("refuses an image over the pixel limit without decoding it", async () => {
    const vips = fakeVips(header(20_001, 5_000))
    const result = await processImage("/in", "/out", { spawn: vips.spawn })
    assertEquals(result.error, ImageRefusal.TooLarge)
    assertEquals(vips.thumbnails().length, 0)
  })

  it("throws when vips cannot start or fails to write a variant, so a retry can follow", async () => {
    const missing: CommandSpawner = () => {
      throw new Deno.errors.NotFound("vipsheader")
    }
    await assertRejects(() => processImage("/in", "/out", { spawn: missing }), Error, "vips")
    const broken = fakeVips(header(1000, 750), { thumbnailCode: 1 })
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
