import { StorageError } from "./errors.ts"
import { MAX_PRESIGN_EXPIRES_IN_SECONDS } from "./sigv4.ts"

/** Environment variable names this package reads. All optional except the S3 keys. */
export enum StorageEnvName {
  Provider = "FILE_STORAGE_PROVIDER",
  Bucket = "FILE_STORAGE_BUCKET",
  LocalPath = "FILE_STORAGE_LOCAL_PATH",
  S3Region = "S3_REGION",
  S3Endpoint = "S3_ENDPOINT",
  S3AccessKeyId = "S3_ACCESS_KEY_ID",
  S3SecretAccessKey = "S3_SECRET_ACCESS_KEY",
  S3SessionToken = "S3_SESSION_TOKEN",
  S3ForcePathStyle = "S3_FORCE_PATH_STYLE",
  S3ExpiresIn = "S3_PRESIGN_EXPIRES_IN",
}

/** Fully-resolved storage configuration. No field is read from the environment after this. */
export interface StorageConfig {
  bucket: string
  localPath?: string
  s3?: {
    region: string
    endpoint?: string
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
    forcePathStyle?: boolean
    expiresIn?: number
  }
}

const PROVIDER_NAMES = new Set(["local", "s3"])
const EMPTY_STRING = /^$/
const DECIMAL_INTEGER = /^[0-9]+$/

/**
 * Parse an expiry from either a number or an environment string.
 *
 * Never coerces garbage: `Number("abc")` is `NaN` and `Number("")` is `0`, and
 * both would produce a URL that silently fails to authorise, so anything that is
 * not a plain decimal integer in range is rejected instead.
 */
export function parseExpiresIn(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined
  const text = typeof value === "number" ? String(value) : value
  if (!DECIMAL_INTEGER.test(text)) {
    throw new StorageError(
      "invalid_expiry",
      `${StorageEnvName.S3ExpiresIn} must be a decimal integer, got ${JSON.stringify(value)}`,
    )
  }
  const seconds = Number(text)
  if (seconds < 1 || seconds > MAX_PRESIGN_EXPIRES_IN_SECONDS) {
    throw new StorageError(
      "invalid_expiry",
      `${StorageEnvName.S3ExpiresIn} must be between 1 and ${MAX_PRESIGN_EXPIRES_IN_SECONDS}, got ${value}`,
    )
  }
  return seconds
}

/**
 * Parse storage configuration from an explicit environment record.
 *
 * Takes the record as an argument rather than reading `Deno.env` at module
 * scope: the module then has no import-time environment dependency, a test can
 * drive every branch with a literal object and no env manipulation, and the
 * only place that reads real environment variables is `createStorage()`.
 *
 * Returns `undefined` when `FILE_STORAGE_PROVIDER` is unset or empty — an
 * unconfigured deployment gets no storage rather than a half-configured one.
 */
export function parseStorageEnv(
  environment: Record<string, string | undefined>,
): StorageConfig | undefined {
  const provider = environment[StorageEnvName.Provider]
  if (provider === undefined || EMPTY_STRING.test(provider)) return undefined
  if (!PROVIDER_NAMES.has(provider)) {
    throw new StorageError(
      "invalid_config",
      `${StorageEnvName.Provider} must be one of ${[...PROVIDER_NAMES].join(", ")}, got ${
        JSON.stringify(provider)
      }`,
    )
  }

  const bucket = environment[StorageEnvName.Bucket]
  if (bucket === undefined || EMPTY_STRING.test(bucket)) {
    throw new StorageError("invalid_config", `${StorageEnvName.Bucket} is required`)
  }

  if (provider === "local") {
    const localPath = environment[StorageEnvName.LocalPath]
    return localPath === undefined || EMPTY_STRING.test(localPath)
      ? { bucket }
      : { bucket, localPath }
  }

  const region = environment[StorageEnvName.S3Region]
  if (region === undefined || EMPTY_STRING.test(region)) {
    throw new StorageError(
      "invalid_config",
      `${StorageEnvName.S3Region} is required for the s3 provider`,
    )
  }
  for (const name of [StorageEnvName.S3AccessKeyId, StorageEnvName.S3SecretAccessKey]) {
    const value = environment[name]
    if (value === undefined || EMPTY_STRING.test(value)) {
      throw new StorageError("invalid_config", `${name} is required for the s3 provider`)
    }
  }

  const expiresIn = parseExpiresIn(environment[StorageEnvName.S3ExpiresIn])
  const forcePathStyle = parseBoolean(
    StorageEnvName.S3ForcePathStyle,
    environment[StorageEnvName.S3ForcePathStyle],
  )
  const endpoint = environment[StorageEnvName.S3Endpoint]
  const sessionToken = environment[StorageEnvName.S3SessionToken]

  return {
    bucket,
    s3: {
      region,
      accessKeyId: environment[StorageEnvName.S3AccessKeyId] as string,
      secretAccessKey: environment[StorageEnvName.S3SecretAccessKey] as string,
      ...(endpoint !== undefined && !EMPTY_STRING.test(endpoint) ? { endpoint } : {}),
      ...(sessionToken !== undefined && !EMPTY_STRING.test(sessionToken) ? { sessionToken } : {}),
      ...(forcePathStyle !== undefined ? { forcePathStyle } : {}),
      ...(expiresIn !== undefined ? { expiresIn } : {}),
    },
  }
}

/** Parse `"1"`/`"true"`/`"0"`/`"false"`. Anything else is a configuration error, not a silent default. */
function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || EMPTY_STRING.test(value)) return undefined
  if (value === "1" || value === "true") return true
  if (value === "0" || value === "false") return false
  throw new StorageError(
    "invalid_config",
    `${name} must be true, false, 1 or 0, got ${JSON.stringify(value)}`,
  )
}
