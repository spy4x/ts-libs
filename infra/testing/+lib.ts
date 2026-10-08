/**
 * The integration tier's shared harness, imported as `@integration-testing`.
 *
 * Four jobs, and nothing else belongs here:
 *
 * 1. **Addresses.** Where Postgres, MinIO, Mailpit, the two Redis servers, Radicale and
 *    Stalwart are, from one environment variable each, defaulting to
 *    `infra/compose.integration.yml`. `createStalwartUser` adds a per-run Stalwart login.
 * 2. **Failing loudly.** `requireReachable` turns a missing container into a red
 *    test that names the service, the address and the command that starts it.
 * 3. **Isolation.** Unique schema names, key prefixes and recipients, so several
 *    worktrees can run the tier against the same containers at the same time.
 * 4. **A real folder.** `createScratchFolder`/`removeScratchFolder` for the rare test
 *    that needs an actual filesystem, inside the tier's `--allow-write=.volumes` grant.
 *
 * It lives in `infra/` because `infra/` is not a workspace member: nothing here is
 * published to JSR and nothing here is reachable from a `@spy4x/*` entry point.
 */

export {
  type CalDavServerSettings,
  IntegrationEnvName,
  LOCAL_DEFAULTS,
  type MailpitSettings,
  mailpitSettings,
  type PostgresSettings,
  postgresSettings,
  radicaleSettings,
  type RedisAuthSettings,
  redisAuthSettings,
  type RedisSettings,
  redisSettings,
  requireReachable,
  type S3Settings,
  s3Settings,
  type ServiceAddress,
  type SmtpSettings,
  smtpSettings,
  stalwartSettings,
  THROWAWAY_CREDENTIAL,
} from "./services.ts"

export {
  RESERVED_EMAIL_DOMAIN,
  uniqueIdentifier,
  uniqueKeyPrefix,
  uniqueRecipient,
  uniqueSuffix,
} from "./isolation.ts"

export {
  deleteMail,
  type MailpitAddress,
  type MailpitMessage,
  type MailpitSummary,
  readMail,
  searchMail,
  waitForMail,
} from "./mailpit.ts"

export { deleteObject, ensureBucket } from "./s3.ts"

export { createStalwartUser, deleteStalwartUser, type StalwartUser } from "./stalwart.ts"

export { createScratchFolder, removeScratchFolder } from "./scratch.ts"
