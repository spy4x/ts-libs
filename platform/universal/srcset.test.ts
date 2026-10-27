import { assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import { responsiveImage, type ResponsiveImageVariant } from "./srcset.ts"

const variant = (type: string, width: number): ResponsiveImageVariant => ({
  url: `/img/${width}.${type.slice(6)}`,
  width,
  height: width * 3 / 4,
  type,
})

/** Out of order on purpose: AVIF first, the widths shuffled. */
const VARIANTS = [
  variant("image/avif", 960),
  variant("image/avif", 480),
  variant("image/webp", 1600),
  variant("image/webp", 480),
  variant("image/webp", 960),
]

describe("responsiveImage", () => {
  it("makes a source of each preferred type and the img of the last type, narrowest first", () => {
    assertEquals(responsiveImage(VARIANTS, "50vw"), {
      sources: [{ type: "image/avif", srcset: "/img/480.avif 480w, /img/960.avif 960w" }],
      src: "/img/1600.webp",
      srcset: "/img/480.webp 480w, /img/960.webp 960w, /img/1600.webp 1600w",
      sizes: "50vw",
      width: 1600,
      height: 1200,
    })
  })

  it("draws the image at the full viewport width unless sizes are given", () => {
    assertEquals(responsiveImage([variant("image/webp", 480)]).sizes, "100vw")
  })

  it("throws for no variants, a bad size, a URL a srcset cannot carry or a repeated width", () => {
    assertThrows(() => responsiveImage([]), Error, "at least one")
    assertThrows(() => responsiveImage([{ ...variant("image/webp", 480), height: 0 }]), Error)
    for (const url of ["/a b.webp", ",/a.webp", "/a.webp,", ""]) {
      assertThrows(() => responsiveImage([{ ...variant("image/webp", 480), url }]), Error, "URL")
    }
    assertThrows(
      () => responsiveImage([variant("image/webp", 480), variant("image/webp", 480)]),
      Error,
      "Two image/webp",
    )
  })
})
