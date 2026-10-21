# Demo video recipe

`deno task demo-video` remakes the ts-libs demo video in `media/demo/` from scratch, in about ten
minutes on a busy machine. It shows three packages, each as a short file and its real output in a
terminal, then the `deno add` that installs them, between a title card and an end card, with
burned-in captions and quiet music.

Needs `vhs` (with its `ttyd` and a Chromium), `bat`, `ffmpeg` with libvpx-vp9, libx264, libopus,
libwebp and drawtext, the Hack font, and network access to JSR and npm.

1. `deno task demo-video` stages a throwaway home in a temporary folder: `my-app` with the three
   files in `project/` and their packages installed, and an empty `new-app`. Nothing reads your
   own home, config or tokens.
2. For each shot it writes a vhs tape and takes one screenshot per screen (each key typed, each
   output), waiting until the terminal shows the expected text. Each screen is then held for a set
   time, so a loaded machine cannot speed the clip up. The four shots land in `.take/`
   (gitignored).
3. It encodes: title card, the shots, end card; `captions.vtt` written from the captions in
   `demo-video.ts` and the take's times, then burned in; `music.opus` trimmed, faded and set to
   -28 LUFS. It refuses a caption too short to read, a mix louder than -27 LUFS or above -1 dBTP,
   and a file over 3 MB, and prints each file's length, size and loudness.

To change a caption, the music or the cards, edit `demo-video.ts` (or replace `music.opus` and
`MUSIC.md`) and run `deno task demo-video --encode`, which re-encodes the last take without
recording again. To change what a shot shows, edit `project/` or `SHOTS` and record again.

Check the result before committing: `ffmpeg -i media/demo/demo.mp4 -vf
"fps=1,scale=320:-1,tile=6x9" -frames:v 1 sheet.png`, then look at every frame.

The caption and card font is IBM Plex Sans (`fonts/`, SIL Open Font License, `fonts/LICENSE-ibm-plex.txt`).
