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

`readAgeKey(root)` is exported too: it returns the key file's path, identity and recipient, which
a caller of `decryptValue` or `encryptValue` needs. The entry point also exports the types above,
`AGE64_PREFIX`, `isAge64Value`, and the two parse errors. Everything else (key lookup, discovery,
the atomic write, the renderers) is internal, so it can change without a 2.0.

## Parsing a line

A comment or blank line passes through verbatim. Anything else is split on its FIRST `=` into a
key and a value. `export KEY=value` is recognised: the keyword stays in the rendered line but is
stripped from the reported key. `UnsupportedEnvSyntaxError` naming only the line NUMBER — never its
text — is thrown for any of three shapes:

- **No `=` at all** — most commonly a continuation of a multi-line value, which this format
  doesn't support.
- **A value that opens a quote (`"` or `'`) and doesn't close it on the SAME line** — the other
  shape a multi-line value's first line takes.
- **A key that doesn't match `^[A-Za-z_][A-Za-z0-9_.-]*$`** (after an `export` prefix is
  stripped). This still accepts rostok-style `my-key` and `a.b` — a key isn't restricted to shell
  identifier characters — but excludes `+` and `/`. Both checks above exist because of this one:
  a continuation line of an UNQUOTED multi-line value can itself contain `=` (base64 padding),
  and a naive first-`=` split would read the text before that `=` as a "key" and encrypt only the
  text after it — leaving the rest of the secret sitting in `.env.age` as a plaintext "key name".
  Rejecting `+`/`/` in a key closes that hole for most base64 continuation lines, but not all:
  roughly one random 64-character base64 line in eight contains neither. **A continuation line
  of an unquoted multi-line value made of letters and digits followed by `=` padding is still
  read as a key, and that key is committed in plaintext.** That shape was never valid dotenv in
  either source repo, and detecting it would need multi-line lookahead this parser doesn't do.
  Quote every multi-line value, as the second check above requires, and this case cannot arise.
- **A carriage return anywhere in a line** (a lone `\r`, or a file with old Mac line endings).
  CRLF files get their own clearer error first. A lone `\r` would encrypt, but decrypt refuses
  to write a value containing a line break, so the committed `.env.age` could not be decrypted.

A comment line is copied into `.env.age` as it is, including a commented-out secret such as
`# OLD_TOKEN=…`. Both source repos did the same, and the format is kept. Delete a secret rather
than commenting it out.

A rejected line's text never reaches the error message either way: it is exactly the shape most
likely to be a secret, and an error message is a place that leaks (stderr, CI logs, an
error-reporting service).

## What it refuses

- A line with no `=`, an unterminated quote, or an invalid key name — see "Parsing a line" above.
- CRLF line endings — `CrlfNotSupportedError`. Convert the file to LF first.
- A decrypted value containing `\n` or `\r` — writing it verbatim would inject an extra line into
  the plaintext `.env` that a later parse could read back as an unrelated assignment.
- Writing through a symlink, or over any non-regular file — the write is refused before it
  happens; nothing the symlink points to is ever touched. A named pipe, socket or device node
  found while scanning for `.env*` files is silently skipped rather than opened (opening a FIFO
  with nothing writing to it blocks forever).
- A plaintext value found inside a `.env.age` during decrypt — a sign the file was hand-edited or
  corrupted, surfaced instead of silently passed through.
- Overwriting an existing `.age/key.txt` with a freshly generated one — race-free: the check can't
  be fooled by two concurrent `keygen` runs.
- Generating a key in a worktree that already resolves (via the main checkout) to a working key —
  that would shadow it instead of replacing anything.
- A file named `*.sops-backup` or `*.sops-backup.age`, matching rostok's own exclusion, so a
  leftover from the SOPS-to-age64 migration in a project's history is never treated as live.

A decrypted value is never trimmed — unlike rostok, which ran every decrypted value through
`.trim()`, silently discarding real leading/trailing whitespace a value might have had on purpose.
The newline/carriage-return rejection above catches the corruption trimming used to paper over
(an errant line break coming out of a decrypt), without ever discarding whitespace that belongs.

The recipient this module encrypts for is always DERIVED from the identity
(`identityToRecipient`), never read from the key file's `# public key:` comment — that comment is
just text, and trusting a stale or hand-edited one would mean encrypting for a recipient the real
identity can't decrypt.

## Origin (#173)

Ported from two existing copies. rostok's `cli/age.ts`/`cli/encrypt.ts` supplied the worktree-aware
key lookup and the occurrence-matched renderer that keeps unchanged values' ciphertext byte-for-byte
stable. The template's `infra/scripts/env/age.ts` supplied the atomic write, the fixed file modes,
the symlink/non-regular refusal, `export KEY=` support, and rejecting unsupported syntax instead of
silently mangling it. See the PR that added this module for the full list of what was moved, what
was rewritten, and every bug fixed over either source.
