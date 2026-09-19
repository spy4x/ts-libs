import { assertEquals, assertThrows } from "@std/assert"
import {
  BackupError,
  ConfirmRequiredError,
  DEFAULT_DEV_DIR,
  DEFAULT_PARTITION_SUFFIX,
  LOGS_DIR,
} from "./types.ts"

Deno.test("keeps the on-drive logs directory the source used", () => {
  assertEquals(LOGS_DIR, "logs")
})

Deno.test("defaults the device directory and the partition suffix as documented", () => {
  assertEquals(DEFAULT_DEV_DIR, "/dev")
  assertEquals(DEFAULT_PARTITION_SUFFIX, "1")
})

Deno.test("names the two errors so a log line keeps the distinction", () => {
  assertEquals(new BackupError("rsync failed").name, "BackupError")
  assertEquals(
    new ConfirmRequiredError("no console").name,
    "ConfirmRequiredError",
  )
})

Deno.test("keeps the cause on a BackupError", () => {
  const cause = new Error("underlying")
  const error = new BackupError("wrapped", { cause })
  assertEquals(error.cause, cause)
  assertEquals(error instanceof Error, true)
})

Deno.test("is an Error subclass that can be caught as one", () => {
  assertThrows(
    () => {
      throw new ConfirmRequiredError("formatDrive needs a confirm port")
    },
    Error,
    "needs a confirm port",
  )
})
