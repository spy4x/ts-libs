import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { createEnvReader, MissingEnvError } from "./env.ts"
import { CommandError } from "./run-command.ts"
import { createFakeRunner, FakeCommandRunner } from "./testing/command-runner.ts"
import { FakeFileSystem } from "./testing/filesystem.ts"
import {
  assertNoSecretEnvKeys,
  buildComposeUpArgs,
  buildDeployPlan,
  buildEnvRsyncArgs,
  buildRsyncSourceArgs,
  bumpServiceWorkerBeforeDeploy,
  bumpServiceWorkerCacheVersion,
  deploy,
  type DeployScriptOptions,
  type DeployTarget,
  deriveStagingEnv,
  extractVolumePaths,
  generateDeployScript,
  getRemoteChecksums,
  parseDeployResults,
  readServiceWorkerCacheVersion,
  runDeployPlan,
  runDeployScript,
  shellQuote,
  type StackConfig,
} from "./deploy.ts"

const CANARY = "canary-9f3a-do-not-ship"

const TARGET: DeployTarget = {
  sshAddress: "deploy@host.example",
  remotePath: "~/cloudlab/apps/site/",
  project: "site",
  envFiles: [".env.prod"],
}

Deno.test("syncs the source as argv, honouring .dockerignore from the sender", () => {
  const argv = buildRsyncSourceArgs({ source: "./", target: "deploy@host.example:~/apps/site/" })
  assertEquals(argv, [
    "rsync",
    "-avz",
    "--delete",
    "--exclude",
    ".git/",
    "--exclude",
    ".age/",
    "--exclude",
    "node_modules/",
    "--exclude",
    "_fresh/",
    "--filter",
    ":- .dockerignore",
    "./",
    "deploy@host.example:~/apps/site/",
  ])
  assertEquals(argv.includes("bash"), false)
  assertEquals(argv.includes("-c"), false)
})

Deno.test("keeps the dockerignore filter as one argv element", () => {
  const argv = buildRsyncSourceArgs({ source: "./", target: "host:~/apps/site/" })
  assertEquals(argv[argv.indexOf("--filter") + 1], ":- .dockerignore")
})

Deno.test("allows an rsync without --delete", () => {
  const argv = buildRsyncSourceArgs({ source: "./", target: "host:~/apps/", delete: false })
  assertEquals(argv.includes("--delete"), false)
})

Deno.test("rejects a blank rsync source or target", () => {
  assertThrows(
    () => buildRsyncSourceArgs({ source: "", target: "host:~/apps/" }),
    CommandError,
    "rsync source must not be blank",
  )
  assertThrows(
    () => buildRsyncSourceArgs({ source: "./", target: " " }),
    CommandError,
    "rsync target must not be blank",
  )
})

Deno.test("syncs env files separately, as paths only", () => {
  const argv = buildEnvRsyncArgs("deploy@host.example:~/apps/site/", [".env", ".env.prod"])
  assertEquals(argv, [
    "rsync",
    "-avz",
    ".env",
    ".env.prod",
    "deploy@host.example:~/apps/site/",
  ])
  assertEquals(argv.some((arg) => arg.includes("=")), false)
})

Deno.test("rejects an env sync with no files", () => {
  assertThrows(() => buildEnvRsyncArgs("host:~/apps/", []), CommandError, "no env files to sync")
})

Deno.test("brings compose up over ssh without cd, bash or a shell string", () => {
  const argv = buildComposeUpArgs(TARGET)
  assertEquals(argv, [
    "ssh",
    "--",
    "deploy@host.example",
    "docker",
    "compose",
    "-p",
    "site",
    "-f",
    "~/cloudlab/apps/site/compose.yml",
    "--env-file",
    "~/cloudlab/apps/site/.env.prod",
    "up",
    "-d",
    "--build",
  ])
  assertEquals(argv.includes("cd"), false)
  assertEquals(argv.includes("bash"), false)
  assertEquals(argv.includes("-c"), false)
})

Deno.test("names each env file relative to the remote path", () => {
  const argv = buildComposeUpArgs({ ...TARGET, envFiles: [".env.root", ".env"] })
  const envFlags = argv.filter((_arg, index) => argv[index - 1] === "--env-file")
  assertEquals(envFlags, [
    "~/cloudlab/apps/site/.env.root",
    "~/cloudlab/apps/site/.env",
  ])
})

Deno.test("passes non-secret env entries to the remote compose command", () => {
  const argv = buildComposeUpArgs({ ...TARGET, env: { PROJECT: "site-stag" } })
  assertEquals(argv.slice(1, 5), ["--", "deploy@host.example", "env", "PROJECT=site-stag"])
  assertEquals(argv[5], "docker")
})

Deno.test("rejects a secret-looking env entry before it reaches the remote argv", () => {
  assertThrows(
    () => buildComposeUpArgs({ ...TARGET, env: { API_KEY: CANARY } }),
    CommandError,
    "looks like a secret",
  )
  assertThrows(
    () => assertNoSecretEnvKeys({ AWS_SECRET_ACCESS_KEY: CANARY }),
    CommandError,
    "pass it in a file via --env-file",
  )
})

Deno.test("rejects a remote path the remote shell would execute", () => {
  assertThrows(
    () => buildComposeUpArgs({ ...TARGET, remotePath: "~/apps/site; rm -rf /" }),
    CommandError,
    "remote shell would execute",
  )
})

Deno.test("rejects a blank compose project name", () => {
  assertThrows(
    () => buildComposeUpArgs({ ...TARGET, project: "" }),
    CommandError,
    "project must not",
  )
})

Deno.test("plans source, env and compose in that order", () => {
  const plan = buildDeployPlan({ target: TARGET })
  assertEquals(plan.steps.map((step) => step.name), ["sync-source", "sync-env", "compose-up"])
  assertEquals(plan.source, "./")
  assertEquals(plan.target, "deploy@host.example:~/cloudlab/apps/site/")
})

Deno.test("omits the env step when the target has no env files", () => {
  const plan = buildDeployPlan({ target: { ...TARGET, envFiles: [] } })
  assertEquals(plan.steps.map((step) => step.name), ["sync-source", "compose-up"])
})

Deno.test("no planned argv carries a shell or a secret value", () => {
  const plan = buildDeployPlan({ target: { ...TARGET, env: { PROJECT: "site" } } })
  for (const step of plan.steps) {
    assertEquals(step.argv.includes("bash"), false, `${step.name} must not use bash`)
    assertEquals(step.argv.includes("sh"), false, `${step.name} must not use sh`)
    assertEquals(step.argv.includes("-c"), false, `${step.name} must not use -c`)
    assertEquals(
      step.argv.some((arg) => arg.includes(CANARY)),
      false,
      `${step.name} must not carry a secret`,
    )
  }
})

Deno.test("runs every planned step in order and reports success", async () => {
  const runner = createFakeRunner()
  const outcome = await runDeployPlan(buildDeployPlan({ target: TARGET }), { runner })

  assertEquals(outcome.success, true)
  assertEquals(outcome.steps.map((step) => step.name), ["sync-source", "sync-env", "compose-up"])
  assertEquals(runner.calls.length, 3)
  assertEquals(runner.argvOf(2)?.includes("up"), true)
})

Deno.test("stops at the first failed step and reports the stderr", async () => {
  const runner = new FakeCommandRunner()
  runner.respond({ success: true, output: "" })
  runner.respond({ success: false, error: "rsync error: some files vanished (code 24)\n" })

  const outcome = await runDeployPlan(buildDeployPlan({ target: TARGET }), { runner })

  assertEquals(outcome.success, false)
  assertEquals(outcome.steps, [
    { name: "sync-source", success: true, error: undefined },
    { name: "sync-env", success: false, error: "rsync error: some files vanished (code 24)" },
  ])
  assertEquals(runner.calls.length, 2)
})

Deno.test("bumps the service worker cache version by one", () => {
  const source = `const CACHE = "example-v7"\n`
  const bumped = bumpServiceWorkerCacheVersion(source, "example")
  assertEquals(bumped, { content: `const CACHE = "example-v8"\n`, from: 7, to: 8 })
})

Deno.test("does not bump a version outside the anchored assignment", () => {
  const source = [
    `// example-v7 shipped on 2026-01-01`,
    `const OTHER = "example-v7"`,
    `const CACHE = "example-v7"`,
    "",
  ].join("\n")
  const bumped = bumpServiceWorkerCacheVersion(source, "example")
  assertEquals(
    bumped?.content,
    [
      `// example-v7 shipped on 2026-01-01`,
      `const OTHER = "example-v7"`,
      `const CACHE = "example-v8"`,
      "",
    ].join("\n"),
  )
  assertEquals(bumped?.from, 7)
})

Deno.test("does not confuse two caches with a shared prefix", () => {
  const source = `const CACHE = "site-v3"\nconst CACHE = "site-stag-v9"\n`
  const bumped = bumpServiceWorkerCacheVersion(source, "site")
  assertEquals(bumped?.to, 4)
  assertEquals(bumped?.content.includes(`"site-stag-v9"`), true)
})

Deno.test("reports no version when the pattern is absent", () => {
  assertEquals(bumpServiceWorkerCacheVersion("const CACHE = 7\n", "site"), null)
  assertEquals(readServiceWorkerCacheVersion("const CACHE = 7\n", "site"), null)
})

Deno.test("reads the same version the bump would change", () => {
  assertEquals(readServiceWorkerCacheVersion(`const CACHE = "site-v12"`, "site"), 12)
})

Deno.test("writes the bumped service worker through the filesystem port", async () => {
  const fs = new FakeFileSystem()
  fs.seed("/app/static/sw.js", `const CACHE = "site-v2"`)
  const version = await bumpServiceWorkerBeforeDeploy({
    fs,
    path: "/app/static/sw.js",
    name: "site",
  })
  assertEquals(version, { from: 2, to: 3 })
  assertEquals(fs.text("/app/static/sw.js"), `const CACHE = "site-v3"`)
})

Deno.test("leaves the service worker alone when it has no version pattern", async () => {
  const fs = new FakeFileSystem()
  fs.seed("/app/static/sw.js", `const CACHE = "other"\n`)
  const version = await bumpServiceWorkerBeforeDeploy({
    fs,
    path: "/app/static/sw.js",
    name: "site",
  })
  assertEquals(version, null)
  assertEquals(fs.writes, [])
})

Deno.test(
  "bumps the service worker before the sync, and carries a warning when it cannot",
  async () => {
    const fs = new FakeFileSystem()
    fs.seed("/app/static/sw.js", `const CACHE = "site-v1"`)
    const runner = createFakeRunner()

    const outcome = await deploy({
      runner,
      fs,
      target: TARGET,
      serviceWorker: { path: "/app/static/sw.js", name: "site" },
    })

    assertEquals(outcome.success, true)
    assertEquals(outcome.serviceWorkerVersion, { from: 1, to: 2 })
    assertEquals(fs.text("/app/static/sw.js"), `const CACHE = "site-v2"`)
    assertEquals(runner.calls.length, 3)
  },
)

Deno.test("warns instead of failing when the service worker pattern is missing", async () => {
  const fs = new FakeFileSystem()
  fs.seed("/app/static/sw.js", `// no cache constant here\n`)
  const outcome = await deploy({
    runner: createFakeRunner(),
    fs,
    target: TARGET,
    serviceWorker: { path: "/app/static/sw.js", name: "site" },
  })
  assertEquals(outcome.success, true)
  assertEquals(outcome.warnings, [
    `no service worker cache version for "site" in /app/static/sw.js`,
  ])
  assertEquals(outcome.serviceWorkerVersion, null)
})

Deno.test("derives the staging env by rewriting only the named keys", async () => {
  const fs = new FakeFileSystem()
  fs.seed(
    "/app/.env.prod",
    ["DOMAIN=example.com", "WWW_DOMAIN=www.example.com", "TZ=Asia/Singapore", ""].join(
      "\n",
    ),
  )

  const staging = await deriveStagingEnv({
    fs,
    prodPath: "/app/.env.prod",
    stagingPath: "/app/.env.staging",
    replacements: {
      DOMAIN: "website-stag.example.com",
      WWW_DOMAIN: "website-stag.example.com",
    },
  })

  assertEquals(
    staging,
    [
      "DOMAIN=website-stag.example.com",
      "WWW_DOMAIN=website-stag.example.com",
      "TZ=Asia/Singapore",
      "",
    ].join("\n"),
  )
  assertEquals(fs.text("/app/.env.staging"), staging)
  assertEquals(fs.text("/app/.env.prod").includes("DOMAIN=example.com"), true)
})

Deno.test(
  "staging derivation does not clobber WWW_DOMAIN when only DOMAIN is rewritten",
  async () => {
    const fs = new FakeFileSystem()
    fs.seed("/app/.env.prod", "DOMAIN=example.com\nWWW_DOMAIN=www.example.com\n")

    const staging = await deriveStagingEnv({
      fs,
      prodPath: "/app/.env.prod",
      stagingPath: "/app/.env.staging",
      replacements: { DOMAIN: "website-stag.example.com" },
    })

    assertEquals(staging, "DOMAIN=website-stag.example.com\nWWW_DOMAIN=www.example.com\n")
  },
)

Deno.test("staging derivation fails when the production env has no such key", async () => {
  const fs = new FakeFileSystem()
  fs.seed("/app/.env.prod", "DOMAIN=example.com\n")
  await assertRejects(
    () =>
      deriveStagingEnv({
        fs,
        prodPath: "/app/.env.prod",
        stagingPath: "/app/.env.staging",
        replacements: { PROTOCOL: "https" },
      }),
    MissingEnvError,
    "no line for PROTOCOL",
  )
  assertEquals(fs.writes, [])
})

Deno.test("refuses a hostile stack directory name even when deployAs is benign", () => {
  // `deployAs` defaults to `name`, so a hostile name is refused by that check on
  // its own only if this case is pinned separately.
  assertThrows(
    () =>
      generateDeployScript([{ name: "$(echo PWNED-NAME >&2)", deployAs: "web" }], {
        containerPrefix: "hl",
      }),
    CommandError,
    "is not a docker project name",
  )
})

/**
 * Remove every quoted region from a shell script, leaving the **residue**: the
 * bare words a shell still parses as syntax.
 *
 * Configuration values may only ever appear inside a quoted region, so a value
 * found in the residue is executable text. The check is deliberately
 * configuration-independent — it inspects whatever `generateDeployScript`
 * produced, with no knowledge of which interpolation site put it there — so it
 * covers sites the author did not think to enumerate. The previous version of
 * this helper tracked quote state per needle instead, and was defeated by one
 * edit at a site (the `RESTARTING` marker) that its single sample configuration
 * never generated.
 *
 * `balanced` is false when the script ends inside a quote, which the caller must
 * treat as a failure: an unbalanced script makes everything after the stray quote
 * look "quoted" and would hide a leak. The previous version also skipped `\`-escaped
 * characters *outside* a quote, which is not a bash rule and desynchronised it.
 */
function stripQuotedRegions(script: string): { residue: string; balanced: boolean } {
  let residue = ""
  let quote: '"' | "'" | null = null
  for (let i = 0; i < script.length; i++) {
    const char = script[i]
    if (quote === null) {
      if (char === "'" || char === '"') {
        quote = char
        residue += " "
        continue
      }
      residue += char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    if (quote === '"' && char === "\\") i++
    // inside a quoted region: dropped, replaced by the separator written on open
  }
  return { residue, balanced: quote === null }
}

/** One configuration that reaches a branch of {@link generateDeployScript}. */
interface ScriptCase {
  /** Failure message label. */
  label: string
  /** Stacks to deploy. */
  stacks: readonly StackConfig[]
  /** Options for the generator. */
  options: DeployScriptOptions
}

/**
 * Every branch of the generator: the restart markers exist only when a stack
 * restarts, and the override block only when it is not disabled — so a single
 * sample configuration cannot be the whole inventory.
 */
const SCRIPT_CASES: readonly ScriptCase[] = [
  {
    label: "one stack, defaults",
    stacks: [{ name: "webq1" }],
    options: { containerPrefix: "hlq3" },
  },
  {
    label: "one stack, custom deployAs, compose file and env file",
    stacks: [{ name: "webq1", deployAs: "hlq2" }],
    options: { containerPrefix: "hlq3", envFiles: [".envq4"], composeFile: "composeq5.yml" },
  },
  {
    label: "two stacks, one restarting, no override",
    stacks: [{ name: "webq1", deployAs: "hlq2" }, { name: "apizq6" }],
    options: {
      containerPrefix: "hlq3",
      useOverride: false,
      restartStacks: new Set(["hlq2"]),
    },
  },
  {
    label: "both stacks restarting, override enabled",
    stacks: [{ name: "webq1", deployAs: "hlq2" }, { name: "apizq6" }],
    options: {
      containerPrefix: "hlq3",
      envFiles: [".envq4", ".env.root"],
      restartStacks: new Set(["hlq2", "apizq6"]),
    },
  },
]

/**
 * Every string the generator derives from a configuration.
 *
 * Asserting on the derived composites, not only on the raw values, is what makes
 * a forgotten `shellQuote` visible: an unquoted `echo RESTARTING:a:b` leaves
 * `RESTARTING:a:b` in the residue even though `a` alone might be too short to
 * search for.
 */
function configurationNeedles(testCase: ScriptCase): string[] {
  const envFiles = testCase.options.envFiles ?? [".env.root", ".env"]
  const composeFile = testCase.options.composeFile ?? "compose.yml"
  const needles: string[] = [testCase.options.containerPrefix, ...envFiles]

  for (const stack of testCase.stacks) {
    const deployAs = stack.deployAs ?? stack.name
    needles.push(
      stack.name,
      deployAs,
      `stacks/${stack.name}/${composeFile}`,
      `compose-override/${stack.name}.yml`,
      `DEPLOY_START:${stack.name}:${deployAs}`,
      `DEPLOY_SUCCESS:${stack.name}:${deployAs}`,
      `DEPLOY_FAILED:${stack.name}:${deployAs}`,
      `RESTARTING:${stack.name}:${deployAs}`,
      `RESTART_DONE:${stack.name}:${deployAs}`,
      `name=${testCase.options.containerPrefix}-${stack.name}`,
    )
  }

  return needles
}

Deno.test("no configuration value survives in a script's unquoted residue", () => {
  for (const testCase of SCRIPT_CASES) {
    const script = generateDeployScript(testCase.stacks, testCase.options)
    const { residue, balanced } = stripQuotedRegions(script)

    assertEquals(balanced, true, `${testCase.label}: the script must quote end to end`)
    for (const syntax of ["$(", "`", "${"]) {
      assertEquals(
        residue.includes(syntax),
        false,
        `${testCase.label}: ${syntax} survived outside a quoted region`,
      )
    }
    for (const needle of configurationNeedles(testCase)) {
      assertEquals(
        residue.includes(needle),
        false,
        `${testCase.label}: ${needle} is unquoted, so a shell would parse it`,
      )
    }
  }
})

Deno.test("quotes the restart markers, which only exist when a stack restarts", () => {
  // The site that defeated the previous helper: absent from a configuration with
  // no `restartStacks`, so its sample never inspected it.
  const script = generateDeployScript([{ name: "gatus", deployAs: "hl-gatus" }], {
    containerPrefix: "hl",
    restartStacks: new Set(["hl-gatus"]),
  })

  assertEquals(script.includes("echo 'RESTARTING:gatus:hl-gatus'"), true)
  assertEquals(script.includes("echo 'RESTART_DONE:gatus:hl-gatus'"), true)
  assertEquals(script.includes("echo RESTARTING:"), false)
  assertEquals(script.includes("echo RESTART_DONE:"), false)
})

Deno.test("quotes the expected project name into the stale-container message", () => {
  // The site the reviewer executed: `expected=${deployAs}` sat inside a
  // double-quoted echo, so the quoting layer was bypassed at exactly one place.
  const script = generateDeployScript([{ name: "web", deployAs: "hl-web" }], {
    containerPrefix: "hl",
  })
  assertEquals(script.includes(`expected="'hl-web'"`), true)
  assertEquals(script.includes("expected=${"), false)
})

Deno.test("allows key names that merely contain a bounded token", () => {
  assertNoSecretEnvKeys({
    MONKEY: "banana",
    AUTHOR: "anton",
    PUBKEY: "ssh-ed25519 AAAA",
    BYPASS_PROXY: "127.0.0.1",
    COMPASS: "north",
    TOKENIZER: "words",
  })
})

Deno.test("refuses a build id that looks like a credential unless the caller vouches", () => {
  // The trade-off is deliberate and pinned: a 40-character hex build id, and a
  // base64 public key, are refused by default because the value-shape pass cannot
  // tell them from a token. `allowEnvKeys` is the sanctioned answer.
  const sha = "0123456789abcdef0123456789abcdef01234567"
  assertThrows(
    () => assertNoSecretEnvKeys({ GIT_SHA: sha }),
    CommandError,
    "credential-shaped value",
  )
  assertNoSecretEnvKeys({ GIT_SHA: sha }, { allowEnvKeys: ["GIT_SHA"] })
})

/**
 * The token list, both directions.
 *
 * Both directions live in one test on purpose: tightening for a false positive
 * (adding a word boundary) is what opened the inflection hole that let
 * `GH_TOKENS` and `MY_SECRETS` reach the remote argv, so a test that only pins
 * the refusals would call that a pass.
 */
Deno.test("refuses credential-spellings including their inflections", () => {
  const refused = [
    // round-1 matrix
    "AWS_SECRET_ACCESS_KEY",
    "aws_secret_access_key",
    "GH_TOKEN",
    "APIKEY",
    "API_KEY",
    "API-KEY",
    "CREDENTIAL",
    "PRIVATE_KEY",
    "DB_PASS",
    "KEY_PASSPHRASE",
    "PASSCODE",
    "MYSQL_PWD",
    "AUTH",
    "BEARER",
    "JWT",
    "SESSION_KEY",
    "AWS_ACCESS_KEY_ID",
    "KEY",
    // inflections the boundary tightening broke
    "GH_TOKENS",
    "MY_SECRETS",
    "SECRETS",
    "AUTHORIZATION",
    "API_KEYS",
    "SESSIONS",
    "PASSES",
    "PWD",
  ]

  for (const key of refused) {
    assertThrows(
      () => assertNoSecretEnvKeys({ [key]: "short" }),
      CommandError,
      undefined,
      `${key} must be refused`,
    )
  }
})

Deno.test("allows names that merely contain a credential word inside another", () => {
  const allowed = [
    "MONKEY",
    "AUTHOR",
    "AUTHORED_BY",
    "PUBKEY",
    "BYPASS_PROXY",
    "COMPASS",
    "TOKENIZER",
    "KEYSTONE",
    "SESSIONLESS",
  ]

  for (const key of allowed) {
    assertNoSecretEnvKeys({ [key]: "value" })
  }
})

Deno.test("cannot vouch for a key that names itself a credential", () => {
  // `allowEnvKeys` lifts the value-shape rule, not the key-shape rule, so it
  // cannot be turned into a blank cheque for `DB_PASS`.
  assertThrows(
    () => assertNoSecretEnvKeys({ DB_PASS: "short" }, { allowEnvKeys: ["DB_PASS"] }),
    CommandError,
    "looks like a secret",
  )
})

/** Key spellings that leaked through the first version of the guard (reviewer's matrix). */
const LEAKY_KEYS: readonly string[] = [
  "API-KEY",
  "DB_PASS",
  "KEY_PASSPHRASE",
  "PASSCODE",
  "MYSQL_PWD",
  "AUTH",
  "BEARER",
  "JWT",
  "SESSION_KEY",
  "AWS_ACCESS_KEY_ID",
  "KEY",
]

Deno.test("refuses every key spelling from the leak matrix", () => {
  for (const key of LEAKY_KEYS) {
    assertThrows(
      () => assertNoSecretEnvKeys({ [key]: "x" }),
      CommandError,
      undefined,
      `${key} must be refused`,
    )
    assertThrows(
      () => buildComposeUpArgs({ ...TARGET, env: { [key]: "x" } }),
      CommandError,
      undefined,
      `${key} must not reach the remote argv`,
    )
  }
})

Deno.test("refuses a credential-shaped value under an innocuous key", () => {
  const values = [
    "postgres://deploy:hunter2@db.example/app",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0",
    "AKIAIOSFODNN7EXAMPLE",
    "a".repeat(64),
    "QWxhZGRpbjpvcGVuIHNlc2FtZQAAYmFzZTY0",
  ]
  for (const value of values) {
    assertThrows(
      () => assertNoSecretEnvKeys({ CONFIG_VALUE: value }),
      CommandError,
      "credential-shaped value",
      `value ${JSON.stringify(value)} must be refused whatever the key is called`,
    )
  }
})

Deno.test("allows an ordinary scalar env entry", () => {
  assertNoSecretEnvKeys({ PROJECT: "site-stag", REPLICAS: 2, DEBUG: true })
})

Deno.test(
  "allows a value that merely looks like a credential when the caller vouches for it",
  () => {
    const digest = "a".repeat(64)
    assertNoSecretEnvKeys({ IMAGE_DIGEST: digest }, { allowEnvKeys: ["IMAGE_DIGEST"] })
    assertThrows(
      () => assertNoSecretEnvKeys({ OTHER_DIGEST: digest }, { allowEnvKeys: ["IMAGE_DIGEST"] }),
      CommandError,
      "credential-shaped value",
    )
  },
)

Deno.test("refuses a non-scalar env value instead of shipping a stringified one", () => {
  assertThrows(
    () => assertNoSecretEnvKeys({ LIST: ["hunter2"] }),
    CommandError,
    "is not a scalar",
  )
  assertThrows(
    () => assertNoSecretEnvKeys({ CONFIG: { deep: { password: "hunter2" } } }),
    CommandError,
    "is not a scalar",
  )
})

Deno.test("refuses a blank env value that would silently drop configuration", () => {
  assertThrows(() => assertNoSecretEnvKeys({ PROJECT: "   " }), CommandError, "is blank")
})

Deno.test("reports a launch failure as a failed step instead of throwing", async () => {
  const runner = createFakeRunner().rejectWith(
    "NotFound: Failed to spawn 'rsync': entity not found",
  )
  const outcome = await runDeployPlan(buildDeployPlan({ target: TARGET }), { runner })

  assertEquals(outcome.success, false)
  assertEquals(outcome.steps.length, 1)
  assertEquals(outcome.steps[0].name, "sync-source")
  assertEquals(outcome.steps[0].success, false)
  assertEquals(outcome.steps[0].error, "Error: NotFound: Failed to spawn 'rsync': entity not found")
})

/** The reviewer of #50's payloads, plus the shapes a shell would also act on. */
const INJECTION_PAYLOADS: readonly string[] = [
  "$(echo PWNED-NAME >&2)",
  "`echo PWNED-BACKTICK`",
  'name" && echo PWNED-QUOTE && "',
  "name; echo PWNED-SEMI",
  "name with a space",
  "name >/tmp/pwned",
  "name${IFS}x",
]

Deno.test("refuses a stack name that bash would execute", () => {
  for (const payload of INJECTION_PAYLOADS) {
    assertThrows(
      () => generateDeployScript([{ name: payload }], { containerPrefix: "hl" }),
      CommandError,
      undefined,
      `stack name ${JSON.stringify(payload)} must be refused, not quoted and run`,
    )
  }
})

Deno.test("refuses an injection payload in every value the script interpolates", () => {
  const payload = "$(echo PWNED >&2)"
  const stacks: readonly StackConfig[] = [{ name: "web" }]

  assertThrows(
    () => generateDeployScript(stacks, { containerPrefix: payload }),
    CommandError,
    undefined,
    "containerPrefix",
  )
  assertThrows(
    () => generateDeployScript([{ name: "web", deployAs: payload }], { containerPrefix: "hl" }),
    CommandError,
    undefined,
    "deployAs",
  )
  assertThrows(
    () => generateDeployScript(stacks, { containerPrefix: "hl", envFiles: [payload] }),
    CommandError,
    undefined,
    "envFiles",
  )
  assertThrows(
    () => generateDeployScript(stacks, { containerPrefix: "hl", composeFile: payload }),
    CommandError,
    undefined,
    "composeFile",
  )
})

Deno.test("refuses an env file that escapes the app directory", () => {
  assertThrows(
    () =>
      generateDeployScript([{ name: "web" }], { containerPrefix: "hl", envFiles: ["../../etc/x"] }),
    CommandError,
    'must not contain a ".." segment',
  )
})

Deno.test("does not generate any script text from a refused value", () => {
  // The property the reviewer measured: with the payload in a stack name the
  // generated script *ran* it and still reported DEPLOY_SUCCESS. Refusal happens
  // before a single line is built, so there is nothing to run.
  assertThrows(
    () => generateDeployScript([{ name: "$(echo PWNED-NAME >&2)" }], { containerPrefix: "hl" }),
    CommandError,
  )
})

Deno.test("single-quotes a value that reaches the script, escaping an embedded quote", () => {
  assertEquals(shellQuote("$(echo PWNED)"), "'$(echo PWNED)'")
  assertEquals(shellQuote("it's"), "'it'\\''s'")
  assertEquals(shellQuote("plain-path/.env"), "'plain-path/.env'")
})

Deno.test("quotes every interpolated value in a benign script", () => {
  const script = generateDeployScript([{ name: "web", deployAs: "hl-web" }], {
    containerPrefix: "hl",
    envFiles: [".env.prod"],
  })
  assertEquals(script.includes("-p 'hl-web'"), true)
  assertEquals(script.includes(`-f "$app"/'stacks/web/compose.yml'`), true)
  assertEquals(script.includes(`--env-file "$app"/'.env.prod'`), true)
  assertEquals(script.includes(`echo 'DEPLOY_START:web:hl-web'`), true)
  assertEquals(script.includes(`--filter 'name=hl-web'`), true)
})

const STACKS: readonly StackConfig[] = [
  { name: "traefik" },
  { name: "gatus", deployAs: "hl-gatus" },
]

Deno.test("generates a marker-delimited script that takes the app directory as an argument", () => {
  const script = generateDeployScript(STACKS, { containerPrefix: "hl" })
  assertEquals(script.includes("DEPLOY_START:traefik:traefik"), true)
  assertEquals(script.includes("DEPLOY_SUCCESS:gatus:hl-gatus"), true)
  assertEquals(script.includes("DEPLOY_FAILED:gatus:hl-gatus"), true)
  assertEquals(script.includes(`app="$1"`), true)
  assertEquals(script.includes("/opt/apps"), false)
})

Deno.test("cleans up a stale container left by another compose project", () => {
  const script = generateDeployScript([{ name: "traefik" }], { containerPrefix: "hl" })
  assertEquals(script.includes(`--filter 'name=hl-traefik'`), true)
  assertEquals(script.includes(`if [ "$project" != 'traefik' ]`), true)
  assertEquals(script.includes(`docker rm -f "$id"`), true)
})

Deno.test("uses the caller's container prefix rather than a hardcoded one", () => {
  const script = generateDeployScript([{ name: "api" }], { containerPrefix: "acme" })
  assertEquals(script.includes("acme-api"), true)
  assertEquals(script.includes("hl-api"), false)
})

Deno.test("adds a restart block only for the named stacks", () => {
  const script = generateDeployScript(STACKS, {
    containerPrefix: "hl",
    restartStacks: new Set(["hl-gatus"]),
  })
  assertEquals(script.includes("echo 'RESTARTING:gatus:hl-gatus'"), true)
  assertEquals(script.includes("RESTARTING:traefik:traefik"), false)
})

Deno.test("adds the compose override only when it exists on the remote", () => {
  const script = generateDeployScript([{ name: "traefik" }], { containerPrefix: "hl" })
  assertEquals(
    script.includes(`if [ -f "$app"/'compose-override/traefik.yml' ]; then`),
    true,
  )
})

Deno.test("runs the script through bash -s with the app directory as $1", async () => {
  const runner = createFakeRunner(() => ({
    success: true,
    output: [
      "DEPLOY_START:traefik:traefik",
      "DEPLOY_SUCCESS:traefik:traefik",
      "DEPLOY_START:gatus:hl-gatus",
      "no such image",
      "DEPLOY_FAILED:gatus:hl-gatus",
      "",
    ].join("\n"),
    error: "",
  }))
  const script = generateDeployScript(STACKS, { containerPrefix: "hl" })

  const run = await runDeployScript({ runner }, script, "/opt/apps", STACKS)

  assertEquals(runner.argvOf(0), ["bash", "-s", "--", "/opt/apps"])
  assertEquals(runner.calls[0].options.stdin, script)
  assertEquals(run.results, [
    { name: "traefik", deployAs: "traefik", success: true },
    { name: "gatus", deployAs: "hl-gatus", success: false, error: "no such image" },
  ])
})

Deno.test("rejects a blank app directory for the deploy script", async () => {
  await assertRejects(
    () => runDeployScript({ runner: createFakeRunner() }, "echo hi\n", "  ", STACKS),
    CommandError,
    "app directory must not be blank",
  )
})

Deno.test("parses per-stack results from the markers", () => {
  const output = [
    "DEPLOY_START:traefik:traefik",
    "some build output",
    "DEPLOY_SUCCESS:traefik:traefik",
    "DEPLOY_START:gatus:hl-gatus",
    "error: no such image",
    "DEPLOY_FAILED:gatus:hl-gatus",
  ].join("\n")

  assertEquals(parseDeployResults(output, STACKS), [
    { name: "traefik", deployAs: "traefik", success: true },
    { name: "gatus", deployAs: "hl-gatus", success: false, error: "error: no such image" },
  ])
})

Deno.test("treats a stack with no markers at all as failed", () => {
  const results = parseDeployResults("bash: line 3: docker: command not found\n", STACKS)
  assertEquals(results.map((result) => result.success), [false, false])
  assertEquals(results[0].error, "bash: line 3: docker: command not found")
})

Deno.test("extracts volume paths with the nested variables substituted", () => {
  const paths = extractVolumePaths(
    [
      "services:\n  app:\n    volumes:\n      - ${VOLUMES_PATH}/gatus/data:/data\n",
      "services:\n  app:\n    volumes:\n      - ${VOLUMES_PATH}/${SERVER_NAME}/media:/media\n",
    ],
    createEnvReader({ VOLUMES_PATH: "/srv/volumes", SERVER_NAME: "cloud" }),
  )
  assertEquals(paths, ["/srv/volumes/gatus/data", "/srv/volumes/cloud/media"])
})

Deno.test("extracts each volume path once", () => {
  const content = "a: ${VOLUMES_PATH}/gatus/data:/data\nb: ${VOLUMES_PATH}/gatus/data:/other\n"
  assertEquals(
    extractVolumePaths([content], createEnvReader({ VOLUMES_PATH: "/srv" })),
    ["/srv/gatus/data"],
  )
})

Deno.test("ignores named volumes and relative bind mounts", () => {
  const content = "volumes:\n  - config:/etc/app\n  - ./local:/local\n"
  assertEquals(extractVolumePaths([content], createEnvReader({ VOLUMES_PATH: "/srv" })), [])
})

Deno.test("throws when VOLUMES_PATH is unset instead of creating a literal directory", () => {
  assertThrows(
    () => extractVolumePaths(["x: ${VOLUMES_PATH}/gatus/data:/data\n"], createEnvReader({})),
    MissingEnvError,
    "VOLUMES_PATH",
  )
})

Deno.test("throws when a nested volume variable is unknown", () => {
  assertThrows(
    () =>
      extractVolumePaths(
        ["x: ${VOLUMES_PATH}/${UNKNOWN}/data:/data\n"],
        createEnvReader({ VOLUMES_PATH: "/srv" }),
      ),
    MissingEnvError,
    "UNKNOWN",
  )
})

Deno.test("hashes only remote files that answer with a sha256 digest", async () => {
  const digest = "a".repeat(64)
  const runner = new FakeCommandRunner()
  runner.respond({ success: true, output: `${digest}  /opt/apps/config/gatus.yml\n` })
  runner.respond({ success: false, error: "No such file or directory\n" })
  runner.respond({ success: true, output: "not-a-digest  /opt/apps/nope\n" })

  const checksums = await getRemoteChecksums({
    runner,
    sshAddress: "deploy@host.example",
    remotePath: "~/cloudlab/apps/",
    files: ["config/gatus.yml", "config/missing.yml", "nope"],
  })

  assertEquals([...checksums.entries()], [["config/gatus.yml", digest]])
  assertEquals(runner.argvOf(0), [
    "ssh",
    "--",
    "deploy@host.example",
    "sha256sum",
    "~/cloudlab/apps/config/gatus.yml",
  ])
})

Deno.test("rejects a remote config path the remote shell would execute", async () => {
  await assertRejects(
    () =>
      getRemoteChecksums({
        runner: createFakeRunner(),
        sshAddress: "deploy@host.example",
        remotePath: "~/cloudlab/apps",
        files: ["config; rm -rf /"],
      }),
    CommandError,
    "remote shell would execute",
  )
})

Deno.test("does not trust a digest printed by a command that failed", async () => {
  const digest = "b".repeat(64)
  const runner = createFakeRunner(() => ({
    success: false,
    output: `${digest}  /opt/apps/x\n`,
    error: "",
  }))

  const checksums = await getRemoteChecksums({
    runner,
    sshAddress: "deploy@host.example",
    remotePath: "~/cloudlab/apps",
    files: ["config/gatus.yml"],
  })

  assertEquals([...checksums.entries()], [])
})
