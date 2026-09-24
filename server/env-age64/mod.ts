/**
 * age64 env-file encryption: `KEY=age64:<base64>`, encrypted in-process with
 * `jsr:@age/age-encryption` — no `age` binary, no `--allow-run`. See `README.md`.
 *
 * @module
 */

export {
  AGE64_PREFIX,
  CrlfNotSupportedError,
  decryptValue,
  encryptValue,
  type EnvAssignment,
  type EnvEntry,
  isAge64Value,
  parseEnvFile,
  UnsupportedEnvSyntaxError,
} from "./age64.ts"

export {
  type AgeKey,
  type AgeStatus,
  ageStatus,
  decryptEnvFiles,
  encryptEnvFiles,
  generateAgeKey,
  type GenerateAgeKeyResult,
  readAgeKey,
} from "./files.ts"
