/**
 * What a browser bundle of `universal/money-core` and `universal/color-core` carries (#863).
 *
 * arktype's own module code runs when it loads and the package does not declare
 * `sideEffects: false`, so any import of it keeps about 150 KB in a bundle, used or not. The core
 * subpaths exist so browser code can format money or pick a text colour without that cost. Each
 * entry in `testdata/` is bundled the way an app's build bundles an island, with
 * `deno bundle --platform browser --minify`, as preact-components' bundle-size check does.
 *
 * Runs on its own with `--allow-run=deno` (the `test` task in `deno.jsonc`).
 *
 * @module
 */

import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

/** arktype's Standard Schema vendor name: in every bundle that carries arktype's `Type` class. */
const ARKTYPE_MARKER = `"arktype"`

// The assertions compare booleans and lengths, never the bundle itself: a failure that printed a
// 150 KB bundle would bury its own message.

/**
 * Bundles one entry from `testdata/` for the browser, minified.
 *
 * @returns The bundle's text.
 * @throws When `deno bundle` fails, with its error output.
 */
async function bundle(entry: string): Promise<string> {
  const path = new URL(`./testdata/${entry}`, import.meta.url).pathname
  const { success, stdout, stderr } = await new Deno.Command(`deno`, {
    args: [`bundle`, `--platform`, `browser`, `--minify`, path],
    stdout: `piped`,
    stderr: `piped`,
  }).output()
  if (!success) {
    throw new Error(`deno bundle ${entry} failed:\n${new TextDecoder().decode(stderr)}`)
  }
  return new TextDecoder().decode(stdout)
}

describe(`a browser bundle of the money and colour helpers`, () => {
  it(`carries arktype when it imports universal/money, so the marker is real`, async () => {
    expect((await bundle(`island-money.ts`)).includes(ARKTYPE_MARKER)).toBe(true)
  })

  it(`carries arktype when it imports universal/color, so the marker is real`, async () => {
    expect((await bundle(`island-color.ts`)).includes(ARKTYPE_MARKER)).toBe(true)
  })

  it(`carries no arktype and stays under 4 KB when it imports universal/money-core`, async () => {
    const code = await bundle(`island-money-core.ts`)
    expect(code.includes(ARKTYPE_MARKER)).toBe(false)
    // 2.5 KB today: `formatMoney`, `isCurrencyCode` and the ISO 4217 table.
    expect(code.length).toBeLessThan(4_000)
  })

  it(`carries no arktype and stays under 1 KB when it imports universal/color-core`, async () => {
    const code = await bundle(`island-color-core.ts`)
    expect(code.includes(ARKTYPE_MARKER)).toBe(false)
    // 0.5 KB today: `isHexColor`, `readableTextColor` and the luminance maths.
    expect(code.length).toBeLessThan(1_000)
  })
})
