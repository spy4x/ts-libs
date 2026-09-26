// Writes `docs/social-preview.png` (#235): the 1280×640 card GitHub shows when someone shares a
// link to the repository. Run with `deno task social-preview`, then upload the file by hand in
// Settings → General → Social preview; GitHub has no API for that upload.
//
// The card is plain HTML rendered by headless Chromium: the name and the repository's one-line
// description on the left, a few real import lines on the right. The description is copied from
// `gh repo view spy4x/ts-libs --json description` rather than fetched, so the script needs no
// network and no token; update DESCRIPTION when the repository's description changes. Every import
// line names an export that exists — check them against the packages' `deno.json` when you edit.
//
// Playwright is repository tooling, not a dependency of any package, so it is not in the root
// import map and never reaches JSR (`infra/` is not a workspace member). The task runs this script
// with `--node-modules-dir=none --no-lock`: the pinned package comes from Deno's global cache and
// `deno.lock` does not change. The specifier is imported through a variable, not a string literal,
// so `deno task ts:check` does not try to resolve it; the small interfaces below stand in for
// Playwright's own types. Chromium must be installed once:
// `deno run -A npm:playwright@1.63.0 install chromium`.

const PLAYWRIGHT = "npm:playwright@1.63.0"

const OUTPUT = new URL("../../docs/social-preview.png", import.meta.url)
const WIDTH = 1280
const HEIGHT = 640

const NAME = "ts-libs"
const DESCRIPTION = "Modern TypeScript libraries built on web standards (Fetch, Web Crypto, " +
  "Streams, ES modules), published to JSR as @spy4x/*: validation, platform primitives, " +
  "server adapters, SSRF guards, email, time, realtime, integrations."

interface ImportLine {
  name: string
  specifier: string
}

/** Real exports, one per package family, so the card shows the library's breadth. */
const IMPORTS: ImportLine[] = [
  { name: "createSmtpSender", specifier: "jsr:@spy4x/email/smtp" },
  { name: "safeFetch", specifier: "jsr:@spy4x/net/safe-fetch" },
  { name: "zonedDateTime", specifier: "jsr:@spy4x/time/tz" },
  { name: "validate", specifier: "jsr:@spy4x/validation" },
]

interface Page {
  setContent(html: string, opts?: { waitUntil?: string }): Promise<void>
  evaluate(expression: string): Promise<unknown>
  screenshot(opts: { path: string; animations?: string; caret?: string }): Promise<unknown>
}

interface BrowserContext {
  newPage(): Promise<Page>
  close(): Promise<void>
}

interface Browser {
  newContext(opts: {
    viewport: { width: number; height: number }
    deviceScaleFactor: number
    colorScheme: string
  }): Promise<BrowserContext>
  close(): Promise<void>
}

interface Playwright {
  chromium: { launch(opts: { headless: boolean }): Promise<Browser> }
}

/** Escapes the five characters that are special in HTML text and attribute values. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll(`"`, "&quot;").replaceAll("'", "&#39;")
}

/** One import line, highlighted with the same few colours a dark editor theme would use. */
function importHtml({ name, specifier }: ImportLine): string {
  return `<div><span class="kw">import</span> <span class="punct">{</span> ` +
    `<span class="id">${escapeHtml(name)}</span> <span class="punct">}</span> ` +
    `<span class="kw">from</span> <span class="str">"${escapeHtml(specifier)}"</span></div>`
}

/** The whole card as one self-contained HTML document: no network, no external fonts. */
function cardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden;
      background: radial-gradient(circle at 85% 20%, #0f2a4a 0, #020617 55%);
      font-family: Inter, "Noto Sans", system-ui, sans-serif; color: #f8fafc; }
    .text { position: absolute; left: 72px; top: 0; bottom: 0; width: 470px;
      display: flex; flex-direction: column; justify-content: center; }
    .name { font-size: 104px; font-weight: 800; letter-spacing: -4px; line-height: 1; }
    .line { font-size: 24px; line-height: 1.45; color: #cbd5e1; margin-top: 28px; }
    .card { position: absolute; left: 584px; right: 48px; top: 50%; transform: translateY(-50%);
      background: #0b1220; border-radius: 14px; padding: 26px 26px 30px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, .5), 0 0 0 1px rgba(148, 163, 184, .18); }
    .dots { display: flex; gap: 8px; margin-bottom: 22px; }
    .dots span { width: 12px; height: 12px; border-radius: 50%; background: #334155; }
    .code { font-family: "JetBrains Mono", "Noto Sans Mono", "DejaVu Sans Mono", ui-monospace,
      monospace; font-size: 17px; line-height: 2.1; white-space: pre; color: #e2e8f0; }
    .kw { color: #c084fc; } .id { color: #7dd3fc; } .str { color: #86efac; }
    .punct { color: #94a3b8; }
  </style></head><body>
    <div class="text">
      <div class="name">${escapeHtml(NAME)}</div>
      <div class="line">${escapeHtml(DESCRIPTION)}</div>
    </div>
    <div class="card">
      <div class="dots"><span></span><span></span><span></span></div>
      <div class="code">${IMPORTS.map(importHtml).join("")}</div>
    </div>
  </body></html>`
}

/** Renders the card and writes it to OUTPUT, closing the browser on every path. */
async function main(): Promise<void> {
  const { chromium } = (await import(PLAYWRIGHT)) as Playwright
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    })
    const page = await context.newPage()
    await page.setContent(cardHtml(), { waitUntil: "load" })
    // A code line wider than its card would be cut off without any error, so fail instead.
    const overflow = await page.evaluate(
      `(() => { const c = document.querySelector(".code"); return c.scrollWidth > c.clientWidth })()`,
    )
    if (overflow) throw new Error("an import line is wider than the code card")
    await page.screenshot({ path: OUTPUT.pathname, animations: "disabled", caret: "hide" })
    await context.close()
    console.log("wrote docs/social-preview.png")
  } finally {
    await browser.close().catch(() => {})
  }
}

await main()
