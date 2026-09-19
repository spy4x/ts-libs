import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert"
import {
  buildExportEnvelope,
  EXPORT_VERSION,
  exportDownloadHeaders,
  exportDownloadResponse,
  type ExportEnvelope,
  exportFileName,
  formatLocalDate,
} from "./export.ts"

/**
 * A fixed instant whose UTC day is known: 2026-03-09T18:30Z.
 *
 * Whether that is the 9th or the 10th *locally* depends on the host timezone, so
 * the filename tests derive the expected day from local getters — the same way a
 * user reads it — instead of hard-coding a day that is only right on UTC.
 */
const FIXED = new Date("2026-03-09T18:30:00.000Z")
const FIXED_NOW = () => FIXED

/** `YYYY-MM-DD` from local getters, independent of the host timezone. */
function localDayOf(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")
}

Deno.test("export: the envelope carries the version, user and timestamp", async () => {
  const envelope = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1", email: "user@example.com" },
    collections: [],
    now: FIXED_NOW,
  })
  assertEquals(envelope.version, EXPORT_VERSION)
  assertEquals(envelope.exportedAt, "2026-03-09T18:30:00.000Z")
  assertEquals(envelope.user, { id: "user-1", email: "user@example.com" })
})

Deno.test("export: collections are attached under their own names", async () => {
  const envelope = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1" },
    collections: [
      { name: "areas", load: () => [{ id: "area-1" }] },
      { name: "snapshots", load: async () => await Promise.resolve([{ id: "snap-1" }]) },
    ],
    now: FIXED_NOW,
  })
  assertEquals(envelope.areas, [{ id: "area-1" }])
  assertEquals(envelope.snapshots, [{ id: "snap-1" }])
})

Deno.test("export: each loader is scoped to the requesting user", async () => {
  const seen: string[] = []
  await buildExportEnvelope({
    userId: "user-42",
    user: { id: "user-42" },
    collections: [{
      name: "focus",
      load: (userId) => {
        seen.push(userId)
        return []
      },
    }],
    now: FIXED_NOW,
  })
  assertEquals(seen, ["user-42"])
})

Deno.test("export: a loaded collection is not shared between envelopes", async () => {
  const first = await buildExportEnvelope({
    userId: "user-1",
    user: { id: "user-1" },
    collections: [{ name: "areas", load: () => [{ id: "area-1" }] }],
    now: FIXED_NOW,
  })
  const second = await buildExportEnvelope({
    userId: "user-2",
    user: { id: "user-2" },
    collections: [{ name: "areas", load: () => [] }],
    now: FIXED_NOW,
  })
  assertEquals(first.areas, [{ id: "area-1" }])
  assertEquals(second.areas, [])
})

Deno.test("export: a reserved collection name is refused", async () => {
  for (const name of ["version", "exportedAt", "user"]) {
    await assertRejects(
      () =>
        buildExportEnvelope({
          userId: "user-1",
          user: { id: "user-1" },
          collections: [{ name, load: () => [] }],
        }),
      TypeError,
      "reserved",
    )
  }
})

Deno.test("export: a duplicated collection name is refused", async () => {
  await assertRejects(
    () =>
      buildExportEnvelope({
        userId: "user-1",
        user: { id: "user-1" },
        collections: [
          { name: "areas", load: () => [] },
          { name: "areas", load: () => [] },
        ],
      }),
    TypeError,
    "duplicate",
  )
})

Deno.test("export: an empty userId is refused", async () => {
  await assertRejects(
    () => buildExportEnvelope({ userId: "", user: { id: "" }, collections: [] }),
    TypeError,
  )
})

Deno.test("export: a product may override the format version", async () => {
  const envelope = await buildExportEnvelope({
    version: "2.1",
    userId: "user-1",
    user: { id: "user-1" },
    collections: [],
    now: FIXED_NOW,
  })
  assertEquals(envelope.version, "2.1")
})

Deno.test("export: the filename is <name>-YYYY-MM-DD.json", () => {
  assertEquals(exportFileName("northstar", FIXED), `northstar-${localDayOf(FIXED)}.json`)
})

Deno.test("export: the filename carries the local day, not the UTC day", () => {
  // 2026-03-09T23:30Z is the 10th at +05:00 and still the 9th at -05:00. In a
  // negative-offset timezone that is 18:30-19:30 local, so the source's
  // `toISOString().slice(0, 10)` would have named an evening export for tomorrow.
  const evening = new Date("2026-03-09T23:30:00.000Z")
  const localDay = localDayOf(evening)
  const utcDay = evening.toISOString().slice(0, 10)
  const filename = exportFileName("northstar", evening)

  assertEquals(filename, `northstar-${localDay}.json`)
  if (utcDay !== localDay) {
    assertStrictEquals(
      filename.includes(utcDay),
      false,
      `filename used the UTC day ${utcDay} instead of the local day ${localDay}`,
    )
  }
})

Deno.test("export: the local day is zero-padded in both month and day", () => {
  assertEquals(formatLocalDate(new Date(2026, 0, 5, 12)), "2026-01-05")
  assertEquals(formatLocalDate(new Date(2026, 11, 31, 12)), "2026-12-31")
})

Deno.test("export: the local formatter agrees with local getters across a month boundary", () => {
  const boundary = new Date(2026, 2, 10, 0, 0, 0)
  assertEquals(formatLocalDate(boundary), "2026-03-10")
  assertEquals(formatLocalDate(boundary), localDayOf(boundary))
})

Deno.test("export: the filename cannot inject a header or a path", () => {
  const day = localDayOf(FIXED)
  assertEquals(
    exportFileName('evil"; filename="x\r\nX-Injected: 1', FIXED),
    `evil-filename-x-X-Injected-1-${day}.json`,
  )
  assertEquals(exportFileName("../../etc/passwd", FIXED), `etc-passwd-${day}.json`)
  assertEquals(exportFileName("naïve café", FIXED), `na-ve-caf-${day}.json`)
})

Deno.test("export: an empty or punctuation-only name falls back to `export`", () => {
  const day = localDayOf(FIXED)
  assertEquals(exportFileName("", FIXED), `export-${day}.json`)
  assertEquals(exportFileName("   ", FIXED), `export-${day}.json`)
  assertEquals(exportFileName("///", FIXED), `export-${day}.json`)
  // `..` is a path segment, not a name: it must never survive into the filename.
  assertEquals(exportFileName("..", FIXED), `export-${day}.json`)
  assertEquals(exportFileName(".", FIXED), `export-${day}.json`)
})

Deno.test("export: the content-disposition header is an attachment", () => {
  const headers = exportDownloadHeaders("northstar", FIXED)
  assertEquals(
    headers.get("content-disposition"),
    `attachment; filename="northstar-${localDayOf(FIXED)}.json"`,
  )
  assertEquals(headers.get("content-type"), "application/json; charset=utf-8")
})

Deno.test("export: an invalid date is refused instead of naming a file `NaN`", () => {
  assertThrows(() => exportDownloadHeaders("northstar", new Date("nonsense")), RangeError)
  assertThrows(() => exportFileName("northstar", new Date(Number.NaN)), RangeError)
})

Deno.test("export: the download response serialises the envelope with the headers", async () => {
  const envelope: ExportEnvelope<{ id: string }> = {
    exportedAt: FIXED.toISOString(),
    version: EXPORT_VERSION,
    user: { id: "user-1" },
    areas: [{ id: "area-1" }],
  }
  const response = exportDownloadResponse(envelope, { name: "northstar", date: FIXED })

  assertEquals(response.status, 200)
  assertEquals(
    response.headers.get("content-disposition"),
    `attachment; filename="northstar-${localDayOf(FIXED)}.json"`,
  )
  assertEquals(response.headers.get("content-type"), "application/json; charset=utf-8")
  assertEquals(await response.json(), envelope)
  assertStrictEquals(response.bodyUsed, true)
})
