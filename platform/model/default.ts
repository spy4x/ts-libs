/**
 * The type arktype gives a key with a default (`"number | null = null"`), rebuilt from arktype's
 * public API. Importing it from `arktype/internal/attributes.ts` worked, but an internal path can
 * move in any arktype release; deriving its key from a schema made with the public `type` keeps
 * this module on the public surface, and a change to the shape fails `deno check` here instead of
 * slipping through. Not exported from the package.
 *
 * @module
 */
import { type } from "arktype"

const defaultedSample = type({ value: "null = null" })

/** The marker key arktype puts on a defaulted property's type. */
type DefaultMarker = keyof (typeof defaultedSample.t)["value"]

/** A value of type `T` whose key defaults to `V` when it is absent; arktype's own `Default`. */
export type Default<T = unknown, V = unknown> = { [K in DefaultMarker]: [T, V] }
