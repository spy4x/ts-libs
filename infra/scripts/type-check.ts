/**
 * Type-check every TypeScript source file in the repo with `deno check`.
 *
 * Files are discovered by walking the tree instead of being listed, so a new
 * package is type-checked as soon as it lands — no edit to this script and no
 * edit to the root `deno.jsonc` required. `deno check` applies the nearest
 * workspace member config to each file.
 */

const ignoredDirectories = new Set([
  ".git",
  ".volumes",
  "coverage",
  "dist",
  "node_modules",
])

const sourceExtensions = [".ts", ".tsx"]

function isSourceFile(name: string): boolean {
  return sourceExtensions.some((extension) => name.endsWith(extension))
}

async function collectSourceFiles(path: string, sourceFiles: string[]): Promise<void> {
  for await (const entry of Deno.readDir(path)) {
    const entryPath = `${path}/${entry.name}`

    if (entry.isDirectory) {
      if (ignoredDirectories.has(entry.name)) {
        continue
      }
      await collectSourceFiles(entryPath, sourceFiles)
    } else if (entry.isFile && isSourceFile(entry.name)) {
      sourceFiles.push(entryPath)
    }
  }
}

const sourceFiles: string[] = []
await collectSourceFiles(".", sourceFiles)
sourceFiles.sort()

if (sourceFiles.length === 0) {
  console.error("No TypeScript sources found. Refusing to report a green type check.")
  Deno.exit(1)
}

console.log(`Type-checking ${sourceFiles.length} file(s).`)

const command = new Deno.Command("deno", {
  args: ["check", ...sourceFiles],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
})
const status = await command.spawn().status

if (!status.success) {
  Deno.exit(status.code)
}
