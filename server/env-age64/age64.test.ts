import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import {
  CrlfNotSupportedError,
  decryptValue,
  encryptValue,
  findGitCommonRoot,
  generateIdentityKeyFile,
  indexEncryptedFile,
  isAge64Value,
  parseEnvFile,
  parseIdentity,
  parsePublicKey,
  renderDecryptedFile,
  renderEncryptedFile,
  resolveKeyFile,
  UnsupportedEnvSyntaxError,
} from "./age64.ts"

const FIXTURES = fromFileUrl(new URL("./__fixtures__", import.meta.url))
const TEST_KEY_PATH = join(FIXTURES, "test-only-key.txt")

async function testIdentity(): Promise<{ identity: string; recipient: string }> {
  const content = await Deno.readTextFile(TEST_KEY_PATH)
  return { identity: parseIdentity(content), recipient: parsePublicKey(content) }
}

// ─── parseEnvFile ───────────────────────────────────────────────────────

Deno.test("parseEnvFile: keeps comments and blank lines verbatim, no assignment", () => {
  const entries = parseEnvFile("# a comment\n\nFOO=bar\n")
  assertEquals(entries[0], { raw: "# a comment" })
  assertEquals(entries[1], { raw: "" })
  assertEquals(entries[2].assignment, { prefix: "FOO=", key: "FOO", value: "bar" })
})

Deno.test("parseEnvFile: recognises an `export KEY=` line and keeps the keyword in the prefix", () => {
  const entries = parseEnvFile("export FOO=bar\n")
  assertEquals(entries[0].assignment, { prefix: "export FOO=", key: "FOO", value: "bar" })
})

Deno.test("parseEnvFile: keeps the value's surrounding quotes verbatim", () => {
  const entries = parseEnvFile(`FOO="has a space"\n`)
  assertEquals(entries[0].assignment?.value, `"has a space"`)
})

Deno.test("parseEnvFile: duplicate keys are both kept as separate entries", () => {
  const entries = parseEnvFile("A=one\nA=two\n")
  assertEquals(entries.filter((e) => e.assignment?.key === "A").length, 2)
})

Deno.test("parseEnvFile: rejects a multi-line value continuation instead of mangling it", () => {
  const error = assertThrows(
    () => parseEnvFile("TOKEN=first\nsecret-continuation\n"),
    UnsupportedEnvSyntaxError,
  )
  assertEquals(error.message.includes("line 2"), true)
})

Deno.test("parseEnvFile: the syntax error never repeats the rejected line's text", () => {
  // A rejected line is exactly the shape most likely to BE a secret — a PEM continuation, a
  // stray `STRIPE_KEY=sk_live_...` with odd spacing — and an error message is a place that
  // leaks: stderr, CI logs, an error-reporting service. The message must name the line NUMBER
  // only, never quote the line's own text.
  const error = assertThrows(
    () => parseEnvFile("TOKEN=first\nsecret-continuation\n"),
    UnsupportedEnvSyntaxError,
  )
  assertEquals(error.message.includes("secret-continuation"), false)
})

Deno.test("parseEnvFile: accepts a key rostok accepted but a shell identifier would not", () => {
  // rostok's own parser never restricted a key's character set (`line.slice(0, eqIdx).trim()`,
  // no pattern check) — a `.env.age` it produced may carry a key like this, and it must still
  // parse here rather than being rejected as "unsupported syntax".
  const entries = parseEnvFile("my-key=value\n")
  assertEquals(entries[0].assignment, { prefix: "my-key=", key: "my-key", value: "value" })
})

Deno.test("parseEnvFile: rejects CRLF line endings with a clear error", () => {
  assertThrows(() => parseEnvFile("FOO=bar\r\nBAZ=qux\r\n"), CrlfNotSupportedError)
})

Deno.test("parseEnvFile: a lone \\r inside a value (not a CRLF line ending) is preserved, not rejected", () => {
  // Guards against a naive `.includes("\r")` check that would also reject this — only the
  // \r\n line-ending SEQUENCE is rejected. A `\r` that isn't followed by `\n` can only occur
  // inside a value (line-splitting is on `\n` alone), and must survive untouched.
  const entries = parseEnvFile("FOO=bar\rbaz\n")
  assertEquals(entries[0].assignment?.value, "bar\rbaz")
})

// ─── encryptValue / decryptValue ────────────────────────────────────────

Deno.test("encryptValue/decryptValue: round-trips a value with a freshly generated identity", async () => {
  const { identity, recipient } = await generateIdentityKeyFile()
  const encrypted = await encryptValue("s3cr3t", recipient)
  assertEquals(isAge64Value(encrypted), true)
  assertEquals(await decryptValue(encrypted, identity), "s3cr3t")
})

Deno.test("decryptValue: rejects a value with no age64 prefix", async () => {
  await assertRejects(
    () => decryptValue("plain-value", "AGE-SECRET-KEY-1x"),
    Error,
    "not an age64 value",
  )
})

Deno.test("decryptValue: the no-prefix error never repeats the rejected value", async () => {
  const error = await assertRejects(
    () => decryptValue("sk_live_should_never_be_logged", "AGE-SECRET-KEY-1x"),
    Error,
  )
  assertEquals(error.message.includes("sk_live_should_never_be_logged"), false)
})

Deno.test("decryptValue: a value encrypted for a DIFFERENT identity fails to decrypt", async () => {
  const a = await generateIdentityKeyFile()
  const b = await generateIdentityKeyFile()
  const encryptedForA = await encryptValue("only-for-a", a.recipient)
  await assertRejects(() => decryptValue(encryptedForA, b.identity))
})

// ─── fixture interop: a `.env.age` produced outside this module decrypts unchanged ─────────

Deno.test("decryptValue: decrypts a value produced by the age 1.3.x CLI with the fixture key", async () => {
  const { identity } = await testIdentity()
  const fixture = await Deno.readTextFile(join(FIXTURES, "cli-produced.env.age"))
  const entries = parseEnvFile(fixture)
  const foo = entries.find((e) => e.assignment?.key === "FOO")!.assignment!.value
  const bar = entries.find((e) => e.assignment?.key === "BAR")!.assignment!.value
  assertEquals(await decryptValue(foo, identity), "hello-from-age-cli")
  assertEquals(await decryptValue(bar, identity), "second-value")
})

Deno.test("decryptValue: decrypts a value produced by rostok's current cli/encrypt.ts with the fixture key", async () => {
  const { identity } = await testIdentity()
  const fixture = await Deno.readTextFile(join(FIXTURES, "rostok-produced.env.age"))
  const entries = parseEnvFile(fixture)
  const foo = entries.find((e) => e.assignment?.key === "FOO")!.assignment!.value
  const bar = entries.find((e) => e.assignment?.key === "BAR")!.assignment!.value
  assertEquals(await decryptValue(foo, identity), "hello-from-age-cli")
  assertEquals(await decryptValue(bar, identity), "second-value")
})

// ─── indexEncryptedFile / renderEncryptedFile: byte-identical re-encryption ─────────────────

// Every encrypt call gets its own random UUID baked into the ciphertext — encrypting the SAME
// plaintext twice produces two DIFFERENT ciphertexts, the way real age encryption does (a fresh
// ephemeral key per call). A fake that instead derived the ciphertext deterministically from the
// plaintext (e.g. `btoa(value)` alone) would make every "stays byte-identical" test pass even if
// renderEncryptedFile's reuse logic were deleted outright — the assertion would still hold because
// re-encrypting the same value always yields the same bytes anyway, reuse or not.
function fakeCrypto() {
  return {
    encrypt(value: string): Promise<string> {
      return Promise.resolve(`age64:${crypto.randomUUID()}:${btoa(value)}`)
    },
    decrypt(value: string): Promise<string> {
      return Promise.resolve(atob(value.split(":")[2] ?? ""))
    },
  }
}

async function reencrypt(content: string, previous = ""): Promise<string> {
  const crypto = fakeCrypto()
  return await renderEncryptedFile(
    content,
    await indexEncryptedFile(previous, crypto.decrypt),
    crypto.encrypt,
  )
}

Deno.test("renderEncryptedFile: re-encrypting an unchanged file is byte-identical", async () => {
  const first = await reencrypt("A=one\nB=two\n")
  assertEquals(await reencrypt("A=one\nB=two\n", first), first)
})

Deno.test("renderEncryptedFile: only the changed value's line changes", async () => {
  const first = await reencrypt("A=one\nB=two\n")
  const second = await reencrypt("A=one\nB=changed\n", first)
  assertEquals(second.split("\n")[0], first.split("\n")[0])
  assertEquals(second.split("\n")[1] === first.split("\n")[1], false)
})

Deno.test("renderEncryptedFile: keeps the current line's `export` prefix when reusing ciphertext", async () => {
  const first = await reencrypt("A=one\n")
  const second = await reencrypt("export A=one\n", first)
  assertEquals(second.startsWith("export A=age64:"), true)
})

Deno.test("renderEncryptedFile: preserves comments, blanks, and duplicate keys", async () => {
  const source = "# header\nA=one\n\nA=two\n"
  const first = await reencrypt(source)
  assertEquals(await reencrypt(source, first), first)
  assertEquals(first.split("\n").filter((line) => line.startsWith("A=")).length, 2)
  assertEquals(first.includes("# header\n"), true)
  assertEquals(first.includes("\n\n"), true)
})

Deno.test("renderEncryptedFile: heals a plaintext value that leaked into a previous .env.age", async () => {
  const healed = await reencrypt("A=secret\n", "A=secret\n")
  assertEquals(healed.includes("A=secret\n"), false)
  assertEquals(await reencrypt("A=secret\n", healed), healed)
})

// ─── renderDecryptedFile ────────────────────────────────────────────────

Deno.test("renderDecryptedFile: rejects a plaintext assignment inside an encrypted file", async () => {
  const crypto = fakeCrypto()
  await assertRejects(
    () => renderDecryptedFile("# header\nA=plaintext\n", crypto.decrypt),
    Error,
    "plaintext value",
  )
})

Deno.test("renderDecryptedFile: rejects a decrypted value that contains a newline", async () => {
  const injecting = { decrypt: () => Promise.resolve("innocent\nATTACKER_KEY=age64:evil") }
  await assertRejects(
    () => renderDecryptedFile("A=age64:whatever\n", injecting.decrypt),
    Error,
    "line break",
  )
})

Deno.test("renderDecryptedFile: rejects a decrypted value that contains a carriage return", async () => {
  const injecting = { decrypt: () => Promise.resolve("bar\rBAZ=qux") }
  await assertRejects(
    () => renderDecryptedFile("A=age64:whatever\n", injecting.decrypt),
    Error,
    "line break",
  )
})

Deno.test("renderDecryptedFile: decrypts every assignment and keeps comments/blanks", async () => {
  const crypto = fakeCrypto()
  const encrypted = await reencrypt("# header\nA=one\n\nB=two\n")
  const decrypted = await renderDecryptedFile(encrypted, crypto.decrypt)
  assertEquals(decrypted, "# header\nA=one\n\nB=two\n")
})

// ─── findGitCommonRoot / resolveKeyFile: pure, read-only logic ─────────────
// (Cases that need to CREATE a git repo or a worktree on disk — including a plain, non-worktree
// checkout's `.git` directory — live in files.integration.test.ts, built by hand, because the
// unit tier has no write permission. A version of this test used to read THIS repo's own `.git`
// and silently return without asserting anything when it happened to be a linked worktree
// (`.git` is a file, not the directory case it wanted) — a test that can silently do nothing is a
// test that can't be trusted, so it was moved rather than kept conditional.)

Deno.test("resolveKeyFile: falls back to <cwd>/.age/key.txt when neither a local key nor a .git exist", () => {
  // Can't create a directory in the unit tier, so this asserts against a path that
  // deterministically doesn't exist and has no .git — the fallback path.
  const cwd = join(FIXTURES, "no-such-directory")
  assertEquals(resolveKeyFile(cwd), join(cwd, ".age", "key.txt"))
})

Deno.test("findGitCommonRoot: undefined when cwd has no .git", () => {
  assertEquals(findGitCommonRoot(join(FIXTURES, "no-such-directory")), undefined)
})
