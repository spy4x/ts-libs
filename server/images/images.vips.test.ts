/**
 * `processImage` against the real `vips`, on photos this test makes itself: a JPEG and a HEIC,
 * 300 by 200 pixels, white on the left and black on the right, carrying an EXIF orientation that
 * turns them a quarter clockwise, a GPS position and an XMP creator.
 *
 * Needs `vips`, `vipsheader` and `exiftool`: `deno task test:vips` (AGENTS.md, "Test tiers").
 * Without them it fails; it never skips.
 */

import { assert, assertEquals } from "@std/assert"
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd"
import { runCommand } from "@spy4x/platform/server/run-command"
import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import { processImage } from "./mod.ts"

async function run(...command: string[]): Promise<string> {
  const result = await runCommand(command)
  if (!result.success) {
    throw new Error(`${command.join(" ")} failed (${result.code}): ${result.stderr}
vips, vipsheader and exiftool must be installed: run \`deno task test:vips\` as AGENTS.md says.`)
  }
  return result.stdout
}

/** The metadata exiftool finds: every EXIF, XMP, IPTC, ICC or maker-note tag, and any GPS tag. */
async function metadata(path: string): Promise<string[]> {
  const [tags] = JSON.parse(await run("exiftool", "-j", "-G", "-a", path))
  return Object.keys(tags).filter((tag) =>
    /^(EXIF|XMP|IPTC|ICC_Profile|MakerNotes|Photoshop):/.test(tag) || tag.includes("GPS")
  )
}

/** The grey level of one pixel. */
async function grey(path: string, x: number, y: number): Promise<number> {
  return Number((await run("vips", "getpoint", path, String(x), String(y))).trim().split(" ")[0])
}

let folder = ""
const samples: Record<string, string> = {}

describe("processImage with the real vips", () => {
  beforeAll(async () => {
    folder = await createScratchFolder("images_vips")
    const at = (name: string) => `${folder}/${name}`
    await run("vips", "black", at("black.v"), "150", "200")
    await run("vips", "invert", at("black.v"), at("white.v"))
    await run("vips", "join", at("white.v"), at("black.v"), at("grey.v"), "horizontal")
    await run("vips", "bandjoin", `${at("grey.v")} ${at("grey.v")} ${at("grey.v")}`, at("rgb.v"))
    samples.jpeg = at("photo.jpg")
    await run("vips", "copy", at("rgb.v"), samples.jpeg)
    await run(
      "exiftool",
      "-q",
      "-overwrite_original",
      "-Orientation#=6",
      "-GPSLatitude=1.29",
      "-GPSLatitudeRef=N",
      "-GPSLongitude=103.85",
      "-GPSLongitudeRef=E",
      "-XMP-dc:Creator=Photographer",
      samples.jpeg,
    )
    samples.heic = at("photo.heic")
    await run("vips", "heifsave", samples.jpeg, samples.heic, "--compression", "hevc")
  })

  afterAll(async () => {
    if (folder) await removeScratchFolder(folder)
  })

  for (const kind of ["jpeg", "heic"]) {
    it(`makes upright AVIF and WebP variants with no metadata from a ${kind} with GPS`, async () => {
      const before = await metadata(samples[kind])
      assert(before.some((tag) => tag.startsWith("EXIF:GPS")), `the sample has GPS: ${before}`)
      assert(before.some((tag) => tag.startsWith("XMP")), `the sample has XMP: ${before}`)
      const out = `${folder}/${kind}`
      await Deno.mkdir(out)

      const result = await processImage(samples[kind], out, { widths: [100, 480] })

      assertEquals(result.output?.map(({ type, width, height }) => [type, width, height]), [
        ["image/avif", 100, 150],
        ["image/avif", 200, 300],
        ["image/webp", 100, 150],
        ["image/webp", 200, 300],
      ])
      for (const variant of result.output ?? []) {
        assertEquals(await metadata(variant.path), [], variant.path)
        const head = new TextDecoder().decode((await Deno.readFile(variant.path)).subarray(0, 12))
        assert(variant.type === "image/avif" ? head.includes("ftypavif") : head.endsWith("WEBP"))
        // Turned a quarter clockwise: the white left half is now on top.
        assert(await grey(variant.path, variant.width / 2, 5) > 200, `top of ${variant.path}`)
        assert(await grey(variant.path, variant.width / 2, variant.height - 5) < 50, variant.path)
      }
    })
  }

  it("writes the same files when it runs twice on the same photo", async () => {
    const out = `${folder}/twice`
    await Deno.mkdir(out)
    const first = await processImage(samples.heic, out, { widths: [120] })
    const bytes = await Promise.all(first.output!.map(({ path }) => Deno.readFile(path)))
    const second = await processImage(samples.heic, out, { widths: [120] })
    assertEquals(second, first)
    assertEquals(await Promise.all(second.output!.map(({ path }) => Deno.readFile(path))), bytes)
  })
})
