/**
 * The attributes of a responsive `<img>` or `<picture>`, from the widths an image is stored at
 * (#762), such as the AVIF and WebP variants `processImage` of `@spy4x/server/images` makes.
 *
 * ```tsx
 * const image = responsiveImage(variants, "(min-width: 60rem) 50vw, 100vw")
 * <picture>
 *   {image.sources.map((source) => <source type={source.type} srcset={source.srcset} sizes={image.sizes} />)}
 *   <img src={image.src} srcset={image.srcset} sizes={image.sizes} width={image.width} height={image.height} alt="" />
 * </picture>
 * ```
 *
 * @module
 */

/** One stored width of an image: where it is, its size in pixels and its `Content-Type`. */
export interface ResponsiveImageVariant {
  url: string
  width: number
  height: number
  type: string
}

/** One `<source>` of a `<picture>`: a type and its `srcset`. */
export interface ResponsiveImageSource {
  type: string
  srcset: string
}

/** What {@link responsiveImage} answers: a `<source>` per preferred type, and the `<img>`'s own. */
export interface ResponsiveImage {
  /** One per type but the last, in the order the variants first name them. */
  sources: ResponsiveImageSource[]
  /** The widest variant of the last type, for a browser that reads no `srcset`. */
  src: string
  /** Every variant of the last type, narrowest first. */
  srcset: string
  sizes: string
  /** The widest variant's size, so the page keeps the image's place before it loads. */
  width: number
  height: number
}

/** `url 480w, url 960w`: the variants narrowest first. */
function srcsetOf(variants: readonly ResponsiveImageVariant[]): string {
  return [...variants].sort((a, b) => a.width - b.width)
    .map((variant) => `${variant.url} ${variant.width}w`).join(", ")
}

/**
 * The `<picture>` and `<img>` attributes for `variants`. List the preferred type first, such as
 * AVIF before WebP: each type but the last becomes a `<source>`, and the last is the `<img>`'s,
 * so make it one every browser shows. `sizes` says how wide the image is drawn; `100vw` unless
 * given.
 *
 * @throws {Error} When there is no variant, a size is not a positive whole number, a URL holds
 * whitespace or starts or ends with a comma (a `srcset` cannot carry it), or two variants of one
 * type have the same width.
 */
export function responsiveImage(
  variants: readonly ResponsiveImageVariant[],
  sizes = "100vw",
): ResponsiveImage {
  if (variants.length === 0) throw new Error("A responsive image needs at least one variant")
  const byType = new Map<string, ResponsiveImageVariant[]>()
  for (const variant of variants) {
    const { url, width, height, type } = variant
    if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0)) {
      throw new Error(`A variant's width and height must be positive whole numbers: ${url}`)
    }
    if (/\s/.test(url) || url.startsWith(",") || url.endsWith(",") || url === "") {
      throw new Error(`A srcset cannot carry this URL: ${JSON.stringify(url)}`)
    }
    const ofType = byType.get(type) ?? []
    if (ofType.some((other) => other.width === width)) {
      throw new Error(`Two ${type} variants are ${width} pixels wide`)
    }
    byType.set(type, [...ofType, variant])
  }
  const types = [...byType.keys()]
  const fallback = byType.get(types[types.length - 1])!
  const widest = fallback.reduce((a, b) => (b.width > a.width ? b : a))
  return {
    sources: types.slice(0, -1).map((type) => ({ type, srcset: srcsetOf(byType.get(type)!) })),
    src: widest.url,
    srcset: srcsetOf(fallback),
    sizes,
    width: widest.width,
    height: widest.height,
  }
}
