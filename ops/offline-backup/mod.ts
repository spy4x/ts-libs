/**
 * `@ts-libs/ops/offline-backup` — the barrel.
 *
 * This barrel is the **only** entry point for these modules: `ops/deno.json`
 * exports `./offline-backup` and not the five files individually, so a consumer
 * takes the drive mechanics with one specifier. Options bags
 * (all extending `OfflineBackupPorts`) are the API: nothing here is a CLI, and
 * every external effect is a port the caller supplies.
 */

export * from "./types.ts"
export * from "./helpers.ts"
export * from "./drive.ts"
export * from "./sync.ts"
export * from "./verify.ts"
