/**
 * The age64 format and the pure, disk-free half of the module: parsing an env file, encrypting or
 * decrypting one value, and re-rendering a file so an unchanged value keeps its exact ciphertext.
 *
 * `KEY=age64:<base64 of an age ciphertext>` — each value is encrypted on its own, so an unchanged
 * value produces the exact same ciphertext on a re-run (no diff noise in git) and a changed value
 * touches only its own line.
 *
 * Extracted from two existing copies (#173): rostok's `cli/age.ts`/`cli/encrypt.ts` (worktree-aware
 * key lookup, the occurrence-matched byte-stable renderer) and the template's
 * `infra/scripts/env/age.ts` (`export KEY=` support, rejecting unsupported syntax instead of
 * silently mangling it). The cryptography itself is new: both sources shelled out to the `age`
 * binary; this module calls `jsr:@age/age-encryption` (typage) in-process, so no `--allow-run` is
 * needed anywhere in the module or its callers.
 */

import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from "@age/age-encryption"
import { decodeBase64, encodeBase64 } from "@std/encoding"
import { dirname, isAbsolute, join } from "@std/path"

/** Prefix every encrypted value carries: `KEY=age64:<base64>`. */
export const AGE64_PREFIX = "age64:"

/** True when `value` is an `age64:...` ciphertext rather than plaintext. */
export function isAge64Value(value: string): boolean {
  return value.startsWith(AGE64_PREFIX)
}

/**
 * One `KEY=value` (or `export KEY=value`) assignment. `prefix` is everything up to and including
 * the `=`, kept verbatim so re-rendering never has to guess the original spacing or the `export `
 * keyword back into place.
 */
export interface EnvAssignment {
  /** Text before the value, verbatim — e.g. `FOO=` or `export FOO=`. */
  prefix: string
  key: string
  /** Text after `=`, verbatim — including any `age64:` prefix or surrounding quotes. */
  value: string
}

/** One line of a parsed env file. Only an assignment line carries `assignment`. */
export interface EnvEntry {
  /** The original source line, verbatim (no trailing newline). */
  raw: string
  assignment?: EnvAssignment
}

const ASSIGNMENT = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=)(.*)$/
const KEY_FROM_PREFIX = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=$/

/** Thrown by {@link parseEnvFile} on anything it can't safely round-trip. */
export class UnsupportedEnvSyntaxError extends Error {
  constructor(line: number, text: string) {
    super(`unsupported env syntax at line ${line}: ${JSON.stringify(text)}`)
    this.name = "UnsupportedEnvSyntaxError"
  }
}

/** Thrown by {@link parseEnvFile} when the content uses CRLF line endings. */
export class CrlfNotSupportedError extends Error {
  constructor(path?: string) {
    super(
      `CRLF line endings are not supported${
        path ? ` (${path})` : ""
      } — convert the file to LF before encrypting or decrypting it`,
    )
    this.name = "CrlfNotSupportedError"
  }
}

/**
 * Parse an env file's content into entries. Comments and blank lines pass through verbatim
 * (`raw` only); a `KEY=value` or `export KEY=value` line gets `assignment` set. Any other
 * non-blank, non-comment line — most commonly a continuation of a multi-line value, which neither
 * source repo's format supports — throws {@link UnsupportedEnvSyntaxError} rather than silently
 * treating it as a comment (the bug rostok's permissive parser had: `cli/age.ts:240-244` passed
 * such a line through unchanged, so a multi-line value was quietly mangled instead of rejected).
 *
 * CRLF is rejected outright with {@link CrlfNotSupportedError}: neither source handled it, and
 * silently keeping or stripping `\r` would risk corrupting a value that legitimately ends in one.
 */
export function parseEnvFile(content: string, path?: string): EnvEntry[] {
  if (content.includes("\r\n")) throw new CrlfNotSupportedError(path)
  const lines = content.split("\n")
  const entries: EnvEntry[] = []
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) {
      entries.push({ raw: line })
      return
    }
    const match = line.match(ASSIGNMENT)
    if (!match) throw new UnsupportedEnvSyntaxError(index + 1, line)
    const [, prefix, value] = match
    const key = prefix.match(KEY_FROM_PREFIX)?.[1]
    if (!key) throw new UnsupportedEnvSyntaxError(index + 1, line)
    entries.push({ raw: line, assignment: { prefix, key, value } })
  })
  return entries
}

/** Encrypt one value for `recipient` (an `age1...` string). Returns `age64:<base64>`. */
export async function encryptValue(value: string, recipient: string): Promise<string> {
  const encrypter = new Encrypter()
  encrypter.addRecipient(recipient)
  const ciphertext = await encrypter.encrypt(value)
  return AGE64_PREFIX + encodeBase64(ciphertext)
}

/** Decrypt an `age64:<base64>` value with `identity` (an `AGE-SECRET-KEY-1...` string). */
export async function decryptValue(age64Value: string, identity: string): Promise<string> {
  if (!isAge64Value(age64Value)) {
    throw new Error(`not an age64 value: ${age64Value.slice(0, 20)}`)
  }
  const ciphertext = decodeBase64(age64Value.slice(AGE64_PREFIX.length))
  const decrypter = new Decrypter()
  decrypter.addIdentity(identity)
  return await decrypter.decrypt(ciphertext, "text")
}

/** A freshly generated identity and its recipient, in `age-keygen`'s own key-file format. */
export interface GeneratedAgeKey {
  identity: string
  recipient: string
  /** `key.txt` content: a `# created`/`# public key` comment pair, then the identity. */
  keyFileContent: string
}

/** Generate a new X25519 identity, formatted the way `age-keygen -o key.txt` would write it. */
export async function generateIdentityKeyFile(): Promise<GeneratedAgeKey> {
  const identity = await generateIdentity()
  const recipient = await identityToRecipient(identity)
  const keyFileContent = `# created: ${new Date().toISOString()}\n` +
    `# public key: ${recipient}\n` +
    `${identity}\n`
  return { identity, recipient, keyFileContent }
}

/** Parse the `AGE-SECRET-KEY-1...` identity line out of a `key.txt`'s content. */
export function parseIdentity(keyFileContent: string): string {
  const identity = keyFileContent.split("\n").map((line) => line.trim()).find((line) =>
    line.startsWith("AGE-SECRET-KEY-1") && !line.startsWith("#")
  )
  if (!identity) throw new Error("no AGE-SECRET-KEY-1... line found in key file")
  return identity
}

/** Parse the `# public key: age1...` recipient comment out of a `key.txt`'s content. */
export function parsePublicKey(keyFileContent: string): string {
  const match = keyFileContent.match(/^#\s*public key:\s*(\S+)\s*$/m)
  if (!match) throw new Error("no '# public key: age1...' line found in key file")
  return match[1]
}

/**
 * Find the git common directory for `cwd` by reading `.git` and, in a linked worktree, the
 * `commondir` file next to it — never by running `git` or reading a `GIT_*` environment variable.
 * Returns the MAIN checkout's root (the directory that holds its `.git`), or `undefined` when
 * `cwd` has no `.git` at all, or already IS the main checkout (its own `.git` is a directory, not a
 * worktree pointer file), or the pointer/`commondir` files don't parse.
 *
 * This is what closes #173's poisoned-environment case by construction rather than by a guard:
 * there is no `Deno.env.get` call anywhere in this function for a `GIT_DIR` (or similar) to
 * poison — a parent process exporting one has nothing to affect here.
 */
export function findGitCommonRoot(cwd: string): string | undefined {
  const gitPath = join(cwd, ".git")
  let info: Deno.FileInfo
  try {
    info = Deno.lstatSync(gitPath)
  } catch {
    return undefined
  }
  if (!info.isFile) return undefined // a directory here means cwd is already the main checkout

  const pointer = Deno.readTextFileSync(gitPath)
  const gitDirMatch = pointer.match(/^gitdir:\s*(.+?)\s*$/m)
  if (!gitDirMatch) return undefined
  const gitDir = isAbsolute(gitDirMatch[1]) ? gitDirMatch[1] : join(cwd, gitDirMatch[1])

  let commonDirContent: string
  try {
    commonDirContent = Deno.readTextFileSync(join(gitDir, "commondir")).trim()
  } catch {
    return undefined
  }
  const commonGitDir = isAbsolute(commonDirContent)
    ? commonDirContent
    : join(gitDir, commonDirContent)
  return dirname(commonGitDir)
}

/**
 * Resolve the `.age/key.txt` this `cwd` should use: `<cwd>/.age/key.txt` when it exists, otherwise
 * the main checkout's, found via {@link findGitCommonRoot}, otherwise `<cwd>/.age/key.txt` again
 * (a path that may not exist — callers check with {@link keyFileExists} or by reading it).
 */
export function resolveKeyFile(cwd: string): string {
  const local = join(cwd, ".age", "key.txt")
  try {
    if (Deno.statSync(local).isFile) return local
  } catch { /* fall through to the git-common-dir lookup */ }

  const mainRoot = findGitCommonRoot(cwd)
  if (mainRoot !== undefined) return join(mainRoot, ".age", "key.txt")
  return local
}

/** True when `resolveKeyFile(cwd)` names a file that actually exists. */
export function keyFileExists(cwd: string): boolean {
  try {
    return Deno.statSync(resolveKeyFile(cwd)).isFile
  } catch {
    return false
  }
}

/** One occurrence of a key's value in a previously encrypted file. */
interface PreviousOccurrence {
  ciphertext?: string
  plaintext: string
}

/**
 * Index a `.env.age`'s content by key, occurrence by occurrence (not just by key) — a `.env` may
 * legitimately define the same key twice, and a plain key → value map would keep only the last one,
 * so every earlier occurrence would compare unequal and get re-encrypted on every run.
 *
 * An occurrence that was NOT age64 ciphertext (a plaintext value that leaked into `.env.age`
 * somehow) is still indexed, positionally, but with no `ciphertext` — {@link renderEncryptedFile}
 * never reuses it, so a plaintext secret in `.env.age` is healed into real ciphertext on the very
 * next encrypt rather than being carried forward forever.
 */
export async function indexEncryptedFile(
  content: string,
  decrypt: (value: string) => Promise<string>,
): Promise<Map<string, PreviousOccurrence[]>> {
  const byKey = new Map<string, PreviousOccurrence[]>()
  for (const entry of parseEnvFile(content)) {
    if (!entry.assignment) continue
    const { key, value } = entry.assignment
    const occurrences = byKey.get(key) ?? []
    occurrences.push({
      ciphertext: isAge64Value(value) ? value : undefined,
      plaintext: isAge64Value(value) ? await decrypt(value) : value,
    })
    byKey.set(key, occurrences)
  }
  return byKey
}

/**
 * Render a `.env`'s content as its encrypted `.env.age` form, reusing `previous`'s ciphertext
 * byte-for-byte for every value that hasn't changed (so a re-encrypt of an unchanged file produces
 * no git diff), and encrypting anything new or changed.
 */
export async function renderEncryptedFile(
  content: string,
  previous: Map<string, PreviousOccurrence[]>,
  encrypt: (value: string) => Promise<string>,
): Promise<string> {
  const counts = new Map<string, number>()
  const lines: string[] = []
  for (const entry of parseEnvFile(content)) {
    if (!entry.assignment) {
      lines.push(entry.raw)
      continue
    }
    const { prefix, key, value } = entry.assignment
    const occurrence = counts.get(key) ?? 0
    counts.set(key, occurrence + 1)
    const old = previous.get(key)?.[occurrence]
    const reuse = old?.ciphertext !== undefined && old.plaintext === value
    lines.push(prefix + (reuse ? old.ciphertext! : await encrypt(value)))
  }
  return lines.join("\n").replace(/\n*$/, "") + "\n"
}

/**
 * Render a `.env.age`'s content as its decrypted `.env` form. Throws if any assignment's value is
 * not age64 ciphertext — a plaintext value inside a committed `.env.age` is a sign the file was
 * hand-edited or corrupted, and silently passing it through would hide that.
 */
export async function renderDecryptedFile(
  content: string,
  decrypt: (value: string) => Promise<string>,
): Promise<string> {
  const lines: string[] = []
  for (const entry of parseEnvFile(content)) {
    if (!entry.assignment) {
      lines.push(entry.raw)
      continue
    }
    const { prefix, key, value } = entry.assignment
    if (!isAge64Value(value)) {
      throw new Error(`${key}: plaintext value found in an encrypted file, refusing to decrypt`)
    }
    lines.push(prefix + await decrypt(value))
  }
  return lines.join("\n").replace(/\n*$/, "") + "\n"
}
