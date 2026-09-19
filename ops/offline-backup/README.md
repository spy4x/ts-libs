# `@ts-libs/ops/offline-backup`

External-drive cold backup mechanics, extracted from `rostok/scripts/offline-backup`
(1,556 LOC of source, one of the largest assets in that repository).

Ported: drive listing, mount/unmount/eject/format, the backup directory structure,
rsync sync with deleted-repository detection and progress reporting, SMART self-test
polling plus size verification, the drive README writer, `formatBytes`.

## Ports

Every external effect goes through an injected port, because the workspace test task
grants only `--allow-read` and `--allow-env`:

```ts
interface OfflineBackupPorts {
  runner: CommandRunner // every external process; argv arrays, never a shell string
  fs: FileSystem // every read and write
  logger: Logger // the package's one logging convention (../console.ts)
  env?: EnvReader // environment values, read through a reader and never at module scope
  sleep?: SleepFn // `formatDrive` waits for udev; `runSmartCheck` polls
  confirm?: ConfirmFn // every yes/no question; absent means non-interactive
  clock?: Clock // every timestamp
}
```

`confirm` is optional on purpose: a non-interactive run is a supported state, and a
workflow that needs an answer it cannot get raises `ConfirmRequiredError` instead of
blocking on a terminal that is not there.

## Fixes made at extraction time

| Source                                          | Symptom                                                                                                                                                                                                   | Fix                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `drive.ts:39-52`                                | `line.split(" ")` + `parts.indexOf("on")` truncates a mount point containing a space — `/run/media/user/My Passport` became `/run/media/user/My`, and the caller then acted on a directory it never named | `parseMountOutput` splits on the `on` separator and the following `type` column                                      |
| `drive.ts:25-32`                                | `checkDriveExists` took a bare kernel name and prefixed `/dev/` itself, while callers built `${device}1` by hand — the two drifted                                                                        | takes a device path, with `devDir` as an explicit option                                                             |
| `drive.ts:142`                                  | an unconditional 2-second sleep after `parted`                                                                                                                                                            | `sleep` port, so a test does not wait and a caller can tune it                                                       |
| `drive.ts:163`                                  | `chown -R <current user>` on the mount point (`["chown", "-R", username, mountPoint]`), derived from the environment                                                                                      | no `chown` at all unless the caller names an owner                                                                   |
| `drive.ts:83`, `helpers.ts:181`, `sync.ts:8,54` | `Deno.env.get("HOME")` read at call time, with `"~"` as a fallback that produces a literal `~` path                                                                                                       | the home directory is an explicit value; `absPath` refuses to expand without one                                     |
| `sync.ts:93`                                    | `line.match(/([\d.]+[KMGT]?)/)` takes the first numeric token of a progress line instead of a named column — a comma-truncated fragment on a byte column, the percentage on a size-less line              | `parseRsyncProgress` reads the size and speed columns, with a test pinning that the percentage is not read as a size |
| `helpers.ts:5-44`                               | `ConsoleLogger` captured logs by replacing the global `console` methods                                                                                                                                   | not ported; `Logger.records()` from `../console.ts` is the single convention                                         |
| `verify.ts:97`                                  | `RESTIC_PASSWORD` was written into `Deno.env` for the whole process, cached and restored afterwards                                                                                                       | passed as the child's environment only — never argv, which is what the process table shows                           |

## Not ported

- The CLI entry point (`+main.ts`): `Deno.args` parsing, terminal bells, `Deno.exit`,
  a `/tmp` log fallback. A caller owns its CLI.
- `preSudo`: the source relied on `sudo` reading a password from an inherited
  terminal, so a run without a TTY could hang. A caller warms the sudo credential
  cache itself.
- The `create`/`restore`/`verify` workflow orchestration: it is a runner's control
  flow, not a library's, and the CLI it serves lives in `@rostok/cli`.
