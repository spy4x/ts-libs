import { assertEquals } from "@std/assert"
import { type BackupConfig, BackupStatus, isMissingContainerError } from "./types.ts"

Deno.test("BackupStatus starts at 1 so an unset status is not IN_PROGRESS", () => {
  assertEquals(BackupStatus.IN_PROGRESS, 1)
  assertEquals(BackupStatus.SUCCESS, 2)
  assertEquals(BackupStatus.ERROR, 3)
})

Deno.test("BackupStatus has no gaps or duplicates", () => {
  const values = Object.values(BackupStatus).filter((value) => typeof value === "number")
  assertEquals(values, [1, 2, 3])
})

Deno.test("BackupStatus orders IN_PROGRESS before SUCCESS before ERROR", () => {
  assertEquals(BackupStatus.IN_PROGRESS < BackupStatus.SUCCESS, true)
  assertEquals(BackupStatus.SUCCESS < BackupStatus.ERROR, true)
})

Deno.test("isMissingContainerError matches compose's 'no container to start' stderr", () => {
  // Reproduces the cloud-server stalwart backup failure where Watchtower
  // recreated hl-cert-sync between the backup's stop and start.
  assertEquals(
    isMissingContainerError(`service "cert-sync" has no container to start`),
    true,
  )
})

Deno.test("isMissingContainerError matches when the phrase is wrapped in other text", () => {
  const stderr = [
    "Error starting compose stack:",
    'service "cert-sync" has no container to start',
    "",
  ].join("\n")
  assertEquals(isMissingContainerError(stderr), true)
})

Deno.test("isMissingContainerError returns false for unrelated stderr", () => {
  assertEquals(isMissingContainerError(""), false)
  assertEquals(isMissingContainerError("permission denied"), false)
  assertEquals(isMissingContainerError("cannot connect to Docker daemon"), false)
  assertEquals(isMissingContainerError("compose file not found"), false)
})

Deno.test("a config the shape of offer-lens/backup.ts type-checks against the contract", () => {
  const config: BackupConfig = {
    name: "offerlens",
    sourcePaths: "default",
    containers: {
      stop: "default",
    },
  }
  assertEquals(config.name, "offerlens")
  assertEquals(config.sourcePaths, "default")
  assertEquals(config.containers?.stop, "default")
})
