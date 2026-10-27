/**
 * `@spy4x/server/images` — turns an uploaded photo into images a public page can show (#762):
 * upright, with every metadata block stripped (EXIF, XMP, GPS, ICC), as AVIF and WebP at a few
 * widths for a `srcset` (`responsiveImage` of `@spy4x/platform/universal/srcset`).
 *
 * It runs the `vips` and `vipsheader` command-line tools of libvips 8.15 or newer, which read
 * HEIC through libheif. On Debian: `libvips-tools`, `libheif-plugin-libde265` (HEIC) and
 * `libheif-plugin-aomenc` (AVIF). The tools work on files, so the caller downloads the upload to
 * a file of its own, passes its path and a folder for the variants, and stores what comes back.
 *
 * Only JPEG, PNG, WebP and HEIC (or AVIF) are read, whatever the file's name, and libvips's
 * untrusted loaders are blocked on every call. An image over `maxPixels` is refused before it is
 * decoded. Running it twice on the same file writes the same files.
 *
 * @module
 */

import { type CommandSpawner, runCommand } from "@spy4x/platform/server/run-command"

/** The widths made unless the caller names others. */
export const IMAGE_WIDTHS: readonly number[] = [480, 960, 1600]

/** The largest image read unless the caller names another limit: 100 megapixels. */
export const IMAGE_MAX_PIXELS = 100_000_000

/** The formats every width is stored in, the preferred one first. */
const FORMATS = [
  { extension: "avif", type: "image/avif" },
  { extension: "webp", type: "image/webp" },
] as const

/** The libvips loaders an upload may go through: JPEG, PNG, WebP, and HEIC or AVIF. */
const LOADERS = new Set(["jpegload", "pngload", "webpload", "heifload"])

/** Orientations (EXIF 5 to 8) that turn the image a quarter, so its width becomes its height. */
const QUARTER_TURNS = new Set([5, 6, 7, 8])

/** Why an image was not processed. Retrying will not change it. */
export enum ImageRefusal {
  /** libvips cannot read the file. */
  Unreadable = 1,
  /** A format other than JPEG, PNG, WebP or HEIC. */
  Format = 2,
  /** More pixels than `maxPixels`. */
  TooLarge = 3,
}

/** One stored variant: its file, `Content-Type` and size in pixels. */
export interface ImageVariant {
  path: string
  type: "image/avif" | "image/webp"
  width: number
  height: number
}

/** `{ success, output, error }`: the variants, AVIF then WebP, narrowest first, or the refusal. */
export type ImageResult =
  | { success: true; output: ImageVariant[]; error?: undefined }
  | { success: false; output?: undefined; error: ImageRefusal }

/** Options for {@link processImage}. */
export interface ProcessImageOptions {
  /** The widths to make; one wider than the image is made at the image's own width. */
  widths?: readonly number[]
  /** The largest width times height read; more is refused. */
  maxPixels?: number
  /** Aborting it stops the running `vips`, and the call throws. */
  signal?: AbortSignal
  /** Spawner override, for tests. */
  spawn?: CommandSpawner
}

/**
 * Makes the variants of the image at `input` in `outputDir`, named `<width>.avif` and
 * `<width>.webp`, and answers them, or why the image was refused. Each variant is turned upright
 * by the image's orientation and keeps no metadata.
 *
 * @throws {Error} When a path starts with `-` or holds `[`, which `vips` would read as an option;
 * when a width is not a positive whole number; when `vips` cannot start, is stopped, or fails to
 * write a variant. Those are worth a retry; a refusal is not.
 */
export async function processImage(
  input: string,
  outputDir: string,
  options: ProcessImageOptions = {},
): Promise<ImageResult> {
  const widths = options.widths ?? IMAGE_WIDTHS
  for (const path of [input, outputDir]) {
    if (path.startsWith("-") || path.includes("[")) {
      throw new Error(`vips would read this path as an option: ${path}`)
    }
  }
  if (widths.length === 0 || !widths.every((w) => Number.isSafeInteger(w) && w > 0)) {
    throw new Error(`Image widths must be positive whole numbers: ${widths.join(", ")}`)
  }
  const vips = (args: string[]) =>
    runCommand(args, {
      env: { VIPS_BLOCK_UNTRUSTED: "1" },
      signal: options.signal,
      spawn: options.spawn,
    })

  const header = await vips(["vipsheader", "-a", input])
  if (header.error !== undefined || header.signal !== undefined) throw vipsFailure(header)
  if (!header.success) return { success: false, error: ImageRefusal.Unreadable }
  const field = (name: string) => header.stdout.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]
  if (!LOADERS.has(field("vips-loader") ?? "")) {
    return { success: false, error: ImageRefusal.Format }
  }
  const storedWidth = Number(field("width"))
  const storedHeight = Number(field("height"))
  if (!(storedWidth > 0 && storedHeight > 0)) {
    return { success: false, error: ImageRefusal.Unreadable }
  }
  if (storedWidth * storedHeight > (options.maxPixels ?? IMAGE_MAX_PIXELS)) {
    return { success: false, error: ImageRefusal.TooLarge }
  }
  const turned = QUARTER_TURNS.has(Number(field("orientation")))
  const uprightWidth = turned ? storedHeight : storedWidth
  const targets = [...new Set(widths.map((w) => Math.min(w, uprightWidth)))].sort((a, b) => a - b)

  const paths: { path: string; type: ImageVariant["type"] }[] = []
  for (const { extension, type } of FORMATS) {
    for (const width of targets) {
      const path = `${outputDir}/${width}.${extension}`
      // `thumbnail` turns the image upright, `--size down` never enlarges it, the export profile
      // turns its colours to sRGB before `keep=none` drops every metadata block, the profile too.
      const made = await vips([
        "vips",
        "thumbnail",
        input,
        `${path}[keep=none]`,
        String(width),
        "--height",
        "10000000",
        "--size",
        "down",
        "--export-profile",
        "srgb",
      ])
      if (!made.success) throw vipsFailure(made)
      paths.push({ path, type })
    }
  }

  const sizes = await vips(["vipsheader", ...paths.map(({ path }) => path)])
  if (!sizes.success) throw vipsFailure(sizes)
  const output = paths.map(({ path, type }) => {
    const line = sizes.stdout.split("\n").find((line) => line.startsWith(`${path}: `)) ?? ""
    const [, width, height] = line.slice(path.length + 2).match(/^(\d+)x(\d+) /) ?? []
    if (width === undefined) throw new Error(`vipsheader did not report the size of ${path}`)
    return { path, type, width: Number(width), height: Number(height) }
  })
  return { success: true, output }
}

function vipsFailure(result: { code: number; stderr: string; signal?: string }): Error {
  const how = result.signal ? `was stopped by ${result.signal}` : `exited with ${result.code}`
  return new Error(`vips ${how}: ${result.stderr.trim().slice(0, 500)}`)
}
