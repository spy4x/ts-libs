/// <reference lib="webworker" />
import { it } from "@std/testing/bdd"

import { installOfflineShell } from "./offline-shell.ts"

declare const self: ServiceWorkerGlobalScope

it("accepts the real service-worker global scope (checked by the compiler, never run)", () => {
  // `deno test` type-checks this file under the webworker lib; the function is not called.
  const install = () => installOfflineShell(self, { shellUrls: ["/"] })
  void install
})
