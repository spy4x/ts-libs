/**
 * Security fix 4: `KeyKind.EMAIL_PASSWORD = 0`.
 *
 * `roley/auth/misc/types.ts:18-27` numbered the enum from zero, so the
 * email-password kind was falsy. Every `if (!kind)`-shaped guard in the system
 * therefore treated a real credential as "no credential", and the house rule
 * ("`enum` for finite constants, start at 1") was violated by the very enum the
 * linking model is keyed on.
 *
 * The renumbering is not free: the numeric value is persisted in `keys.kind`, so a
 * stored `0` changes meaning. This package has no production data — it is being
 * extracted — so the stance is no migration, stated in the PR body. These tests pin
 * the two properties that must hold whatever the migration story becomes.
 */

import { assert, assertEquals, assertFalse } from "@std/assert"
import { KeyKind, OAuth2Provider as OAuth2Kind } from "./types.ts"

/** The numeric members of the enum, in declaration order. */
const numericKinds = Object.entries(KeyKind)
  .filter(([name]) => Number.isNaN(Number(name)))
  .map(([name, value]) => [name, value as number] as const)

Deno.test("no KeyKind member is falsy", () => {
  for (const [name, value] of numericKinds) {
    assert(value, `${name} must be truthy, was ${value}`)
  }
})

Deno.test("KeyKind starts at one and is dense", () => {
  const values = numericKinds.map(([, value]) => value)
  assertEquals(Math.min(...values), 1, "the first kind must be 1")
  assertEquals(
    [...values].sort((left, right) => left - right),
    Array.from({ length: values.length }, (_, index) => index + 1),
    "kinds must be 1..n with no gap and no duplicate",
  )
})

Deno.test("EMAIL_PASSWORD is not falsy, so a `!kind` guard cannot misfire", () => {
  // The exact expression the source's guards evaluated.
  assert(!(!KeyKind.EmailPassword), "`!KeyKind.EmailPassword` must be false")
  const guard = (kind: KeyKind): string => (kind ? "has a kind" : "no kind")
  for (const [name, value] of numericKinds) {
    assertEquals(guard(value), "has a kind", `${name} must satisfy a truthiness guard`)
  }
})

Deno.test("OAuth2Provider is a finite enum starting at one", () => {
  const values = Object.entries(OAuth2Kind)
    .filter(([name]) => Number.isNaN(Number(name)))
    .map(([, value]) => value as number)
  assertEquals(Math.min(...values), 1)
  assertEquals(values.length, 2, "Google and Facebook collapse into one provider")
})

Deno.test("every KeyKind member used by a provider is distinguishable", () => {
  // The linking model relies on kind + identification being a unique key, so a
  // duplicated value would make two providers share one credential slot.
  const kinds = [
    KeyKind.EmailPassword,
    KeyKind.EmailPasswordReset,
    KeyKind.OAuth2,
    KeyKind.Anonymous,
    KeyKind.MagicLink,
    KeyKind.Otp,
  ]
  assertEquals(new Set(kinds).size, kinds.length)
  assertFalse(kinds.includes(0 as KeyKind), "zero must not be a member")
})
