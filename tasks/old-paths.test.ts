// `@spy4x/tasks` publishes the to-do entry points whose code still sits in `platform/` and
// `time/` (#600). An app may import a name from either path, so both must hand out the very same
// value: an enum or a constant that existed twice would stop comparing equal across the two.
// Types have no value to compare; `docs/1.0-contract.md` lists them for every entry point.

import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"
import * as model from "./model.ts"
import * as view from "./view.ts"
import * as quickAdd from "./quick-add.ts"
import * as reminderRunner from "./reminder-runner.ts"
import * as oldModel from "@spy4x/time/ical-tasks-model"
import * as oldView from "@spy4x/platform/universal/ical-tasks-view"
import * as oldQuickAdd from "@spy4x/platform/universal/quick-add"
import * as oldReminderRunner from "@spy4x/platform/server/reminder-runner"

type Names = Record<string, unknown>

const PAIRS: [entry: string, now: Names, oldPath: string, old: Names][] = [
  ["model", model, "@spy4x/time/ical-tasks-model", oldModel],
  ["view", view, "@spy4x/platform/universal/ical-tasks-view", oldView],
  ["quick-add", quickAdd, "@spy4x/platform/universal/quick-add", oldQuickAdd],
  [
    "reminder-runner",
    reminderRunner,
    "@spy4x/platform/server/reminder-runner",
    oldReminderRunner,
  ],
]

describe("@spy4x/tasks and the old import paths", () => {
  for (const [entry, now, oldPath, old] of PAIRS) {
    it(`${entry} exports every value of ${oldPath}, and the same one`, () => {
      const names = Object.keys(old).sort()
      expect(names.length).toBeGreaterThan(0)
      expect(Object.keys(now).sort()).toEqual(names)
      for (const name of names) expect(now[name]).toBe(old[name])
    })
  }
})
