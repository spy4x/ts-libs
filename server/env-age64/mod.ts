/**
 * age64 env-file encryption: `KEY=age64:<base64>`, encrypted in-process with
 * `jsr:@age/age-encryption` — no `age` binary, no `--allow-run`. See `README.md`.
 */

export {
  AGE64_PREFIX,
  CrlfNotSupportedError,
  decryptValue,
  encryptValue,
  type EnvAssignment,
  type EnvEntry,
  findGitCommonRoot,
  type GeneratedAgeKey,
  generateIdentityKeyFile,
  indexEncryptedFile,
  isAge64Value,
  keyFileExists,
  parseEnvFile,
  parseIdentity,
  parsePublicKey,
  renderDecryptedFile,
  renderEncryptedFile,
  resolveKeyFile,
  UnsupportedEnvSyntaxError,
} from "./age64.ts"

export {
  type AgeKey,
  type AgeStatus,
  ageStatus,
  atomicWrite,
  decryptEnvFiles,
  encryptEnvFiles,
  findEnvAgeFiles,
  findEnvFiles,
  generateAgeKey,
  type GenerateAgeKeyResult,
  readAgeKey,
} from "./files.ts"
