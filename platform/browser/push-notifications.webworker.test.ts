/// <reference lib="webworker" />
import { it } from "@std/testing/bdd"

import { installPushNotifications } from "./push-notifications.ts"

declare const self: ServiceWorkerGlobalScope

it("accepts the real service-worker global scope (checked by the compiler, never run)", () => {
  // `deno test` type-checks this file under the webworker lib; the function is not called.
  const install = () => installPushNotifications(self, { icon: "/icon.png" })
  void install
})
