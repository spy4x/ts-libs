# Testing ts-libs

Three tiers. They differ in what they may touch, not in how carefully they are written. The file
name alone puts a test in a tier.

|              | Unit                       | Integration                                                    | vips                                                        |
| ------------ | -------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| File name    | `*.test.ts`                | `*.integration.test.ts`                                        | `*.vips.test.ts`                                            |
| Task         | `deno task test`           | `deno task test:integration`                                   | `deno task test:vips`                                       |
| Talks to     | fakes only                 | Postgres, MinIO, Garage, Mailpit, Redis x2, Radicale, Stalwart | the `vips` and `exiftool` programs                          |
| Permissions  | `--allow-read --allow-env` | the unit grants, `--allow-net` and `--allow-write=.volumes`    | the unit grants, `--allow-write=.volumes` and `--allow-run` |
| Needs Docker | no                         | yes                                                            | no, but the programs (below)                                |

`deno task check` runs the unit tier and formats, lints and type-checks every tier. A plain
`deno test` runs the unit tier only: the root `test.exclude` leaves the other two out.

## Running the integration tier

```bash
deno task services:up          # the eight services; returns when all are healthy
deno task test:integration
deno task services:down        # stops them and drops their volumes
```

`infra/compose.integration.yml` defines the containers under the compose project `ts-libs-it`.
Every port is bound to `127.0.0.1`, in the 5xxxx range.

## Writing an integration test

Import the harness from `@integration-testing` (`infra/testing/`, which is not published):

```ts
import { postgresSettings, requireReachable, uniqueIdentifier } from "@integration-testing"

const settings = postgresSettings()
await requireReachable(settings.address) // fails loudly when the container is not there
const schema = uniqueIdentifier("it_db") // unique per run
```

Three rules, because several worktrees share the same containers:

- **Fail loudly, never skip.** Call `requireReachable` before touching a service. No `ignore`, no
  early `return`, no `try`/`catch` that turns a missing container into a pass.
- **Isolate every global name.** Take a fresh suffix (`uniqueIdentifier`, `uniqueKeyPrefix`,
  `uniqueRecipient`) for every schema, object key and mail recipient. Never truncate a shared table
  or empty the mailbox.
- **Clean up in a `finally`**, also when the test failed: drop your schema, delete your objects,
  mail and prefixed Redis keys. Never `FLUSHDB` or `FLUSHALL`.

A test that needs a real folder calls `createScratchFolder(prefix)`, which creates
`.volumes/it/<prefix>_<suffix>` inside the tier's write grant, and `removeScratchFolder(path)` in
its `finally`. `Deno.makeTempDir()` is refused: it writes outside `.volumes`.

Addresses come from one environment variable each, defaulting to the compose file; CI sets them
to the Woodpecker service names:

```
TS_LIBS_IT_POSTGRES_URL          postgres://…@127.0.0.1:55432/…
TS_LIBS_IT_S3_ENDPOINT           http://127.0.0.1:59000
TS_LIBS_IT_S3_ACCESS_KEY_ID      integration-test-only
TS_LIBS_IT_S3_SECRET_ACCESS_KEY  integration-test-only
TS_LIBS_IT_S3_BUCKET             ts-libs-integration
TS_LIBS_IT_S3_REGION             us-east-1
TS_LIBS_IT_GARAGE_ENDPOINT       http://127.0.0.1:53900   (key and bucket fixed, see the harness)
TS_LIBS_IT_SMTP_HOST             127.0.0.1
TS_LIBS_IT_SMTP_PORT             51025
TS_LIBS_IT_MAILPIT_URL           http://127.0.0.1:58025
TS_LIBS_IT_REDIS_HOST            127.0.0.1
TS_LIBS_IT_REDIS_PORT            56379
TS_LIBS_IT_REDIS_AUTH_HOST       127.0.0.1   (the Redis started with a password)
TS_LIBS_IT_REDIS_AUTH_PORT       56380
TS_LIBS_IT_RADICALE_URL          http://127.0.0.1:55232
TS_LIBS_IT_STALWART_URL          http://127.0.0.1:58080   (JMAP admin and DAV)
```

Every container that takes a credential uses `integration-test-only` as user, password and
database name; the second Redis (`redis-auth`) uses it as its password. It is the one
credential-shaped string this repository commits: throw-away data, loopback only, and unmistakable
in a log.

## The vips tier

`@spy4x/server/images` runs the `vips` command line. CI's `vips` step installs the programs into
the Deno image; locally, run the tier in the same image:

```bash
podman run --rm --name ts-libs-vips --pids-limit=500 --memory=8g -v "$PWD:/w:Z" -w /w \
  denoland/deno:2.9.7 sh -c 'apt-get update -qq && apt-get install -y -qq --no-install-recommends \
  libvips-tools libheif-plugin-libde265 libheif-plugin-aomenc libheif-plugin-dav1d \
  libheif-plugin-x265 libimage-exiftool-perl >/dev/null && deno task test:vips'
```
