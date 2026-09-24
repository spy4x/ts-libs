#!/usr/bin/env -S deno run -R -W=.
/**
 * Runnable CLI for the module, meant to be a project's whole `env:encrypt`/`env:decrypt` task:
 *
 * ```jsonc
 * "env:encrypt": "deno run -R -W=. jsr:@spy4x/server/env-age64/cli encrypt",
 * "env:decrypt": "deno run -R -W=. jsr:@spy4x/server/env-age64/cli decrypt",
 * ```
 *
 * Commands: `encrypt`, `decrypt`, `status`, `keygen`. Always operates on `Deno.cwd()` — the task
 * runner's own working directory is the project root, and every command below takes it as `root`.
 */

import { ageStatus, decryptEnvFiles, encryptEnvFiles, generateAgeKey } from "./mod.ts"

async function run(command: string | undefined): Promise<void> {
  const root = Deno.cwd()
  switch (command) {
    case "encrypt": {
      const written = await encryptEnvFiles(root)
      console.log(`encrypted ${written.length} file(s)`)
      break
    }
    case "decrypt": {
      const written = await decryptEnvFiles(root)
      console.log(`decrypted ${written.length} file(s)`)
      break
    }
    case "status": {
      const status = await ageStatus(root)
      console.log(JSON.stringify(status, null, 2))
      break
    }
    case "keygen": {
      const key = await generateAgeKey(root)
      console.log(`generated ${key.path}`)
      console.log(`public key: ${key.recipient}`)
      break
    }
    default:
      throw new Error(`usage: cli <encrypt|decrypt|status|keygen>, got ${JSON.stringify(command)}`)
  }
}

if (import.meta.main) {
  try {
    await run(Deno.args[0])
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    Deno.exit(1)
  }
}
