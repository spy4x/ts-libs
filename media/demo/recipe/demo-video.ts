/**
 * Records and encodes the ts-libs demo video in `media/demo/`: a title card, three packages each
 * shown as a short file and its real output in a terminal, the `deno add` that installs them, and
 * an end card, with burned-in captions and quiet music. How to run it: `README.md` beside this file.
 *
 * `deno task demo-video` records the four terminal shots with vhs into `.take/` (gitignored), then
 * encodes. `deno task demo-video --encode` encodes the last take again, for a caption or music
 * change. The captions live in {@link SHOTS}; the encoder writes them to `captions.vtt` with the
 * times of the take and burns that same list into the picture.
 */

const HERE = new URL(".", import.meta.url).pathname
const DEMO = new URL("../", import.meta.url).pathname
const TAKE = `${HERE}.take/`
const FONT = `${HERE}fonts/ibm-plex-sans-latin-600-normal.woff2`
const FONT_REGULAR = `${HERE}fonts/ibm-plex-sans-latin-400-normal.woff2`
const MUSIC = `${DEMO}music.opus`

const WIDTH = 1280
const HEIGHT = 800
const FPS = 30
/** The caption band at the bottom: 84 px at 1280×800, Seed's band scaled by 2/3. */
const BAND = 84
const CAPTION_SIZE = 32
/** A caption stays at least this long, and long enough to read at this pace. */
const MIN_CAPTION_SECONDS = 2.5
const CHARS_PER_SECOND = 15
/** The longest caption that fits the band at a readable size, as the shared skill's encoder. */
const MAX_CAPTION_CHARS = 64
/** The site's colours: Ink (page), Parchment (text), Graphite (secondary text). */
const INK = "0x15120f"
const PARCHMENT = "0xefebe2"
const GRAPHITE = "0xbcb7af"
/** Integrated loudness the music is set to, the most the mix may reach, and the true-peak cap. */
const LOUDNESS = { target: -28, most: -27, peak: -1 }
/** No output file may be larger than this. */
const BUDGET = 3_000_000

const TITLE = {
  seconds: 2,
  name: "ts-libs",
  claim: ["Small TypeScript libraries on web standards,", "for the server and the browser."],
}
const END = { seconds: 2.5, url: "github.com/spy4x/ts-libs", sub: "jsr.io/@spy4x" }

/** How long a shot holds its final screen after the output appeared. */
const HOLD_MS = 4500

/** One terminal shot: a header, a command that shows the code, a command that runs it. */
interface Shot {
  /** The file name of the shot in `.take/`. */
  name: string
  /** The header line: step, package, what it is for. */
  header: [string, string, string]
  /** The folder of the staged home the shot runs in. */
  dir: string
  /** Typed first, then the shot holds while the viewer reads; omitted for the install shot. */
  show?: string
  /**
   * Typed second; the shot waits for `done` on screen, then holds {@link HOLD_MS}. A regular
   * expression for vhs, which ends it at the first `/`, so a slash is written as `.`.
   */
  run: string
  done: string
  /** The caption until the output appears, then the caption while the output is on screen. */
  captions: [string, string]
}

const SHOTS: Shot[] = [
  {
    name: "time",
    header: ["1/3", "@spy4x/time", "Dates and time zones"],
    dir: "my-app",
    show: "bat time.ts",
    run: "deno run time.ts",
    done: "Singapore +Thursday",
    captions: [
      "Show one meeting in each person's own time zone",
      "Real output, with no offset maths written by hand",
    ],
  },
  {
    name: "money",
    header: ["2/3", "@spy4x/platform", "Money in the smallest unit"],
    dir: "my-app",
    show: "bat money.ts",
    run: "deno run money.ts",
    done: "value: 1250",
    captions: [
      "Keep money in whole cents, never in a float",
      "Each currency's decimals, each language's marks",
    ],
  },
  {
    name: "signup",
    header: ["3/3", "@spy4x/validation", "Input checks with arktype"],
    dir: "my-app",
    show: "bat signup.ts",
    run: "deno run signup.ts",
    done: "at least 18",
    captions: [
      "Check what a user typed against a schema",
      "One plain message per field, ready for a form",
    ],
  },
  {
    name: "install",
    header: ["Get them", "jsr.io/@spy4x", "Add only what you need"],
    dir: "new-app",
    run: "deno add jsr:@spy4x/time jsr:@spy4x/platform jsr:@spy4x/validation",
    done: "Add jsr:@spy4x.validation",
    captions: [
      "Add only the packages you need, from JSR",
      "Small, typed and built on web standards",
    ],
  },
]

/** The packages the staged project installs before the shots, so every run prints only output. */
const PACKAGES = [
  "jsr:@spy4x/time",
  "jsr:@spy4x/platform",
  "jsr:@spy4x/validation",
  "npm:arktype@2",
]

/** Runs a command and fails with its error output; returns its standard output. */
async function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; seconds?: number } = {},
): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdin: "null",
    signal: AbortSignal.timeout((options.seconds ?? 120) * 1000),
  }).output()
  const text = new TextDecoder()
  if (!success) throw new Error(`${command} ${args.join(" ")} failed:\n${text.decode(stderr)}`)
  return text.decode(stdout) + text.decode(stderr)
}

/** Runs ffmpeg quietly. */
function ffmpeg(args: string[]): Promise<string> {
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { seconds: 600 })
}

/** The length of a media file in seconds. */
async function duration(file: string): Promise<number> {
  const out = await run("ffprobe", [
    ...["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
  ])
  const seconds = Number(out.trim())
  if (!seconds) throw new Error(`ffprobe could not read the length of ${file}`)
  return seconds
}

/** Integrated loudness (LUFS) and true peak (dBFS) of a file's sound, as EBU R 128 measures. */
async function loudness(file: string, filter = ""): Promise<{ integrated: number; peak: number }> {
  const text = await run("ffmpeg", [
    ...["-hide_banner", "-nostats", "-i", file, "-map", "0:a"],
    ...["-af", `${filter}${filter ? "," : ""}ebur128=peak=true`, "-f", "null", "-"],
  ], { seconds: 300 })
  const summary = text.slice(text.lastIndexOf("Summary:"))
  const integrated = summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]
  const peak = summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]
  if (!integrated || !peak) throw new Error(`ffmpeg could not measure ${file}:\n${text}`)
  return { integrated: Number(integrated), peak: Number(peak) }
}

/** The vhs settings every shot shares: the site's dark palette, Hack at 26 px, no window bar. */
const SETTINGS = `Set Shell "bash"
Set FontFamily "Hack"
Set FontSize 26
Set LineHeight 1.15
Set Width ${WIDTH}
Set Height ${HEIGHT}
Set Padding 32
Set Framerate ${FPS}
Set CursorBlink false
Set WindowBar ""
Set Theme { "name": "Desk", "background": "#15120f", "foreground": "#efebe2", "cursor": "#efebe2", "selection": "#2f2a26", "black": "#25211d", "red": "#f87e77", "green": "#83d494", "yellow": "#f5c26b", "blue": "#8ec5ec", "magenta": "#d4a5e8", "cyan": "#8fd3c8", "white": "#bcb7af", "brightBlack": "#857f79", "brightRed": "#f87e77", "brightGreen": "#83d494", "brightYellow": "#f5c26b", "brightBlue": "#8ec5ec", "brightMagenta": "#d4a5e8", "brightCyan": "#8fd3c8", "brightWhite": "#efebe2" }
`

/** How long each kind of screen holds, in seconds. */
const PAUSE = { header: 0.9, typed: 0.4, read: 4.5, hold: HOLD_MS / 1000 }

/** The time to the next key: a little uneven, slower after a space, the same on every run. */
function keyDelay(index: number, next: string): number {
  return next === " " ? 0.11 : [0.055, 0.07, 0.05, 0.065][index % 4]
}

/** `text` as a vhs regular expression that matches it literally; vhs ends one at a `/`. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("/", ".")
}

/** A shot's vhs tape, the screenshot it takes for each screen, and how long each screen holds. */
interface Plan {
  tape: string
  /** Seconds each screenshot is shown, in order: `0000.png` first. */
  seconds: number[]
  /** Seconds from the start of the shot to the output of the run command. */
  split: number
}

/**
 * Plans a shot as screenshots rather than vhs's own video: vhs drops frames on a busy machine and
 * the clip comes out shorter, while a screenshot taken once the screen shows the expected text,
 * held for a set time, gives the same clip on any machine. Every screenshot is the real terminal.
 */
function plan(shot: Shot): Plan {
  const quote = (word: string) => `'${word}'`
  const lines = [
    `Output "${shot.name}.mp4"`,
    SETTINGS,
    "Hide",
    `Type "source $DEMO_RC && cd ~/${shot.dir} && rule ${shot.header.map(quote).join(" ")}"`,
    "Enter",
    "Wait+Line@60s /^\\$$/",
    "Show",
  ]
  const seconds: number[] = []
  const snap = (hold: number) => {
    // A moment for the terminal to paint what the wait saw.
    lines.push(
      "Sleep 150ms",
      `Screenshot "${shot.name}/${String(seconds.length).padStart(4, "0")}.png"`,
    )
    seconds.push(hold)
  }
  const type = (command: string, then: number) => {
    ;[...command].forEach((char, index) => {
      lines.push(`Type@1ms "${char}"`)
      lines.push(`Wait+Line@60s /\\$ ${literal(command.slice(0, index + 1).trimEnd())}$/`)
      const next = command[index + 1]
      snap(next === undefined ? then : keyDelay(index, next))
    })
    lines.push("Enter")
  }
  snap(PAUSE.header)
  if (shot.show) {
    type(shot.show, PAUSE.typed)
    lines.push("Wait+Line@60s /^\\$$/")
    snap(PAUSE.read)
  }
  type(shot.run, PAUSE.typed)
  lines.push(`Wait+Screen@120s /${shot.done}/`, "Wait+Line@60s /^\\$$/")
  const split = seconds.reduce((a, b) => a + b, 0)
  snap(PAUSE.hold)
  return { tape: lines.join("\n") + "\n", seconds, split }
}

/** The concat list that shows each screenshot of `dir` for its planned time. */
function concatList(dir: string, seconds: number[]): string {
  const file = (index: number) => `file '${dir}/${String(index).padStart(4, "0")}.png'`
  const lines = seconds.flatMap((hold, index) => [file(index), `duration ${hold.toFixed(3)}`])
  // The demuxer ignores the last duration unless the last file is listed once more.
  lines.push(file(seconds.length - 1))
  return lines.join("\n") + "\n"
}

/**
 * The staged shell: a throwaway home, a plain grey prompt, bat without a pager, and `rule`, which
 * clears the screen and prints a shot's header over a full-width line.
 */
function shellRc(home: string, denoDir: string): string {
  return `export HOME='${home}' DENO_DIR='${denoDir}' NO_UPDATE_NOTIFIER=1
export BAT_PAGING=never BAT_THEME=OneHalfDark BAT_STYLE=plain
PS1='\\[\\e[90m\\]$\\[\\e[0m\\] '
rule() {
  clear
  printf '\\n \\e[38;2;249;115;22m%s\\e[0m   \\e[1m%s\\e[0m   \\e[38;2;133;127;121m%s\\e[0m\\n' "$1" "$2" "$3"
  local line
  printf -v line '%*s' "$((COLUMNS - 2))" ''
  printf ' \\e[38;2;87;81;75m%s\\e[0m\\n' "\${line// /─}"
}
`
}

/** Records every shot into `.take/` from a staged home with a warm module cache. */
async function record(): Promise<void> {
  for (const tool of ["vhs", "bat", "ffmpeg", "ffprobe"]) await run("which", [tool])
  const temp = await Deno.makeTempDir({ prefix: "ts-libs-demo-" })
  try {
    const home = `${temp}/home`
    const denoDir = `${temp}/deno`
    const env = { DENO_DIR: denoDir }
    for (const dir of ["my-app", "new-app"]) {
      await Deno.mkdir(`${home}/${dir}`, { recursive: true })
      await Deno.writeTextFile(`${home}/${dir}/deno.json`, "{}\n")
    }
    for (const file of ["time.ts", "money.ts", "signup.ts"]) {
      await Deno.copyFile(`${HERE}project/${file}`, `${home}/my-app/${file}`)
    }
    const app = `${home}/my-app`
    await run("deno", ["add", "-q", ...PACKAGES], { cwd: app, env, seconds: 300 })
    await run("deno", ["cache", "time.ts", "money.ts", "signup.ts"], {
      cwd: app,
      env,
      seconds: 300,
    })
    await Deno.writeTextFile(`${temp}/rc.sh`, shellRc(home, denoDir))

    await Deno.mkdir(TAKE, { recursive: true })
    for (const shot of SHOTS) {
      const { tape, seconds } = plan(shot)
      await Deno.mkdir(`${temp}/${shot.name}`)
      await Deno.writeTextFile(`${temp}/${shot.name}.tape`, tape)
      console.log(`Recording ${shot.name}: ${seconds.length} screens…`)
      await run("vhs", ["-q", `${shot.name}.tape`], {
        cwd: temp,
        env: { DEMO_RC: `${temp}/rc.sh` },
        seconds: 900,
      })
      await Deno.writeTextFile(
        `${temp}/${shot.name}.txt`,
        concatList(`${temp}/${shot.name}`, seconds),
      )
      const total = seconds.reduce((a, b) => a + b, 0)
      await ffmpeg([
        ...["-f", "concat", "-safe", "0", "-i", `${temp}/${shot.name}.txt`],
        ...["-vf", `fps=${FPS}`, "-t", total.toFixed(3), "-c:v", "ffv1", `${TAKE}${shot.name}.mkv`],
      ])
    }
  } finally {
    await Deno.remove(temp, { recursive: true })
  }
}

/** One caption with its times in the finished video. */
interface Cue {
  start: number
  end: number
  text: string
}

/** The captions over the take: the first while the code is read, the second over the output. */
function cues(lengths: number[]): Cue[] {
  const list: Cue[] = []
  let at = TITLE.seconds
  SHOTS.forEach((shot, index) => {
    const end = at + lengths[index]
    // The second caption starts with the output.
    const split = at + plan(shot).split
    list.push({ start: at, end: split, text: shot.captions[0] })
    list.push({ start: split, end, text: shot.captions[1] })
    at = end
  })
  return list
}

/** `00:00:01.500` */
function vttTime(seconds: number): string {
  const ms = Math.round(seconds * 1000)
  const pad = (n: number, width = 2) => String(n).padStart(width, "0")
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${
    pad(Math.floor(ms / 1000) % 60)
  }.${pad(ms % 1000, 3)}`
}

function vtt(list: Cue[]): string {
  const blocks = list.map((cue) => `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}`)
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`
}

/** A drawtext filter that reads its text from a file, so no text needs escaping. */
function text(file: string, font: string, size: number, color: string, y: string): string {
  return `drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${color}` +
    `:x=(w-tw)/2:y=${y}`
}

/** Encodes the last take with its cards, captions and music, and checks the result. */
async function encode(): Promise<void> {
  try {
    await Deno.stat(MUSIC)
  } catch {
    throw new Error(`The music track is missing: ${MUSIC} (see MUSIC.md)`)
  }
  const takes = SHOTS.map((shot) => `${TAKE}${shot.name}.mkv`)
  const lengths: number[] = []
  for (const file of takes) lengths.push(await duration(file))
  const total = TITLE.seconds + lengths.reduce((a, b) => a + b, 0) + END.seconds
  const list = cues(lengths)
  for (const cue of list) {
    if (cue.text.length > MAX_CAPTION_CHARS) {
      throw new Error(`"${cue.text}" is longer than ${MAX_CAPTION_CHARS} characters`)
    }
    const least = Math.max(MIN_CAPTION_SECONDS, cue.text.length / CHARS_PER_SECOND)
    if (cue.end - cue.start < least) {
      throw new Error(
        `"${cue.text}" shows ${(cue.end - cue.start).toFixed(1)} s, less than ${
          least.toFixed(1)
        } s`,
      )
    }
  }
  await Deno.writeTextFile(`${DEMO}captions.vtt`, vtt(list))

  const temp = await Deno.makeTempDir({ prefix: "ts-libs-encode-" })
  try {
    const textFile = async (name: string, content: string) => {
      const path = `${temp}/${name}.txt`
      await Deno.writeTextFile(path, content)
      return path
    }
    const card = (seconds: number) =>
      `color=c=${INK}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${seconds},format=yuv420p,setsar=1`
    const middle = (offset: number) => `(h-th)/2${offset < 0 ? "-" : "+"}${Math.abs(offset)}`
    const title = [
      card(TITLE.seconds),
      text(await textFile("title", TITLE.name), FONT, 72, PARCHMENT, middle(-70)),
      text(await textFile("claim-1", TITLE.claim[0]), FONT_REGULAR, 32, GRAPHITE, middle(20)),
      text(await textFile("claim-2", TITLE.claim[1]), FONT_REGULAR, 32, GRAPHITE, middle(66)),
    ].join(",")
    const end = [
      card(END.seconds),
      text(await textFile("url", END.url), FONT, 52, PARCHMENT, middle(-30)),
      text(await textFile("sub", END.sub), FONT_REGULAR, 32, GRAPHITE, middle(40)),
    ].join(",")
    const shots = takes.map((_, index) =>
      `[${index}:v]fps=${FPS},scale=${WIDTH}:${HEIGHT},format=yuv420p,setsar=1[s${index}]`
    )
    const between = list.map((cue) => `between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})`)
    const captions = [
      `drawbox=x=0:y=ih-${BAND}:w=iw:h=${BAND}:color=${INK}@0.8:t=fill:enable='${
        between.join("+")
      }'`,
      ...await Promise.all(list.map(async (cue, index) =>
        text(
          await textFile(`cue-${index}`, cue.text),
          FONT,
          CAPTION_SIZE,
          "white",
          // The middle of a capital letter on the band's middle line.
          `h-${BAND / 2}+${0.35 * CAPTION_SIZE}-max_glyph_a`,
        ) + `:enable='${between[index]}'`
      )),
    ].join(",")

    // The music: trimmed to the video, faded in over 1 s and out over 2 s, then set to the target.
    const shape = `atrim=0:${total.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=1,` +
      `afade=t=out:st=${(total - 2).toFixed(3)}:d=2`
    const raw = await loudness(MUSIC, shape)
    const gain = LOUDNESS.target - raw.integrated
    const graph = [
      `${title}[title]`,
      ...shots,
      `${end}[end]`,
      `[title]${takes.map((_, i) => `[s${i}]`).join("")}[end]concat=n=${
        takes.length + 2
      }:v=1:a=0[joined]`,
      `[joined]${captions}[v]`,
      `[${takes.length}:a]${shape},volume=${gain.toFixed(2)}dB[a]`,
    ].join(";")
    const master = `${temp}/master.mkv`
    await ffmpeg([
      ...takes.flatMap((file) => ["-i", file]),
      ...["-i", MUSIC, "-filter_complex", graph, "-map", "[v]", "-map", "[a]"],
      ...["-t", total.toFixed(3), "-c:v", "ffv1", "-c:a", "pcm_s16le", master],
    ])

    const common = ["-i", master, "-map_metadata", "-1", "-r", String(FPS)]
    await ffmpeg([
      ...common,
      ...["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-row-mt", "1", "-deadline", "good"],
      ...["-cpu-used", "2", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "96k"],
      `${DEMO}demo.webm`,
    ])
    await ffmpeg([
      ...common,
      ...["-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p"],
      ...["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", `${DEMO}demo.mp4`],
    ])

    // The poster: the first shot's last frame, the code and its output, with no caption on it.
    const still = `${temp}/still.png`
    await ffmpeg(["-sseof", "-0.2", "-i", takes[0], "-frames:v", "1", still])
    for (const [name, width] of [["poster.webp", WIDTH], ["poster-640.webp", 640]] as const) {
      await ffmpeg([
        ...["-i", still, "-vf", `scale=${width}:-2:flags=lanczos`, "-c:v", "libwebp"],
        ...["-quality", "86", "-map_metadata", "-1", `${DEMO}${name}`],
      ])
    }
  } finally {
    await Deno.remove(temp, { recursive: true })
  }

  for (const name of ["demo.webm", "demo.mp4"]) {
    const sound = await loudness(`${DEMO}${name}`)
    const { size } = await Deno.stat(`${DEMO}${name}`)
    const seconds = await duration(`${DEMO}${name}`)
    console.log(
      `${name}: ${seconds.toFixed(1)} s, ${size} bytes, ` +
        `${sound.integrated} LUFS, true peak ${sound.peak} dBFS`,
    )
    if (sound.integrated > LOUDNESS.most || sound.peak > LOUDNESS.peak) {
      throw new Error(`${name} is too loud: ${sound.integrated} LUFS, peak ${sound.peak} dBFS`)
    }
    if (size > BUDGET) throw new Error(`${name} is ${size} bytes, over ${BUDGET}`)
  }
}

if (import.meta.main) {
  if (!Deno.args.includes("--encode")) await record()
  await encode()
}
