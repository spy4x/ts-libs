/**
 * `@ts-libs/ops/offline-backup` — the barrel.
 *
 * The five modules are also importable on their own subpaths; this exists so a
 * consumer can take the whole drive workflow with one specifier. Options bags
 * (all extending `OfflineBackupPorts`) are the API: nothing here is a CLI, and
 * every external effect is a port the caller supplies.
 */

export * from "./types.ts"
export * from "./helpers.ts"
export * from "./drive.ts"
export * from "./sync.ts"
export * from "./verify.ts"
