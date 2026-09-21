/**
 * A throw-away folder on a real filesystem, for the rare integration test that needs
 * one instead of a fake (#73).
 *
 * `Deno.makeTempDir()` stays refused in the integration tier: it writes outside
 * `.volumes`, and the tier's `--allow-write` grant covers only `.volumes`. This module
 * is the one way in, so every folder a test creates lands where the grant allows and
 * where `.gitignore` and `deno.jsonc`'s `exclude` already keep it out of git and out
 * of `deno task ts:check`.
 *
 * Every call is unique, the same way `uniqueIdentifier` is: several worktrees run this
 * tier against the same machine at the same time, and two runs must never share a
 * folder or race to remove one the other still owns.
 */

import { resolve } from "@std/path"
import { uniqueIdentifier } from "./isolation.ts"

const SCRATCH_ROOT = ".volumes/it"

/**
 * Create `.volumes/it/<prefix>_<suffix>` with its parents and return its absolute
 * path. `prefix` follows the same rule as `uniqueIdentifier`: lowercase letters,
 * digits and underscores, starting with a letter.
 */
export async function createScratchFolder(prefix: string): Promise<string> {
  const path = resolve(SCRATCH_ROOT, uniqueIdentifier(prefix))
  await Deno.mkdir(path, { recursive: true })
  return path
}

/** Remove a folder `createScratchFolder` returned, and everything under it. */
export async function removeScratchFolder(path: string): Promise<void> {
  await Deno.remove(path, { recursive: true })
}
