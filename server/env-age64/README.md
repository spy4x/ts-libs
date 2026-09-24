# `@spy4x/server/env-age64`

Per-value env-file encryption: `KEY=age64:<base64 of an age ciphertext>`. Every value is encrypted
on its own, so a re-encrypt of an unchanged `.env` leaves `.env.age` byte-identical — no diff noise
in git for values that didn't change, and only the changed line moves when one does.

Cryptography runs in-process with [`jsr:@age/age-encryption`](https://jsr.io/@age/age-encryption)
(typage, the official TypeScript implementation of [age](https://age-encryption.org)). Nothing here
shells out to the `age` binary, so no caller ever needs `--allow-run`.

## Quick start

```bash
deno add jsr:@spy4x/server
```

```jsonc
// deno.json / deno.jsonc, "tasks"
{
  "env:encrypt": "deno run -R -W=. jsr:@spy4x/server/env-age64/cli encrypt",
  "env:decrypt": "deno run -R -W=. jsr:@spy4x/server/env-age64/cli decrypt"
}
```

```bash
deno task env:encrypt   # every .env* under cwd -> its .env*.age sibling
deno task env:decrypt   # every .env*.age under cwd -> its plaintext sibling
```

`cli.ts` also has a `status` command (prints whether a key is present and which files were found)
and a `keygen` command (writes a fresh `.age/key.txt`, refusing to overwrite an existing one).

## The key

A project's identity lives at `<root>/.age/key.txt`, in the same format `age-keygen -o key.txt`
writes:

```
# created: 2026-09-24T12:00:00.000Z
# public key: age1...
AGE-SECRET-KEY-1...
```

`<root>/.age/key.txt` should be gitignored — it is the one file that must never be committed. In a
linked git worktree that hasn't copied its own key yet, `resolveKeyFile` falls back to the MAIN
checkout's key: it finds the main checkout by reading the worktree's `.git` file (a `gitdir: ...`
pointer) and that directory's `commondir` file, never by running `git` or reading a `GIT_*`
environment variable. That is deliberate: a parent process (a pre-commit hook running its own git
command, say) may have exported `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` to steer
ITS OWN git invocation, and those variables are simply never read here — there is nothing for them
to poison.

## API

| Export                               | What it does                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `encryptEnvFiles(root)`              | Re-encrypts every `.env*` under `root` to its `.env*.age` sibling (mode `0644`)     |
| `decryptEnvFiles(root)`              | Decrypts every `.env*.age` under `root` to its plaintext sibling (mode `0600`)      |
| `ageStatus(root)`                    | `{ keyPresent, recipient?, envFiles, ageFiles }` — no decryption                    |
| `generateAgeKey(root)`               | Writes a fresh `.age/key.txt` (mode `0600`); refuses to overwrite an existing one   |
| `encryptValue(value, recipient)`     | Encrypt one value for an `age1...` recipient — no filesystem involved               |
| `decryptValue(age64Value, identity)` | Decrypt one `age64:...` value with an `AGE-SECRET-KEY-1...` identity                |
| `parseEnvFile(content)`              | Parse an env file's lines into `EnvEntry[]`; throws on anything it can't round-trip |

`resolveKeyFile`, `findGitCommonRoot`, `readAgeKey`, `findEnvFiles`, `findEnvAgeFiles` and
`atomicWrite` are exported too, for a caller (or the follow-up issues in rostok, the template,
financy, antonshubin.com and dotfiles) that wants one piece without the whole file-level flow.

## What it refuses

- A multi-line value continuation, or any other line that isn't a comment, a blank line, or a
  `KEY=value`/`export KEY=value` assignment — `UnsupportedEnvSyntaxError`, naming the line.
- CRLF line endings — `CrlfNotSupportedError`. Convert the file to LF first.
- Writing through a symlink, or over any non-regular file — the write is refused before it
  happens; nothing the symlink points to is ever touched.
- A plaintext value found inside a `.env.age` during decrypt — a sign the file was hand-edited or
  corrupted, surfaced instead of silently passed through.
- Overwriting an existing `.age/key.txt` with a freshly generated one.

## Origin (#173)

Ported from two existing copies. rostok's `cli/age.ts`/`cli/encrypt.ts` supplied the worktree-aware
key lookup and the occurrence-matched renderer that keeps unchanged values' ciphertext byte-for-byte
stable. The template's `infra/scripts/env/age.ts` supplied the atomic write, the fixed file modes,
the symlink/non-regular refusal, `export KEY=` support, and rejecting unsupported syntax instead of
silently mangling it. See the PR that added this module for the full list of what was moved, what
was rewritten, and every bug fixed over either source.
