/**
 * Everything in this module that needs a real filesystem: file modes, symlink refusal, atomic
 * rename, and worktree-shaped `.git` layouts. The unit tier has no write permission at all
 * (`deno task test` grants only `--allow-read --allow-env`), so every test here needs
 * `deno task test:integration`'s `--allow-write=.volumes` — see `createScratchFolder`.
 *
 * The worktree layouts below are built BY HAND (a `.git` file plus a `commondir` file, matching
 * what `git worktree add` itself writes) rather than by spawning real `git` — the integration
 * tier's task grants no `--allow-run` at all, and `findGitCommonRoot` only ever reads these two
 * files, so building them directly tests exactly what the function reads.
 */

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { createScratchFolder, removeScratchFolder } from "@integration-testing"
import {
  decryptEnvFiles,
  encryptEnvFiles,
  findEnvAgeFiles,
  findEnvFiles,
  generateAgeKey,
  readAgeKey,
} from "./files.ts"
import { resolveKeyFile } from "./age64.ts"

/** Write a linked-worktree-shaped `.git` file + `commondir`, pointing `worktree` at `main`. */
async function linkWorktree(main: string, worktree: string, name = "wt"): Promise<void> {
  const mainGitDir = join(main, ".git")
  const worktreeGitDir = join(mainGitDir, "worktrees", name)
  await Deno.mkdir(worktreeGitDir, { recursive: true })
  await Deno.writeTextFile(join(worktreeGitDir, "commondir"), "../..\n")
  await Deno.mkdir(worktree, { recursive: true })
  await Deno.writeTextFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`)
}

/** Set env vars for the duration of `fn`, restoring them afterward. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(vars).map((k) => [k, Deno.env.get(k)]))
  for (const [k, v] of Object.entries(vars)) Deno.env.set(k, v)
  try {
    return await fn()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
  }
}

// ─── resolveKeyFile: worktree layout and poisoned-environment regressions ──────────────────

Deno.test("resolveKeyFile: a linked worktree with no key of its own falls back to the main checkout's", async () => {
  const root = await createScratchFolder("age64_worktree")
  try {
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    await Deno.mkdir(join(main, ".git"), { recursive: true })
    await Deno.mkdir(join(main, ".age"), { recursive: true })
    await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
    await linkWorktree(main, worktree)

    assertEquals(resolveKeyFile(worktree), join(main, ".age", "key.txt"))
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("resolveKeyFile: a linked worktree with its OWN key uses it, not the main checkout's", async () => {
  const root = await createScratchFolder("age64_worktree_own")
  try {
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    await Deno.mkdir(join(main, ".git"), { recursive: true })
    await Deno.mkdir(join(main, ".age"), { recursive: true })
    await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
    await linkWorktree(main, worktree)
    await Deno.mkdir(join(worktree, ".age"), { recursive: true })
    await Deno.writeTextFile(join(worktree, ".age", "key.txt"), "worktrees-own-key")

    assertEquals(resolveKeyFile(worktree), join(worktree, ".age", "key.txt"))
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test(
  "resolveKeyFile: GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE/GIT_INDEX_FILE pointed at a decoy never affect resolution (#173)",
  async () => {
    // The module reads no environment variable at all for this lookup — it can't be poisoned by
    // construction. This proves it: pointing every git-common env var this rostok's own history
    // (#226) warned about at a decoy still resolves to the real main checkout's key.
    const root = await createScratchFolder("age64_poison")
    try {
      const main = join(root, "main")
      const worktree = join(root, "worktree")
      const decoy = join(root, "decoy")
      await Deno.mkdir(join(main, ".git"), { recursive: true })
      await Deno.mkdir(join(main, ".age"), { recursive: true })
      await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
      await linkWorktree(main, worktree)

      await Deno.mkdir(join(decoy, ".git"), { recursive: true })
      await Deno.mkdir(join(decoy, ".age"), { recursive: true })
      await Deno.writeTextFile(join(decoy, ".age", "key.txt"), "decoy-key-must-never-be-read")

      const resolved = await withEnv(
        {
          GIT_DIR: join(decoy, ".git"),
          GIT_COMMON_DIR: join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoy, ".git", "index"),
        },
        () => Promise.resolve(resolveKeyFile(worktree)),
      )
      assertEquals(resolved, join(main, ".age", "key.txt"))
    } finally {
      await removeScratchFolder(root)
    }
  },
)

// ─── discovery: hidden dirs, examples, nested checkouts ────────────────────────────────────

Deno.test("findEnvFiles: skips hidden directories, .example files, and nested checkouts", async () => {
  const root = await createScratchFolder("age64_discovery")
  try {
    await Deno.writeTextFile(join(root, ".env"), "A=1")
    await Deno.writeTextFile(join(root, ".env.example"), "A=example")
    await Deno.mkdir(join(root, "service"))
    await Deno.writeTextFile(join(root, "service", ".env.prod"), "B=2")
    await Deno.mkdir(join(root, ".hidden"))
    await Deno.writeTextFile(join(root, ".hidden", ".env"), "HIDDEN=1")
    await Deno.mkdir(join(root, "nested"))
    await Deno.writeTextFile(join(root, "nested", ".git"), "gitdir: elsewhere")
    await Deno.writeTextFile(join(root, "nested", ".env"), "NESTED=1")

    assertEquals(await findEnvFiles(root), [
      join(root, ".env"),
      join(root, "service", ".env.prod"),
    ])
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("findEnvAgeFiles: only matches .env*.age files, not the plaintext siblings", async () => {
  const root = await createScratchFolder("age64_discovery_age")
  try {
    await Deno.writeTextFile(join(root, ".env"), "A=1")
    await Deno.writeTextFile(join(root, ".env.age"), "A=age64:x")
    await Deno.writeTextFile(join(root, ".env.example"), "A=example")

    assertEquals(await findEnvAgeFiles(root), [join(root, ".env.age")])
  } finally {
    await removeScratchFolder(root)
  }
})

// `Deno.symlink` itself needs UNSCOPED read/write permission ("path-scoped grants are not
// supported because a symlink's target is only resolved when the link is traversed") — the
// integration tier's own task grants only `--allow-write=.volumes`, so a symlink can't be
// created at test time here. These two cases use a symlink committed to the repo instead
// (`__fixtures__/symlink-discovery`, `__fixtures__/symlink-encrypt` — built with `ln -s`, not
// `Deno.symlink`), which needs no write permission to read.
const FIXTURES_URL = new URL("./__fixtures__", import.meta.url)

Deno.test("findEnvFiles: refuses an env file reached through a symlink", async () => {
  const root = join(FIXTURES_URL.pathname, "symlink-discovery")
  await assertRejects(() => findEnvFiles(root), Error, "symlink")
})

// ─── atomic write: modes, symlink and non-regular refusal ──────────────────────────────────

Deno.test("generateAgeKey: writes key.txt with mode 0600", async () => {
  const root = await createScratchFolder("age64_keygen_mode")
  try {
    const result = await generateAgeKey(root)
    const info = await Deno.stat(result.path)
    assertEquals((info.mode ?? 0) & 0o777, 0o600)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("generateAgeKey: refuses to overwrite an existing key", async () => {
  const root = await createScratchFolder("age64_keygen_no_overwrite")
  try {
    await generateAgeKey(root)
    await assertRejects(() => generateAgeKey(root), Error, "already exists")
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: writes .env.age with mode 0644", async () => {
  const root = await createScratchFolder("age64_encrypt_mode")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\n")
    const written = await encryptEnvFiles(root)
    assertEquals(written, [join(root, ".env.age")])
    const info = await Deno.stat(join(root, ".env.age"))
    assertEquals((info.mode ?? 0) & 0o777, 0o644)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("decryptEnvFiles: writes .env with mode 0600", async () => {
  const root = await createScratchFolder("age64_decrypt_mode")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\n")
    await encryptEnvFiles(root)
    await Deno.remove(join(root, ".env"))
    const written = await decryptEnvFiles(root)
    assertEquals(written, [join(root, ".env")])
    const info = await Deno.stat(join(root, ".env"))
    assertEquals((info.mode ?? 0) & 0o777, 0o600)
    assertEquals(await Deno.readTextFile(join(root, ".env")), "FOO=bar\n")
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: refuses to write .env.age through a symlink", async () => {
  const root = join(FIXTURES_URL.pathname, "symlink-encrypt")
  const protectedPath = join(root, "protected-target.txt")
  const before = await Deno.readTextFile(protectedPath)

  await assertRejects(() => encryptEnvFiles(root), Error, "symlink")
  assertEquals(await Deno.readTextFile(protectedPath), before)
})

Deno.test("encryptEnvFiles: refuses to write .env.age over a non-regular file (a directory)", async () => {
  const root = await createScratchFolder("age64_encrypt_nonregular")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\n")
    await Deno.mkdir(join(root, ".env.age"))

    await assertRejects(() => encryptEnvFiles(root), Error, "non-regular")
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("atomicWrite via encryptEnvFiles: a failed write never leaves a temp file behind", async () => {
  const root = await createScratchFolder("age64_atomic_cleanup")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\n")
    await Deno.mkdir(join(root, ".env.age")) // forces the write to fail
    await assertRejects(() => encryptEnvFiles(root))

    const leftovers = []
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith(".env-age64.tmp-")) leftovers.push(entry.name)
    }
    assertEquals(leftovers, [])
  } finally {
    await removeScratchFolder(root)
  }
})

// ─── end-to-end: encrypt/decrypt round trip, duplicate keys, export lines, CRLF ────────────

Deno.test("encryptEnvFiles -> decryptEnvFiles: round-trips duplicate keys and export lines", async () => {
  const root = await createScratchFolder("age64_roundtrip")
  try {
    await generateAgeKey(root)
    const source = "# header\nexport FOO=bar\nDUP=one\nDUP=two\n"
    await Deno.writeTextFile(join(root, ".env"), source)
    await encryptEnvFiles(root)

    const encrypted = await Deno.readTextFile(join(root, ".env.age"))
    assertEquals(encrypted.includes("bar"), false) // the plaintext never appears in .env.age
    assertEquals(encrypted.startsWith("# header\nexport FOO=age64:"), true)

    await Deno.remove(join(root, ".env"))
    await decryptEnvFiles(root)
    assertEquals(await Deno.readTextFile(join(root, ".env")), source)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: re-encrypting an unchanged .env leaves .env.age byte-identical", async () => {
  const root = await createScratchFolder("age64_stable_reencrypt")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "A=one\nB=two\n")
    await encryptEnvFiles(root)
    const first = await Deno.readTextFile(join(root, ".env.age"))

    await encryptEnvFiles(root)
    const second = await Deno.readTextFile(join(root, ".env.age"))
    assertEquals(second, first)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: changing one value changes only that line's ciphertext", async () => {
  const root = await createScratchFolder("age64_partial_reencrypt")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "A=one\nB=two\n")
    await encryptEnvFiles(root)
    const first = await Deno.readTextFile(join(root, ".env.age"))

    await Deno.writeTextFile(join(root, ".env"), "A=one\nB=changed\n")
    await encryptEnvFiles(root)
    const second = await Deno.readTextFile(join(root, ".env.age"))

    assertEquals(second.split("\n")[0], first.split("\n")[0])
    assertEquals(second.split("\n")[1] === first.split("\n")[1], false)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("decryptEnvFiles: a .env.age produced by the age 1.3.x CLI decrypts unchanged with a copied key", async () => {
  const root = await createScratchFolder("age64_cli_fixture")
  try {
    const fixtures = join(new URL("./__fixtures__", import.meta.url).pathname)
    await Deno.mkdir(join(root, ".age"), { recursive: true })
    await Deno.copyFile(join(fixtures, "test-only-key.txt"), join(root, ".age", "key.txt"))
    await Deno.copyFile(join(fixtures, "cli-produced.env.age"), join(root, ".env.age"))

    const written = await decryptEnvFiles(root)
    assertEquals(written, [join(root, ".env")])
    assertEquals(
      await Deno.readTextFile(join(root, ".env")),
      "# fixture produced by the age 1.3.x CLI for the unit test's decrypt-unchanged proof.\n" +
        "FOO=hello-from-age-cli\nBAR=second-value\n",
    )
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("decryptEnvFiles: a .env.age produced by rostok's current code decrypts unchanged with a copied key", async () => {
  const root = await createScratchFolder("age64_rostok_fixture")
  try {
    const fixtures = join(new URL("./__fixtures__", import.meta.url).pathname)
    await Deno.mkdir(join(root, ".age"), { recursive: true })
    await Deno.copyFile(join(fixtures, "test-only-key.txt"), join(root, ".age", "key.txt"))
    await Deno.copyFile(join(fixtures, "rostok-produced.env.age"), join(root, ".env.age"))

    const written = await decryptEnvFiles(root)
    assertEquals(written, [join(root, ".env")])
    assertEquals(
      await Deno.readTextFile(join(root, ".env")),
      "FOO=hello-from-age-cli\nBAR=second-value\n",
    )
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: rejects CRLF line endings with a clear error, writes nothing", async () => {
  const root = await createScratchFolder("age64_crlf")
  try {
    await generateAgeKey(root)
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\r\n")

    await assertRejects(() => encryptEnvFiles(root), Error, "CRLF")
    assertEquals(await Deno.stat(join(root, ".env.age")).then(() => true, () => false), false)
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("encryptEnvFiles: without a key, fails loudly rather than skipping silently", async () => {
  const root = await createScratchFolder("age64_no_key")
  try {
    await Deno.writeTextFile(join(root, ".env"), "FOO=bar\n")
    await assertRejects(() => encryptEnvFiles(root), Error, "age key not found")
  } finally {
    await removeScratchFolder(root)
  }
})

Deno.test("readAgeKey: the public key parsed back matches the one generateAgeKey returned", async () => {
  const root = await createScratchFolder("age64_readkey")
  try {
    const generated = await generateAgeKey(root)
    const key = await readAgeKey(root)
    assertEquals(key.recipient, generated.recipient)
  } finally {
    await removeScratchFolder(root)
  }
})
