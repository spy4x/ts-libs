/**
 * The directory step of a storage write, with the directory maker injected so the unit tier can
 * drive it without `--allow-write`. Private: not in the package's exports map, and nothing here is
 * re-exported from `./index.ts`. The public `ensureFileDirectory` in `./fs.ts` calls
 * `ensureDirectoryWith` with the real maker.
 *
 * @module
 */

/**
 * Directory that must exist before writing `filePath`, or `undefined` when
 * nothing has to be created.
 *
 * **This is not a sanitiser.** A `..` segment is preserved as given
 * (`"../../evil/x.png"` → `"../../evil"`), and so is a percent-encoded one,
 * because resolving an object key is `paths.ts`'s job: every bucket and key that
 * reaches here has already been validated to be relative and `..`-free, so the
 * only paths this sees are ones a caller produced. A caller that feeds it an
 * unvalidated string gets an unvalidated path — that is the documented contract,
 * not an oversight.
 *
 * Pure, and exported for testing, because the naive form
 * `filePath.slice(0, filePath.lastIndexOf("/"))` is wrong for a bare filename:
 * `lastIndexOf` returns `-1` and `slice(0, -1)` silently drops the last
 * character, so `"out.png"` produced the stray directory `out.pn`. Callers must
 * treat `undefined` as "no directory to create" and never mkdir it.
 */
export function parentDirectory(filePath: string): string | undefined {
  if (filePath === "") return undefined
  const normalized = filePath.replaceAll("\\", "/")
  const cut = normalized.lastIndexOf("/")
  if (cut < 0) return undefined
  const leading = normalized.startsWith("/")
  const parts = normalized
    .slice(leading ? 1 : 0, cut)
    .split("/")
    .filter((part) => part !== "" && part !== ".")
  if (parts.length === 0) return leading ? "/" : undefined
  const parent = parts.join("/")
  return leading ? `/${parent}` : parent
}

/** Creates a directory and every missing parent. */
export type MakeDirectory = (path: string) => Promise<void>

/** The real `MakeDirectory`: `Deno.mkdir` with `recursive`, which needs `--allow-write`. */
export function makeDirectoryRecursive(path: string): Promise<void> {
  return Deno.mkdir(path, { recursive: true })
}

/**
 * Create the directory holding `filePath` through `makeDirectory`, with every missing parent.
 *
 * Only `AlreadyExists` is swallowed: a file already sits where the directory should be, and the
 * write that follows fails with the precise error (`NotADirectory`). Any other failure, such as a
 * denied permission or a full disk, is thrown, so the caller sees the real cause instead of a
 * later `NotFound` from opening a file in a directory that was never made.
 */
export async function ensureDirectoryWith(
  filePath: string,
  makeDirectory: MakeDirectory,
): Promise<void> {
  const parent = parentDirectory(filePath)
  if (parent === undefined) return
  try {
    await makeDirectory(parent)
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error
  }
}
