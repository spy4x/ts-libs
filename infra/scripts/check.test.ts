import { describe, it } from "@std/testing/bdd"
import { expect } from "@std/expect"

import { report } from "./check.ts"

const passingTests = [
  "running 1 test from ./net/ip.test.ts",
  "parseIp ... ok (1ms)",
  "",
  "ok | 2598 passed (6137 steps) | 0 failed (1m49s)",
  "",
].join("\n")

const failingTests = [
  "running 2 tests from ./net/ip.test.ts",
  "parseIp ... ok (1ms)",
  "rejects a bad address ... FAILED (2ms)",
  "",
  " ERRORS ",
  "",
  "rejects a bad address => ./net/ip.test.ts:9:6",
  "error: AssertionError: Values are not equal.",
  "",
  " FAILURES ",
  "",
  "rejects a bad address => ./net/ip.test.ts:9:6",
  "",
  "FAILED | 1 passed | 1 failed (5ms)",
  "",
  "error: Test failed",
].join("\n")

describe("report", () => {
  it("prints one line with the test summary when the tests pass", () => {
    expect(report({ task: "test", code: 0, output: passingTests, seconds: 109.4 })).toBe(
      "ok test 109s | ok | 2598 passed (6137 steps) | 0 failed (1m49s)",
    )
  })

  it("prints nothing of a passing task's output", () => {
    const output = "Type-checking 688 file(s).\n"
    expect(report({ task: "ts:check", code: 0, output, seconds: 30 })).toBe("ok ts:check 30s")
  })

  it("prints a failing test run from its ERRORS section on, without the passing tests", () => {
    const text = report({ task: "test", code: 1, output: failingTests, seconds: 2 })
    expect(text).toMatch(
      /^FAILED exit=1 test 2s \| FAILED \| 1 passed \| 1 failed \(5ms\)\n ERRORS /,
    )
    expect(text).toContain("error: AssertionError: Values are not equal.")
    expect(text).toContain("error: Test failed")
    expect(text).not.toContain("parseIp ... ok")
  })

  it("prints all of a failing task's output when it has no ERRORS section", () => {
    const output = "error: Found 2 not formatted files in 120 files\n"
    expect(report({ task: "fmt:check", code: 1, output, seconds: 1 })).toBe(
      `FAILED exit=1 fmt:check 1s\n${output}`,
    )
  })
})
