import { assert, assertEquals } from "@std/assert"
import { payeeKey } from "./payee.ts"

Deno.test("payeeKey gives one key for one shop across card numbers and references", () => {
  const keys = [
    "CARD 4111********1111 COFFEE BAR  REF 99812345",
    "card 4111********2222 Coffee Bar ref 11223344",
    "Card 4111 xxxx xxxx 1111 Coffee Bar ref: 55512345",
    "****1234 COFFEE BAR #77788899",
    "4111-1111-1111-1111 coffee bar No 123456",
  ].map(payeeKey)
  assertEquals(keys, Array(keys.length).fill("coffee bar"))
})

Deno.test("payeeKey removes numbers glued to words and the labels before them", () => {
  assertEquals(payeeKey("ref:99812345 Coffee Bar"), "coffee bar")
  assertEquals(payeeKey("Coffee Bar card:4111XXXX1111"), "coffee bar")
  assertEquals(payeeKey("Coffee Bar txn123456789"), "coffee bar txn")
  assertEquals(payeeKey("Coffee Bar 99812345/"), "coffee bar")
})

Deno.test("payeeKey keeps short numbers that are part of a name", () => {
  assertEquals(payeeKey("7-Eleven 4111********1111"), "7-eleven")
  assertEquals(payeeKey("Shop 24"), "shop 24")
  assertEquals(payeeKey("Xbox360 Store"), "xbox360 store")
  assertEquals(payeeKey("Max123456 Store"), "max store")
})

Deno.test("payeeKey keeps label words that label no removed number", () => {
  assertEquals(payeeKey("Card Factory"), "card factory")
  assertEquals(payeeKey("No Frills 12345678"), "no frills")
})

Deno.test("payeeKey keeps a word of x alone, which masks nothing", () => {
  assertEquals(payeeKey("XXXXXX Club"), "xxxxxx club")
})

Deno.test("payeeKey lower-cases Cyrillic and Latin payees", () => {
  assertEquals(payeeKey("ПЯТЁРОЧКА Магазин"), "пятёрочка магазин")
  assertEquals(payeeKey("ΑΒΓ Shop"), "αβγ shop")
})

Deno.test("payeeKey gives an empty key when only numbers and labels are left", () => {
  assertEquals(payeeKey("99812345"), "")
  assertEquals(payeeKey("CARD 4111 xxxx xxxx 1111 REF 99812345"), "")
  assertEquals(payeeKey("   "), "")
  assertEquals(payeeKey(""), "")
})

Deno.test("payeeKey gives full-width and extra whitespace variants the same key", () => {
  const plain = payeeKey("Coffee Bar 7")
  assertEquals(plain, "coffee bar 7")
  assertEquals(payeeKey("  Coffee\t\tBar\n 7 "), plain)
  assertEquals(payeeKey("Ｃｏｆｆｅｅ　Ｂａｒ ７"), plain)
  assertEquals(payeeKey("Coffee Bar ４１１１＊＊＊＊１１１１"), "coffee bar")
})

Deno.test("payeeKey reads a 1 MB payee in well under a second", () => {
  // The shapes that cost most: one long word of number characters with no break, one long word
  // that alternates number runs with letters, long lists of short number words and of labels.
  const inputs = [
    "1".repeat(1_000_000),
    "1 ".repeat(500_000),
    "x-".repeat(500_000),
    "a1x-".repeat(250_000),
    "ref 1 ".repeat(166_666),
    "#".repeat(1_000_000),
    // A long word that is no label, then many numbers removed behind it.
    "#".repeat(150_000) + "a" + "#".repeat(150_000) + " " + "123456/".repeat(100_000),
  ]
  for (const input of inputs) {
    const start = performance.now()
    payeeKey(input)
    const elapsed = performance.now() - start
    assert(elapsed < 1_000, `${input.slice(0, 8)}… took ${elapsed} ms`)
  }
})
