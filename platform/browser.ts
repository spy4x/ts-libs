/**
 * `@ts-libs/platform/browser` — helpers that need a browser.
 *
 * Nothing here touches a global at import time: `urlBase64ToUint8Array` calls `atob` when invoked,
 * and `makeStorage` takes its storage object as a parameter. Both are therefore safe under SSR and
 * testable with a `Map`-backed fake.
 */

export * from "./browser/base64.ts"
export * from "./browser/dropdown.ts"
export * from "./browser/storage.ts"
