/**
 * Applies `infra/jsr-metadata.json` to every `@spy4x/*` package on JSR through its package API
 * (`PATCH https://api.jsr.io/scopes/spy4x/packages/<package>`, see
 * https://api.jsr.io/.well-known/openapi, schema `UpdatePackageRequest`). That schema is a
 * `oneOf`: a single request body may set only `description`, only `githubRepository` or only
 * `runtimeCompat`, never more than one at a time — so this script sends three PATCH requests per
 * package, one per field.
 *
 * Run with `deno task jsr:metadata -- --dry-run` to print the requests without sending them (no
 * token needed), or `deno task jsr:metadata` to apply them for real, which requires the
 * `JSR_API_TOKEN` environment variable (a JSR personal access token with `package:update` scope
 * for the `spy4x` scope — see README "Maintaining" for where to create one). The token is read
 * once, used only in the `Authorization` header, and never logged or printed.
 */

interface RepositoryConfig {
  owner: string
  name: string
}

interface RuntimeCompat {
  browser?: boolean
  deno?: boolean
  node?: boolean
  workerd?: boolean
  bun?: boolean
}

interface PackageMetadata {
  description: string
  runtimeCompat: RuntimeCompat
}

interface MetadataFile {
  repository: RepositoryConfig
  packages: Record<string, PackageMetadata>
}

export interface PatchRequest {
  method: "PATCH"
  url: string
  body: { description: string } | { githubRepository: RepositoryConfig } | {
    runtimeCompat: RuntimeCompat
  }
}

const API_BASE = "https://api.jsr.io"
const SCOPE = "spy4x"

/** Reads and parses `infra/jsr-metadata.json`, relative to the repo root the script runs from. */
export async function loadMetadata(path: string): Promise<MetadataFile> {
  const text = await Deno.readTextFile(path)
  return JSON.parse(text) as MetadataFile
}

/**
 * Builds the three PATCH requests (description, githubRepository, runtimeCompat) for one
 * package, in the fixed order the report prints them.
 */
export function buildPackageRequests(
  packageName: string,
  metadata: PackageMetadata,
  repository: RepositoryConfig,
): PatchRequest[] {
  const url = `${API_BASE}/scopes/${SCOPE}/packages/${packageName}`
  return [
    { method: "PATCH", url, body: { description: metadata.description } },
    { method: "PATCH", url, body: { githubRepository: repository } },
    { method: "PATCH", url, body: { runtimeCompat: metadata.runtimeCompat } },
  ]
}

/** Builds every PATCH request for every package in the metadata file, in file order. */
export function buildAllRequests(metadata: MetadataFile): PatchRequest[] {
  const requests: PatchRequest[] = []
  for (const [packageName, packageMetadata] of Object.entries(metadata.packages)) {
    requests.push(...buildPackageRequests(packageName, packageMetadata, metadata.repository))
  }
  return requests
}

/** Reads `JSR_API_TOKEN` from the environment, throwing when it is missing or empty. */
export function requireApiToken(): string {
  const token = Deno.env.get("JSR_API_TOKEN")
  if (!token) {
    throw new Error(
      "JSR_API_TOKEN is not set. Create a JSR personal access token for the spy4x scope " +
        "(see README 'Maintaining') and export it before running this task.",
    )
  }
  return token
}

/** Sends one PATCH request with the given bearer token, throwing on a non-OK response. */
export async function sendRequest(request: PatchRequest, token: string): Promise<void> {
  const response = await fetch(request.url, {
    method: request.method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(request.body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`${request.method} ${request.url} -> ${response.status}: ${text}`)
  }
}

function printRequest(request: PatchRequest): void {
  console.log(`${request.method} ${request.url}`)
  console.log(`  ${JSON.stringify(request.body)}`)
}

if (import.meta.main) {
  const dryRun = Deno.args.includes("--dry-run")
  const metadata = await loadMetadata(
    new URL("../jsr-metadata.json", import.meta.url).pathname,
  )
  const requests = buildAllRequests(metadata)

  if (dryRun) {
    console.log(`Dry run: ${requests.length} request(s), nothing sent.\n`)
    for (const request of requests) printRequest(request)
  } else {
    const token = requireApiToken()
    for (const request of requests) {
      printRequest(request)
      await sendRequest(request, token)
    }
    console.log(`\nApplied ${requests.length} request(s).`)
  }
}
