import { expect } from "@std/expect"
import { describe, it } from "@std/testing/bdd"
import { createCounter, renderPrometheus } from "./metrics.ts"

describe("createCounter", () => {
  it("counts each set of labels on its own", () => {
    const counter = createCounter("jobs_failed_total", "Failed jobs")
    counter.increment({ job: "a" })
    counter.increment({ job: "a" })
    counter.increment({ job: "b" }, 5)
    expect(counter.value({ job: "a" })).toBe(2)
    expect(counter.value({ job: "b" })).toBe(5)
    expect(counter.value({ job: "c" })).toBe(0)
  })

  it("treats the same labels in another order as one series", () => {
    const counter = createCounter("x_total", "x")
    counter.increment({ a: "1", b: "2" })
    counter.increment({ b: "2", a: "1" })
    expect(counter.series()).toEqual([{ labels: { a: "1", b: "2" }, value: 2 }])
  })

  it("counts without labels", () => {
    const counter = createCounter("x_total", "x")
    counter.increment()
    expect(counter.value()).toBe(1)
  })

  it("refuses a counter name that does not end in _total", () => {
    expect(() => createCounter("jobs_failed", "x")).toThrow(RangeError)
  })

  it("refuses a name, a label or an amount Prometheus cannot take", () => {
    expect(() => createCounter("1bad_total", "x")).toThrow(RangeError)
    const counter = createCounter("x_total", "x")
    expect(() => counter.increment({ "bad-label": "v" })).toThrow(RangeError)
    expect(() => counter.increment({ __reserved: "v" })).toThrow(RangeError)
    expect(() => counter.increment({}, -1)).toThrow(RangeError)
    expect(() => counter.increment({}, 1.5)).toThrow(RangeError)
  })
})

describe("renderPrometheus", () => {
  it("prints help, type and one line per series, labels sorted", () => {
    const counter = createCounter("jobs_failed_total", "Failed jobs")
    counter.increment({ job: "b", kind: "k" }, 3)
    counter.increment({ kind: "k", job: "a" })
    expect(renderPrometheus([counter])).toBe(
      `# HELP jobs_failed_total Failed jobs\n` +
        `# TYPE jobs_failed_total counter\n` +
        `jobs_failed_total{job="b",kind="k"} 3\n` +
        `jobs_failed_total{job="a",kind="k"} 1\n`,
    )
  })

  it("escapes quotes, backslashes and newlines in label values and help", () => {
    const counter = createCounter("x_total", "line one\nline \\ two")
    counter.increment({ v: 'a"b\\c\nd' })
    expect(renderPrometheus([counter])).toBe(
      `# HELP x_total line one\\nline \\\\ two\n# TYPE x_total counter\n` +
        `x_total{v="a\\"b\\\\c\\nd"} 1\n`,
    )
  })

  it("prints an unlabelled series without braces and keeps a counter that has no series", () => {
    const a = createCounter("a_total", "a")
    a.increment()
    const b = createCounter("b_total", "b")
    expect(renderPrometheus([a, b])).toBe(
      `# HELP a_total a\n# TYPE a_total counter\na_total 1\n# HELP b_total b\n# TYPE b_total counter\n`,
    )
  })

  it("refuses two counters with the same name instead of printing a second HELP and TYPE", () => {
    const a = createCounter("x_total", "a")
    const b = createCounter("x_total", "b")
    expect(() => renderPrometheus([a, b])).toThrow(RangeError)
  })

  it("renders nothing for no counters", () => {
    expect(renderPrometheus([])).toBe("")
  })
})
