/**
 * PATH probing for the external binaries this package shells out to.
 *
 * Extracted from `lyrics-populator/src/metadata.ts:447-465` (`findFfmpeg`),
 * which probed `"ffmpeg"`, `/usr/bin/ffmpeg` and `/usr/local/bin/ffmpeg` and
 * cached the first that answered `-version`.
 *
 * The lookup itself is injected here. The source read the process's real
 * `PATH` through `Deno.Command`, so its behaviour could only be asserted on a
 * machine that had ffmpeg — which CI does not. With the environment and the
 * process port injected, a test asserts a hit, a miss and the cache without a
 * binary in sight.
 *
 * A `PATH` entry is not a promise: the file may be missing, not executable, or
 * a different architecture. Every candidate is therefore probed by running it
 * with `-version` and checking the exit status, rather than by `stat`.
 */

import { FFMPEG_BINARY, type ProcessRunner } from "./process-runner.ts"

/** Reads environment variables. `Deno.env` in production. */
export interface EnvironmentReader {
  get(name: string): string | undefined
}

/** Wiring for a probe. */
export interface BinaryFinderDeps {
  runner: ProcessRunner
  /** Environment source. Defaults to `Deno.env`. */
  env?: EnvironmentReader
  /** Platform whose `PATH` separator and executable suffix to use. Defaults to `Deno.build.os`. */
  platform?: string
  /** Arguments that make a candidate answer with an exit status. Defaults to `["-version"]`. */
  probeArgs?: readonly string[]
  /** Absolute candidates to try after `PATH`, in order. */
  extraCandidates?: readonly string[]
}

/** A caching PATH probe for one or more binary names. */
export interface BinaryFinder {
  /**
   * Resolves `name` to a path that ran successfully, remembering the answer.
   *
   * @throws {Error} when no candidate answers; the message lists every path
   * that was probed, so an operator can see what the process actually saw.
   */
  find(name: string): Promise<string>
  /** The cached path for `name`, if it was resolved already. */
  cachedPath(name: string): string | undefined
  /** How many candidates were executed. A cache hit must not increase it. */
  readonly probeCount: number
}

/** Candidates the source appended after `PATH`. */
export const FFMPEG_EXTRA_CANDIDATES = ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"] as const

function isWindows(platform: string): boolean {
  return platform.startsWith("win")
}

function pathSeparator(platform: string): string {
  return isWindows(platform) ? ";" : ":"
}

/**
 * Joins a directory and a file name with the separator of `platform`.
 *
 * Hand-rolled rather than `@std/path`'s `join`, which is POSIX-only: a Windows
 * `PATH` (`C:\bin;D:\bin`) needs `\`, and importing `@std/path/windows` would
 * add an import-map entry for a case no test on this machine can exercise.
 */
function joinCandidate(directory: string, fileName: string, platform: string): string {
  const separator = isWindows(platform) ? "\\" : "/"
  return directory.endsWith(separator)
    ? `${directory}${fileName}`
    : `${directory}${separator}${fileName}`
}

function candidateNames(name: string, platform: string): string[] {
  // On Windows the name on disk carries a suffix; `PATH` itself does not say
  // which one, and PATHEXT is not modelled here.
  return isWindows(platform) ? [name, `${name}.exe`] : [name]
}

/**
 * Creates a finder.
 *
 * Candidate order: `PATH` entries in order, then `extraCandidates`, then the
 * bare name as a last resort for a process whose environment cannot be read.
 * Duplicates are dropped, so the common overlap between `PATH` and the extra
 * candidates costs one probe, not two.
 */
export function createBinaryFinder(deps: BinaryFinderDeps): BinaryFinder {
  const cache = new Map<string, string>()
  const probeArgs = deps.probeArgs ?? ["-version"]
  let probes = 0

  const candidatesFor = (name: string): string[] => {
    const platform = deps.platform ?? Deno.build.os
    const names = candidateNames(name, platform)
    const pathValue = (deps.env ?? Deno.env).get("PATH") ?? ""
    const directories = pathValue
      .split(pathSeparator(platform))
      .map((directory) => directory.trim())
      .filter((directory) => directory.length > 0)
    const candidates = [
      ...directories.flatMap((directory) =>
        names.map((fileName) => joinCandidate(directory, fileName, platform))
      ),
      ...deps.extraCandidates ?? [],
      ...names,
    ]
    return [...new Set(candidates)]
  }

  return {
    async find(name: string): Promise<string> {
      const cached = cache.get(name)
      if (cached !== undefined) {
        return cached
      }
      const candidates = candidatesFor(name)
      for (const candidate of candidates) {
        probes += 1
        let success = false
        try {
          success = (await deps.runner.run([candidate, ...probeArgs])).success
        } catch {
          // A spawn failure (ENOENT, EACCES, a directory in PATH) is a miss.
          success = false
        }
        if (success) {
          cache.set(name, candidate)
          return candidate
        }
      }
      throw new Error(
        `${name} not found: probed ${candidates.length} candidate(s) and none answered ${
          probeArgs.join(" ")
        } — ${candidates.join(", ")}`,
      )
    },
    cachedPath(name: string): string | undefined {
      return cache.get(name)
    },
    get probeCount(): number {
      return probes
    },
  }
}

/**
 * Locates ffmpeg once and caches it.
 *
 * Returns a locator rather than a single promise, because the cache lives with
 * the locator: a long-lived process creates one at start-up and every later
 * call is a map lookup, while a test gets a fresh cache per locator instead of
 * module-level state it cannot reset.
 *
 * The library bundles no binaries. If ffmpeg is absent, this is where a caller
 * finds out — see `README.md` for the contract.
 */
export function findFfmpeg(deps: BinaryFinderDeps): () => Promise<string> {
  const finder = createBinaryFinder({
    extraCandidates: FFMPEG_EXTRA_CANDIDATES,
    ...deps,
  })
  return () => finder.find(FFMPEG_BINARY)
}
