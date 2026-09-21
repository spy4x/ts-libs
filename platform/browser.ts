/**
 * `@ts-libs/platform/browser` — helpers that need a browser.
 *
 * Nothing here touches a global at import time: `makeStorage` takes its storage object as a
 * parameter, so it is safe under SSR and testable with a `Map`-backed fake.
 */

export * from "./browser/download.ts"
export * from "./browser/storage.ts"
