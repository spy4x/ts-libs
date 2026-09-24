/**
 * The disk-touching half of the module: finding `.env`/`.env.age` files under a project root,
 * reading and generating the `.age/key.txt`, and the atomic, permission-checked writes that turn
 * one root's plaintext into ciphertext and back.
 *
 * Safety features moved from the template's `infra/scripts/env/age.ts`: an atomic write through a
 * temp file and rename, fixed file modes (`0600` for `.env`/`key.txt`, `0644` for `.env.age`), and
 * refusing to write through a symlink or over a non-regular file.
 */

import { dirname, join } from "@std/path"
import {
  decryptValue,
  encryptValue,
  generateIdentityKeyFile,
  indexEncryptedFile,
  parseIdentity,
  parsePublicKey,
  renderDecryptedFile,
  renderEncryptedFile,
  resolveKeyFile,
} from "./age64.ts"

/** True if `dir` is itself a git checkout (a worktree, a submodule, or another clone). */
async function isNestedCheckout(dir: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(join(dir, ".git"))
    return info.isDirectory || info.isFile
  } catch {
    return false
  }
}

async function walk(
  dir: string,
  results: string[],
  matches: (name: string) => boolean,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walk(path, results, matches)
      continue
    }
    if (!matches(entry.name)) continue
    if (entry.isSymlink) throw new Error(`refusing to read an env file through a symlink: ${path}`)
    results.push(path)
  }
}

/** True for a plaintext env file name: starts with `.env`, isn't an example, isn't `.age`. */
function isPlaintextEnvName(name: string): boolean {
  return name.startsWith(".env") && !name.includes(".example") && !name.endsWith(".age")
}

/** True for an encrypted env file name: starts with `.env`, isn't an example, ends in `.age`. */
function isEncryptedEnvName(name: string): boolean {
  return name.startsWith(".env") && !name.includes(".example") && name.endsWith(".age")
}

/** Every plaintext `.env*` file under `root`, sorted, skipping hidden dirs and nested checkouts. */
export async function findEnvFiles(root: string): Promise<string[]> {
  const results: string[] = []
  await walk(root, results, isPlaintextEnvName)
  return results.sort()
}

/** Every `.env*.age` file under `root`, sorted, skipping hidden dirs and nested checkouts. */
export async function findEnvAgeFiles(root: string): Promise<string[]> {
  const results: string[] = []
  await walk(root, results, isEncryptedEnvName)
  return results.sort()
}

/** Throws unless `path` doesn't exist yet, or exists and is a regular file (never a symlink, FIFO, …). */
async function assertRegularOrMissing(path: string): Promise<void> {
  let info: Deno.FileInfo
  try {
    info = await Deno.lstat(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return
    throw error
  }
  if (info.isSymlink) throw new Error(`refusing to write through a symlink: ${path}`)
  if (!info.isFile) throw new Error(`refusing to write over a non-regular file: ${path}`)
}

/**
 * Write `content` to `path` atomically: through a same-directory temp file, `chmod`ped to `mode`,
 * then renamed over the destination. Refuses outright when `path` exists and is a symlink or any
 * non-regular file — the rename would otherwise silently replace whatever that pointed to.
 */
export async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await assertRegularOrMissing(path)
  const tempPath = await Deno.makeTempFile({ dir: dirname(path), prefix: ".env-age64.tmp-" })
  try {
    await Deno.writeTextFile(tempPath, content)
    await Deno.chmod(tempPath, mode)
    await Deno.rename(tempPath, path)
  } finally {
    await Deno.remove(tempPath).catch(() => {}) // already renamed, or the write/chmod itself failed
  }
}

/** `.age/key.txt`'s two pieces once resolved for a root: where it is, and what it decrypts with. */
export interface AgeKey {
  path: string
  identity: string
  recipient: string
}

/** Read and parse the `.age/key.txt` that applies to `root` (see {@link resolveKeyFile}). */
export async function readAgeKey(root: string): Promise<AgeKey> {
  const path = resolveKeyFile(root)
  let content: string
  try {
    content = await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`age key not found: ${path} — run the module's \`keygen\` command first`)
    }
    throw error
  }
  return { path, identity: parseIdentity(content), recipient: parsePublicKey(content) }
}

/** Result of {@link generateAgeKey}: where the key landed, and its recipient (safe to share). */
export interface GenerateAgeKeyResult {
  path: string
  recipient: string
}

/**
 * Generate a fresh identity and write it to `<root>/.age/key.txt`, mode `0600`. Refuses to
 * overwrite an existing key file — losing the only copy of an identity is unrecoverable.
 */
export async function generateAgeKey(root: string): Promise<GenerateAgeKeyResult> {
  const dir = join(root, ".age")
  const path = join(dir, "key.txt")
  if (await Deno.stat(path).then(() => true, () => false)) {
    throw new Error(`age key already exists, refusing to overwrite it: ${path}`)
  }
  await Deno.mkdir(dir, { recursive: true })
  const { recipient, keyFileContent } = await generateIdentityKeyFile()
  await atomicWrite(path, keyFileContent, 0o600)
  return { path, recipient }
}

/** A project's env-encryption posture: what files exist and whether a key is available. */
export interface AgeStatus {
  keyPresent: boolean
  /** The key's recipient, when a key is present (safe to log or display). */
  recipient?: string
  envFiles: string[]
  ageFiles: string[]
}

/** Inspect `root`'s env files and key, without decrypting anything. */
export async function ageStatus(root: string): Promise<AgeStatus> {
  const [envFiles, ageFiles] = await Promise.all([findEnvFiles(root), findEnvAgeFiles(root)])
  try {
    const key = await readAgeKey(root)
    return { keyPresent: true, recipient: key.recipient, envFiles, ageFiles }
  } catch {
    return { keyPresent: false, envFiles, ageFiles }
  }
}

/**
 * Re-encrypt every `.env*` file under `root` to its `.env.age` sibling, mode `0644`, reusing
 * unchanged ciphertext byte-for-byte. Every file is attempted even if one fails; if any did, the
 * combined error is thrown after the rest have run (fail loudly, but don't let one bad value in
 * one file block every other file from being encrypted).
 */
export async function encryptEnvFiles(root: string): Promise<string[]> {
  const key = await readAgeKey(root)
  const envFiles = await findEnvFiles(root)
  const written: string[] = []
  const errors: string[] = []
  for (const envPath of envFiles) {
    const agePath = `${envPath}.age`
    try {
      const content = await Deno.readTextFile(envPath)
      // Read the previous ciphertext only when `agePath` is a plain file. A symlink or a
      // directory there is left for `atomicWrite`'s own check below to refuse with a clear
      // message — reading it as text first would surface a confusing raw I/O error instead
      // (e.g. "Is a directory") for exactly the case this function means to reject.
      let previousContent = ""
      try {
        const existing = await Deno.lstat(agePath)
        if (existing.isFile) previousContent = await Deno.readTextFile(agePath)
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error
      }
      const previous = await indexEncryptedFile(
        previousContent,
        (value) => decryptValue(value, key.identity),
      )
      const rendered = await renderEncryptedFile(
        content,
        previous,
        (value) => encryptValue(value, key.recipient),
      )
      await atomicWrite(agePath, rendered, 0o644)
      written.push(agePath)
    } catch (error) {
      errors.push(`${envPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (errors.length > 0) throw new Error(`env:encrypt failed for:\n${errors.join("\n")}`)
  return written
}

/**
 * Decrypt every `.env*.age` file under `root` to its plaintext sibling, mode `0600`. Same
 * fail-loudly-after-attempting-every-file behaviour as {@link encryptEnvFiles}.
 */
export async function decryptEnvFiles(root: string): Promise<string[]> {
  const key = await readAgeKey(root)
  const ageFiles = await findEnvAgeFiles(root)
  const written: string[] = []
  const errors: string[] = []
  for (const agePath of ageFiles) {
    const envPath = agePath.slice(0, -".age".length)
    try {
      const content = await Deno.readTextFile(agePath)
      const rendered = await renderDecryptedFile(
        content,
        (value) => decryptValue(value, key.identity),
      )
      await atomicWrite(envPath, rendered, 0o600)
      written.push(envPath)
    } catch (error) {
      errors.push(`${agePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (errors.length > 0) throw new Error(`env:decrypt failed for:\n${errors.join("\n")}`)
  return written
}
