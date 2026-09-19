# @ts-libs/media

ffprobe/ffmpeg wrappers, a video-agnostic SSE progress broker, and LRC → ID3 SYLT conversion.
Extracted from `roley`'s `src/lib/server/video-processing/` and `imagesUtils.ts`, and from
`lyrics-populator`'s `src/metadata.ts`. Framework-agnostic: no Hono, no DOM, no database.

Dependencies: `@std/path` and nothing else. Every process goes through an injected port, which is
why the suite runs under `deno test --allow-read --allow-env` with no `--allow-run`.

## Module map

| Entry point         | Exports                                                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ts-libs/media`    | barrel — everything below                                                                                                                                                                       |
| `./process-runner`  | `ProcessRunner`, `ProcessOutput`, `ProcessLineHandlers`, `MediaDeps`, `ProcessExecutionError`, `assertUsablePath`, `createLineSplitter`, `denoCommandRunner`, `FFMPEG_BINARY`, `FFPROBE_BINARY` |
| `./ffprobe`         | `getMeta`, `getDuration`, `getAudioDuration`, `getImageDimensions`, `asMp4Path`, `isMp4Path`, `isMp4Format`, `Mp4Path`, ffprobe JSON types                                                      |
| `./ffmpeg`          | `makeThumbnail`, `buildThumbnailArgv`, `runWithProgress`, `DEFAULT_THUMBNAIL_AT_MS`                                                                                                             |
| `./progress-parse`  | `createFfmpegProgressParser`, `FfmpegProgressKind`, `clampPercent`, `parseOutTime`                                                                                                              |
| `./progress-broker` | `SseProgressBroker`, `ProgressJobId`, subscription and publish option types                                                                                                                     |
| `./sse-frame`       | `formatSseFrame`, `SseFrame`                                                                                                                                                                    |
| `./timers`          | `Timers`, `systemTimers`                                                                                                                                                                        |
| `./duration`        | `parseDurationMs`, `formatDurationParam`, `getTrueResolution`                                                                                                                                   |
| `./lrc-sylt`        | `parseLrcToSylt`, `SyltTimestampFormat`, `SyltTag`, `SyltEntry`                                                                                                                                 |
| `./atomic-rewrite`  | `withAtomicRewrite`, `tempSiblingPath`, `sizeDeltaBounds`, `verdictSizeDelta`, `RewriteFileSystem`, `denoFileSystem`                                                                            |
| `./binary-lookup`   | `createBinaryFinder`, `findFfmpeg`, `BinaryFinderDeps`, `EnvironmentReader`                                                                                                                     |

`test-doubles.ts` holds the fakes, beside the colocated `*.test.ts` files. Neither is an export entry
point, and neither is published: a `deno publish` manifest lists every file in the package directory,
so `media/deno.json` excludes them through `publish.exclude`. Verified — `deno publish --dry-run`
lists the media manifest as exactly the modules in the export table, with no `*.test.ts` and no
`test-doubles.ts`.

## External binary contract

**The library bundles no binaries and installs none.** A caller must provide both, on `PATH` or by
absolute path:

| Binary    | Used for                                                           | Verified against |
| --------- | ------------------------------------------------------------------ | ---------------- |
| `ffprobe` | `getMeta`, `getDuration`, `getAudioDuration`, `getImageDimensions` | 8.1.2            |
| `ffmpeg`  | `makeThumbnail`, `runWithProgress`                                 | 8.1.2            |

Options relied on: ffprobe's `-show_format`, `-show_streams`, `-print_format json`,
`-select_streams`, `-read_intervals`, `-of compact`, and ffmpeg's `-progress pipe:1`, `-ss`,
`-vframes`, plus the webp encoder the output extension selects. All of these predate ffmpeg 3.x;
8.1.2 is what this package is tested against and what the fixtures in the progress tests were
captured from. No minimum version is enforced at runtime — a missing binary surfaces as the
spawn error of the injected runner, and `findFfmpeg` reports what it probed.

`cwebp` is **not** a dependency. The source's `imagesUtils.toWebp` shelled out to it, but that path
is storage-coupled and was not ported; thumbnails use ffmpeg's webp encoder instead.

## Wiring: the injectable runner

`ProcessRunner` is the only way this package touches a process. `argv` is always a string array —
never a shell string — and `denoCommandRunner` spawns with `stdin: "null"` so a child can never
block on a prompt.

argv removes shell interpretation but **not option parsing**: ffmpeg and ffprobe parse their own
argument list, so a path beginning with `-` can reach them as a flag. Every caller-supplied path
(`getMeta`, `getDuration`, `getAudioDuration`, `getImageDimensions`, `makeThumbnail`'s input and
output) is therefore checked by `assertUsablePath` before argv is built, and a dash-leading or
NUL-bearing path throws a `TypeError` naming the path — before any process is created.

The slots are not equally exposed, measured on ffmpeg/ffprobe 8.1.2:

- **Load-bearing:** the thumbnail **output**, and `getAudioDuration`'s trailing slot. `output:
  "-y.webp"` made ffmpeg answer `Unrecognized option 'y.webp'` with exit 8 instead of writing a file,
  and `getAudioDuration("-read_intervals")` made ffprobe answer exit 1, `Missing argument for option
  'read_intervals'`. A caller-supplied path was a command-line flag in both.
- **Defence in depth:** the thumbnail **input**. ffmpeg consumes the token after `-i` as a filename
  whatever it starts with — `-i -y.webp` exits 254, `Error opening input file -y.webp` — so that
  guard is not the live injection vector. It stays, because a filename ffmpeg will never open deserves
  the caller's own diagnostic rather than an exit code.
- **Neither, and not the binary's business:** a NUL byte. `Deno.Command` throws its own
  `nul byte found in provided data` from inside the spawn, naming neither the argument nor the caller,
  so the check keeps the failure in this package.

The guard is an **option-injection** check only. It is not path confinement: an absolute path, a
symlink out of the working directory or `/etc/passwd` all pass, and is meant to — this is a library,
the caller owns its own confinement, and `argv` is never a shell string.

```ts
import { denoCommandRunner, findFfmpeg, getMeta } from "@ts-libs/media"

const deps = { runner: denoCommandRunner }
const meta = await getMeta("/srv/media/clip.mp4", deps)

// Resolve ffmpeg once at start-up; every later call reads the locator's cache.
const ffmpeg = findFfmpeg({ runner: denoCommandRunner })
const ffmpegPath = await ffmpeg()
```

Point every wrapper at the located path so a non-`PATH` install works:

```ts
await makeThumbnail({ input, output: "/srv/thumbs/clip.webp" }, { runner, ffmpegPath })
```

`MediaDeps` is `{ runner, ffmpegPath?, ffprobePath? }`; both paths default to the bare binary name.

### Tests never shell out

Every wrapper test passes `FakeProcessRunner` from `test-doubles.ts`, which answers with canned
ffprobe JSON, canned progress lines and canned exit codes. `findFfmpeg`'s environment is a plain
record, the broker's timers are `FakeTimers`, and the rewrite port is `FakeFileSystem`. The suite
therefore passes with `PATH=/nonexistent`, which is the check that proves it cannot depend on a
binary being installed:

```sh
PATH=/nonexistent deno task test   # exit 0
```

Spawn-freeness is asserted, not assumed: the path-guard tests require
`runner.callCount === 0`, so `assertUsablePath` is proven to reject before a process exists rather
than being caught afterwards by ffmpeg's own exit code.

## `getDuration` is mp4-only, and the type system says so

`getDuration` needs `Mp4Path`, a branded string that only `asMp4Path` produces. `asMp4Path` rejects
anything without an `.mp4` extension, and `getDuration` additionally checks ffprobe's own
`format_name`, so a renamed container is refused too. Passing a webm path is a compile error rather
than the runtime throw the extracted source relied on:

```ts
await getDuration("/tmp/clip.webm", deps)
// error: Argument of type 'string' is not assignable to parameter of type 'Mp4Path'.
```

`getMeta` reports the container it found; `isMp4Format(meta.format)` is the bridge from that answer
to a brandable path.

`getMeta` returns `durationMs: 0` in two different situations, and neither means "ffprobe had
nothing to say":

- **Still images** (`image2`, `png_pipe`, `jpg_pipe`, `webp_pipe`) have no duration to report, so `0`
  means "not applicable". The source only skipped `png_pipe` and `jpg_pipe`, but a real `.jpg` file
  is probed as `image2` and a real `.webp` as `webp_pipe`, so those files used to throw
  `"duration could not be detected"` instead.
- **`webm`** does have a duration, and `0` is policy rather than a limitation. ffprobe reports it
  correctly for a finished webm (measured: `format.duration = 3.008000` on ffmpeg 8.1.2), but a webm
  written by a live muxer — MediaRecorder, a streaming encoder — has no `Duration` element in its
  Segment Info, and the value ffprobe then derives from the last cluster can be badly off. The
  source's contract, kept here, is to convert to mp4 and measure with `getDuration`, so `0` never
  means "a duration that may be wrong". The cost is a mandatory conversion even when the reported
  duration was fine — call `getDuration(asMp4Path(pathAfterConversion), deps)` at that point.

`getDuration` itself is unaffected: it reads `format.duration` for an mp4 through the same
`parseDurationMs`, so a six-digit, three-digit or absent fraction all land in whole milliseconds.

## Progress: parse, then report

`createFfmpegProgressParser` turns ffmpeg's `-progress` key/value stream into typed events, one per
block, where a block ends at `progress=continue` or `progress=end`. Unmodelled keys survive in
`event.raw`. `runWithProgress` pipes a real run through it and requires the caller's argv to contain
`-progress pipe:1` — the flag has to sit among the caller's own options, so the wrapper refuses an
argv that does not ask for progress instead of silently reporting nothing.

`percent` is `outTimeMs / totalDurationMs`, clamped to `0..100`, and `null` while the total is
unknown. ffmpeg's `out_time_ms` field is **microseconds**, despite its name: ffmpeg writes the same
`int64` into `out_time_us` and `out_time_ms` (verified against ffmpeg 8.1.2, which prints
`out_time_us=800000` and `out_time_ms=800000` for the same 0.8 s position). The parser reads
`out_time_us` first and treats `out_time_ms` the same way; the `out_time` timestamp is the fallback.

```ts
const result = await runWithProgress({
  argv: ["ffmpeg", "-i", input, "-progress", "pipe:1", "-f", "null", "-"],
  totalDurationMs: meta.durationMs,
  onProgress: (event) => event.percent !== null && render(event.percent),
}, deps)
```

## SSE broker contract

`SseProgressBroker<Payload>` maps a job id (any `string | number`) to a set of subscribers and gives
each one a `ReadableStream<Uint8Array>` of `text/event-stream` frames. It knows nothing about media:
the payload is the caller's generic, and the module imports only the timer port. The caller owns the
response headers and the `Content-Type`.

| Call                                 | Effect                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------- |
| `subscribe(jobId, options?)`         | Registers a subscriber; replays the job's last payload unless `replayLatest: false` |
| `publish(jobId, payload, options?)`  | Sends one frame to every subscriber; a job with none is a no-op                     |
| `complete(jobId, { payload? })`      | Optional final payload, then a `complete` event, then end-of-stream                 |
| `fail(jobId, error)`                 | An `error` frame carrying the message, then end-of-stream                           |
| `subscriberCount(jobId)`, `jobCount` | Live subscriber and job counts, for leak assertions                                 |
| `latestOf(jobId)`                    | Last payload of a live job                                                          |

Frames: event names are `progress`, `complete` and `error` by default. Payloads are JSON, and a
payload containing newlines is split into one `data:` line per line, so it cannot terminate the
frame early.

A subscriber is removed — and the job forgotten once its last subscriber leaves — when:

- its stream is cancelled (`stream.cancel()`),
- an `AbortSignal` passed in `options.signal` aborts (the listener is detached again; the source
  had that listener commented out and leaked a controller per dropped connection),
- `complete` or `fail` runs for the job,
- its `timeoutMs` elapses without a completion: the subscriber gets an `error` frame and
  end-of-stream rather than a socket held open forever,
- an enqueue finds the stream already closed.

Failures are delivered **in band**, as an `error` frame followed by end-of-stream, not through
`controller.error()`: to a browser `EventSource` an errored body is indistinguishable from a dropped
connection, and it would reconnect to a job that is already dead. Non-negotiable parts of the
contract: a payload's newlines never break the framing, and a subscriber is never retained after it
is gone.

## What is deliberately not ported

| Left behind                                                            | Why                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roley/.../video-processing/movies/*` (614 LOC)                        | Shells out to five precompiled binaries that are not in any repository: `merge`, `starting-credits`, `ending-credits`, `trailer-merge`, `animation`. Unversioned, undocumented, unavailable — a hard portability wall.                                                                                              |
| `clip.ts`, `movie.ts`, `intro.ts`, `index.ts`, `queue.ts`              | Domain-coupled to roley's database and job statuses.                                                                                                                                                                                                                                                                |
| `processConcatenation`, `purgeFolder`, storage upload/download helpers | Pipeline, not primitives. `purgeFolder` was `rm -rf /tmp/videos` through a shell; `processConcatenation` named a log directory after a full object path.                                                                                                                                                            |
| `imagesUtils.toWebp`                                                   | Storage-coupled (`storage.download`, `storage.upload`) and depended on the `cwebp` binary.                                                                                                                                                                                                                          |
| `subtitles_logo.png` and every other asset                             | Assets do not belong in a library.                                                                                                                                                                                                                                                                                  |
| `lyrics-populator`'s `vorbis-scan.ts` / `vorbis-writer.ts` (436 LOC)   | Opus-only in practice with no FLAC support despite the allowlist, and `packOggPage` writes a comment body's segment-table length into one byte with no guard, so a body ≥ 65,025 B produces a page whose header contradicts its layout. Silent corruption; the `withAtomicRewrite` idea is kept, the writer is not. |

## Tests

Colocated `*.test.ts`, behaviour-named, deterministic: injected runner, injected timers, injected
`PATH`, injected filesystem, no sleeps, no real processes, no real binaries. `denoCommandRunner`
itself is the one uncovered module — exercising it needs `--allow-run`, which the repository test
task deliberately does not grant.
