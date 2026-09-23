/**
 * Where the integration tier's dependencies live, and the check every integration
 * test runs before it touches one.
 *
 * This module lives in `infra/` rather than in a package because it is repository
 * tooling: `infra/` is deliberately not a workspace member, so nothing here can be
 * published to JSR by accident or imported by a consumer of `@spy4x/*`.
 *
 * Every address has a default that matches `infra/compose.integration.yml`, and an
 * environment variable that overrides it. CI sets the variables to the Woodpecker
 * service host names; a developer sets none of them.
 */

/** Environment variables that point the integration tier at its dependencies. */
export enum IntegrationEnvName {
  PostgresUrl = "TS_LIBS_IT_POSTGRES_URL",
  S3Endpoint = "TS_LIBS_IT_S3_ENDPOINT",
  S3AccessKeyId = "TS_LIBS_IT_S3_ACCESS_KEY_ID",
  S3SecretAccessKey = "TS_LIBS_IT_S3_SECRET_ACCESS_KEY",
  S3Bucket = "TS_LIBS_IT_S3_BUCKET",
  S3Region = "TS_LIBS_IT_S3_REGION",
  SmtpHost = "TS_LIBS_IT_SMTP_HOST",
  SmtpPort = "TS_LIBS_IT_SMTP_PORT",
  MailpitUrl = "TS_LIBS_IT_MAILPIT_URL",
  RedisHost = "TS_LIBS_IT_REDIS_HOST",
  RedisPort = "TS_LIBS_IT_REDIS_PORT",
}

/**
 * The credentials every container in `infra/compose.integration.yml` that takes one
 * is started with (Redis takes none). Deliberately one obviously fake literal: these
 * containers are throw-away, listen on the loopback interface only, and hold nothing
 * worth reading.
 */
export const THROWAWAY_CREDENTIAL = "integration-test-only"

/** Defaults for a developer running `deno task services:up` on their own machine. */
export const LOCAL_DEFAULTS = {
  postgresUrl:
    `postgres://${THROWAWAY_CREDENTIAL}:${THROWAWAY_CREDENTIAL}@127.0.0.1:55432/${THROWAWAY_CREDENTIAL}`,
  s3Endpoint: "http://127.0.0.1:59000",
  s3Bucket: "ts-libs-integration",
  s3Region: "us-east-1",
  smtpHost: "127.0.0.1",
  smtpPort: 51025,
  mailpitUrl: "http://127.0.0.1:58025",
  redisHost: "127.0.0.1",
  redisPort: 56379,
} as const

/** One TCP endpoint, named well enough for a failure message to be actionable. */
export interface ServiceAddress {
  /** Name a person recognises, e.g. `Postgres`. */
  service: string
  hostname: string
  port: number
  /** The environment variable that moves this service somewhere else. */
  envName: IntegrationEnvName
}

/** Connection fields for `createSql` from `@spy4x/server/db`, plus the address to probe. */
export interface PostgresSettings {
  connection: {
    host: string
    port: number
    user: string
    password: string
    database: string
  }
  address: ServiceAddress
}

/** Everything `S3Storage` needs for the MinIO container, plus the address to probe. */
export interface S3Settings {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  address: ServiceAddress
}

/** Everything `createSmtpSender` needs for the Mailpit container, plus the address. */
export interface SmtpSettings {
  host: string
  port: number
  user: string
  pass: string
  address: ServiceAddress
}

/** Mailpit's HTTP API — how a test reads back the mail it sent. */
export interface MailpitSettings {
  /** Origin with no trailing slash, e.g. `http://127.0.0.1:58025`. */
  baseUrl: string
  address: ServiceAddress
}

/** Connection fields for the Redis container, plus the address to probe. */
export interface RedisSettings {
  hostname: string
  port: number
  address: ServiceAddress
}

function readEnv(name: IntegrationEnvName): string | undefined {
  const value = Deno.env.get(name)
  return value === undefined || value.trim() === "" ? undefined : value.trim()
}

/**
 * Read a port from the environment, rejecting anything that is not a port.
 *
 * `Number("")` is `0` and `Number("nope")` is `NaN`; handing either to
 * `Deno.connect` produces a failure that names neither the variable nor the value.
 */
function readPort(name: IntegrationEnvName, fallback: number): number {
  const raw = readEnv(name)
  if (raw === undefined) return fallback
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`${name} must be a port between 1 and 65535, got ${JSON.stringify(raw)}`)
  }
  return port
}

/**
 * Postgres connection settings, parsed from {@link IntegrationEnvName.PostgresUrl}.
 *
 * The URL form is what every Postgres tool already accepts, so CI and a developer
 * override one variable instead of five. A URL without a host, a user or a database
 * name throws here rather than producing a client that connects nowhere.
 */
export function postgresSettings(): PostgresSettings {
  const raw = readEnv(IntegrationEnvName.PostgresUrl) ?? LOCAL_DEFAULTS.postgresUrl
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new TypeError(
      `${IntegrationEnvName.PostgresUrl} must be a postgres:// URL, got ${JSON.stringify(raw)}`,
    )
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  if (url.hostname === "" || url.username === "" || database === "") {
    throw new TypeError(
      `${IntegrationEnvName.PostgresUrl} needs a host, a user and a database name`,
    )
  }
  const port = url.port === "" ? 5432 : Number(url.port)

  return {
    connection: {
      host: url.hostname,
      port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database,
    },
    address: {
      service: "Postgres",
      hostname: url.hostname,
      port,
      envName: IntegrationEnvName.PostgresUrl,
    },
  }
}

/** S3 settings for the MinIO container. Path-style addressing is the caller's job. */
export function s3Settings(): S3Settings {
  const endpoint = readEnv(IntegrationEnvName.S3Endpoint) ?? LOCAL_DEFAULTS.s3Endpoint
  const url = new URL(endpoint)

  return {
    endpoint: url.origin,
    region: readEnv(IntegrationEnvName.S3Region) ?? LOCAL_DEFAULTS.s3Region,
    accessKeyId: readEnv(IntegrationEnvName.S3AccessKeyId) ?? THROWAWAY_CREDENTIAL,
    secretAccessKey: readEnv(IntegrationEnvName.S3SecretAccessKey) ?? THROWAWAY_CREDENTIAL,
    bucket: readEnv(IntegrationEnvName.S3Bucket) ?? LOCAL_DEFAULTS.s3Bucket,
    address: {
      service: "MinIO (S3)",
      hostname: url.hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
      envName: IntegrationEnvName.S3Endpoint,
    },
  }
}

/**
 * SMTP settings for the Mailpit container.
 *
 * Mailpit is started with `MP_SMTP_AUTH_ACCEPT_ANY`, so any user and password are
 * accepted and the adapter's real AUTH exchange runs. It serves no STARTTLS without
 * a certificate, so a sender built from these settings must pass `requireTls: false`.
 */
export function smtpSettings(): SmtpSettings {
  const host = readEnv(IntegrationEnvName.SmtpHost) ?? LOCAL_DEFAULTS.smtpHost
  const port = readPort(IntegrationEnvName.SmtpPort, LOCAL_DEFAULTS.smtpPort)

  return {
    host,
    port,
    user: THROWAWAY_CREDENTIAL,
    pass: THROWAWAY_CREDENTIAL,
    address: {
      service: "Mailpit (SMTP)",
      hostname: host,
      port,
      envName: IntegrationEnvName.SmtpHost,
    },
  }
}

/** Mailpit's HTTP API, used to read back and delete the mail a test sent. */
export function mailpitSettings(): MailpitSettings {
  const url = new URL(readEnv(IntegrationEnvName.MailpitUrl) ?? LOCAL_DEFAULTS.mailpitUrl)

  return {
    baseUrl: url.origin,
    address: {
      service: "Mailpit (HTTP API)",
      hostname: url.hostname,
      port: url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port),
      envName: IntegrationEnvName.MailpitUrl,
    },
  }
}

/**
 * Redis connection settings, host and port only: the container takes no `requirepass`
 * (see `infra/compose.integration.yml`), so there is no credential to carry.
 */
export function redisSettings(): RedisSettings {
  const hostname = readEnv(IntegrationEnvName.RedisHost) ?? LOCAL_DEFAULTS.redisHost
  const port = readPort(IntegrationEnvName.RedisPort, LOCAL_DEFAULTS.redisPort)

  return {
    hostname,
    port,
    address: {
      service: "Redis",
      hostname,
      port,
      envName: IntegrationEnvName.RedisHost,
    },
  }
}

/**
 * Fail the test unless the service accepts a TCP connection.
 *
 * Call this first in every integration test. An integration test never skips: a
 * missing container is a failure with an address and the command that fixes it, not
 * a silent pass that makes the tier look green while it tested nothing.
 */
export async function requireReachable(address: ServiceAddress): Promise<void> {
  let connection: Deno.TcpConn
  try {
    connection = await Deno.connect({ hostname: address.hostname, port: address.port })
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `${address.service} is not reachable at ${address.hostname}:${address.port} (${reason}). ` +
        `Start the integration services with \`deno task services:up\`, or point this test ` +
        `somewhere else with ${address.envName}.`,
      { cause },
    )
  }
  connection.close()
}
