/**
 * `@ts-libs/ops` — the barrel.
 *
 * Convenience only: every module here is also an entry point of its own, and
 * importing a subpath is the better default, because a barrel makes the whole
 * package one module graph for a consumer that wants one function. Use it for the
 * small shared vocabulary (a port interface plus the logger), not in a hot path.
 */

export * from "./console.ts"
export * from "./env.ts"
export * from "./fs.ts"
export * from "./run-command.ts"
export * from "./remote.ts"
export * from "./deploy.ts"
export * from "./backup/compose.ts"
export * from "./backup/types.ts"
export * from "./hooks/install.ts"
