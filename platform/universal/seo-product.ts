/**
 * schema.org `Product` and `ProductGroup` JSON-LD, with an exact price. Public through `./seo.ts`.
 *
 * @module
 */

import { currencyDecimals, moneyDecimalString } from "./money.ts"
import { canonicalUrl, webUrl } from "./seo-canonical.ts"
import { type JsonLdPerson, type JsonLdPersonNode, nodeId, personNode } from "./seo-json-ld.ts"

/** One variant of a product, such as one colour in one size, selectable on the product's page. */
export interface ProductVariant {
  /** The variant's own stock-keeping unit. Google needs a unique id for every variant. */
  sku: string
  /**
   * Absolute or page-relative address that opens the page with this variant selected, such as
   * `?color=red&size=m`. Google crawls it to see the variant's own price and stock.
   */
  url: string
  color?: string
  size?: string
  /** Defaults to the product's images. */
  images?: readonly string[]
  /** Defaults to the product's `inStock`. */
  inStock?: boolean
}

/** What {@link productJsonLd} describes: one item page, with or without variants. */
export interface ProductPage {
  /** Canonical absolute address of the item's page. */
  url: string
  name: string
  description?: string
  /** Absolute or page-relative addresses of the item's photos. Google requires at least one. */
  images: readonly string[]
  /** The item's stock-keeping unit. Required with variants: it is the group's `productGroupID`. */
  sku?: string
  brand?: string
  /** The item's category as the shop names it, such as `Clothing > Shirts`. */
  category?: string
  /**
   * Price as a whole number in the currency's smallest unit: `250000` in `VND` is 250,000 ₫ and
   * `1999` in `USD` is $19.99.
   */
  price: number
  /** ISO 4217 code, such as `VND` or `USD`. */
  currency: string
  inStock: boolean
  /** Who sells the item: an `@id` reference to a node the page already has, or a full node. */
  seller?: { id: string } | JsonLdPerson
  /**
   * Every variant the page lets a buyer choose, sold-out ones included. Each is named after the
   * product, its colour and its size, such as `Linen shirt (Red, M)`, and costs the product's price.
   */
  variants?: readonly ProductVariant[]
}

/** A schema.org `Offer` for one item, new, sold by the page's shop. */
export interface OfferJsonLd {
  "@type": "Offer"
  url: string
  price: number
  priceCurrency: string
  availability: "https://schema.org/InStock" | "https://schema.org/OutOfStock"
  itemCondition: "https://schema.org/NewCondition"
  seller?: JsonLdPersonNode
}

/** A schema.org `Product` node: an item with no variants, or one variant of a group. */
export interface ProductJsonLd {
  "@type": "Product"
  "@id"?: string
  name: string
  description?: string
  image: string[]
  sku?: string
  brand?: { "@type": "Brand"; name: string }
  category?: string
  color?: string
  size?: string
  offers: OfferJsonLd
}

/** A schema.org `ProductGroup` node: an item whose page offers several variants. */
export interface ProductGroupJsonLd {
  "@type": "ProductGroup"
  "@id": string
  name: string
  description?: string
  url: string
  productGroupID: string
  brand?: { "@type": "Brand"; name: string }
  category?: string
  variesBy?: string[]
  hasVariant: ProductJsonLd[]
}

/**
 * A price in the currency's smallest unit as the number schema.org's `price` holds, exact.
 *
 * The decimal text comes from integer arithmetic ({@link moneyDecimalString}), never from a
 * division. `JSON.stringify` prints a number as the shortest text that reads back to it, so an
 * amount too large for a `double` to print as its own decimal text is refused, not rounded.
 */
function offerPrice(amount: number, currency: string, label: string): number {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(
      `${label} must be a whole, non-negative number of the currency's smallest unit, received: ${amount}`,
    )
  }
  const text = moneyDecimalString(amount, currencyDecimals(currency))
  const price = Number(text)
  if (String(price) !== (text.includes(".") ? text.replace(/\.?0+$/, "") : text)) {
    throw new Error(`${label} ${text} ${currency} cannot be written exactly as a JSON number`)
  }
  return price
}

/**
 * The schema.org node Google reads for an item page: a `Product` for an item with no variants, or
 * a `ProductGroup` whose `hasVariant` lists one `Product` per variant.
 *
 * The variant shape is the single-page one Google recommends when one page lets a buyer choose
 * every variant (https://developers.google.com/search/docs/appearance/structured-data/product-variants):
 * the group carries the shared fields and `variesBy`, and each variant its own `sku`, colour, size,
 * images and offer, whose `url` preselects it. Sold-out variants stay listed, as `OutOfStock`.
 * `variesBy` names `color` and `size` when any variant sets them, and is left out when none does.
 * The group's `productGroupID` is the product's `sku`, which Google requires for a group.
 *
 * Every offer is new (`NewCondition`) and priced exactly in the currency's own decimals — none
 * for `VND`, two for `USD` — from a whole number in its smallest unit. Like the other nodes here it
 * carries no `@context`; print it with {@link jsonLdText}. Its `@id` is the canonical address plus
 * `#product`.
 *
 * @throws When an address is not an `http`/`https` URL, there is no image, a price is not a
 *   whole, non-negative number, or variants are given without a `sku`.
 */
export function productJsonLd(page: ProductPage): ProductJsonLd | ProductGroupJsonLd {
  const canonical = canonicalUrl(page.url).href
  const base = new URL(canonical)
  const currency = page.currency.toUpperCase()
  const brand = page.brand === undefined
    ? undefined
    : { "@type": "Brand" as const, name: page.brand }

  let seller: JsonLdPersonNode | undefined
  if (page.seller !== undefined) {
    seller = "name" in page.seller
      ? personNode(page.seller, "Organization", "seller")
      : { "@id": nodeId(page.seller.id, "seller id") }
  }

  const images = (list: readonly string[]): string[] => {
    if (list.length === 0) throw new Error(`product needs at least one image: ${canonical}`)
    return list.map((image) => webUrl(image, "product image", base).href)
  }

  const offer = (url: string, price: number, inStock: boolean): OfferJsonLd => ({
    "@type": "Offer",
    url,
    price: offerPrice(price, currency, "product price"),
    priceCurrency: currency,
    availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    itemCondition: "https://schema.org/NewCondition",
    ...(seller === undefined ? {} : { seller }),
  })

  const shared = {
    ...(page.description === undefined ? {} : { description: page.description }),
    ...(brand === undefined ? {} : { brand }),
    ...(page.category === undefined ? {} : { category: page.category }),
  }

  if (page.variants === undefined || page.variants.length === 0) {
    return {
      "@type": "Product",
      "@id": `${canonical}#product`,
      name: page.name,
      ...shared,
      image: images(page.images),
      ...(page.sku === undefined ? {} : { sku: page.sku }),
      offers: offer(canonical, page.price, page.inStock),
    }
  }

  const variants = page.variants
  if (page.sku === undefined || page.sku.trim() === "") {
    throw new Error(`product with variants needs a sku for its productGroupID: ${canonical}`)
  }
  const variesBy = (["color", "size"] as const)
    .filter((key) => variants.some((variant) => variant[key] !== undefined))
    .map((key) => `https://schema.org/${key}`)

  return {
    "@type": "ProductGroup",
    "@id": `${canonical}#product`,
    name: page.name,
    ...shared,
    url: canonical,
    productGroupID: page.sku,
    ...(variesBy.length === 0 ? {} : { variesBy }),
    hasVariant: variants.map((variant) => {
      const traits = [variant.color, variant.size].filter((trait) => trait !== undefined)
      return {
        "@type": "Product",
        name: traits.length === 0 ? page.name : `${page.name} (${traits.join(", ")})`,
        image: images(variant.images ?? page.images),
        sku: variant.sku,
        ...(variant.color === undefined ? {} : { color: variant.color }),
        ...(variant.size === undefined ? {} : { size: variant.size }),
        offers: offer(
          webUrl(variant.url, "variant url", base).href,
          page.price,
          variant.inStock ?? page.inStock,
        ),
      }
    }),
  }
}
