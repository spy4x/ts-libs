/**
 * A labelled counter and its Prometheus text exposition: enough for a service to count what went
 * wrong and for a scrape endpoint to publish it. No registry, no histograms: the caller keeps the
 * counters it created and passes them to {@link renderPrometheus}.
 *
 * @module
 */

/** The labels of one series, for example `{ event: "UserSignedOut", listener: "close" }`. */
export type MetricLabels = Readonly<Record<string, string>>

/** A monotonically increasing count, kept separately for every distinct set of labels. */
export interface Counter {
  readonly name: string
  readonly help: string
  /** Adds `by` (default 1, a non-negative integer) to the series with exactly these labels. */
  increment(labels?: MetricLabels, by?: number): void
  /** The series' value; 0 when it was never incremented. */
  value(labels?: MetricLabels): number
  /** Every series incremented so far. */
  series(): ReadonlyArray<{ labels: MetricLabels; value: number }>
}

const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** A stable key for a label set, so the same labels in another order are the same series. */
function seriesKey(labels: MetricLabels): string {
  for (const label of Object.keys(labels)) {
    if (!LABEL_NAME.test(label) || label.startsWith("__")) {
      throw new RangeError(`invalid label name: ${label}`)
    }
  }
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * Creates a counter. Throws `RangeError` for a name Prometheus would not accept, and later for an
 * invalid label name or an increment that is not a non-negative integer.
 */
export function createCounter(name: string, help: string): Counter {
  if (!METRIC_NAME.test(name)) throw new RangeError(`invalid metric name: ${name}`)
  const values = new Map<string, { labels: MetricLabels; value: number }>()
  return {
    name,
    help,
    increment(labels = {}, by = 1) {
      if (!Number.isSafeInteger(by) || by < 0) {
        throw new RangeError(`a counter only goes up by a non-negative integer, got ${by}`)
      }
      const key = seriesKey(labels)
      const entry = values.get(key) ?? { labels: { ...labels }, value: 0 }
      entry.value += by
      values.set(key, entry)
    },
    value: (labels = {}) => values.get(seriesKey(labels))?.value ?? 0,
    series: () => [...values.values()].map(({ labels, value }) => ({ labels, value })),
  }
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")
}

/**
 * The counters in the Prometheus text exposition format (version 0.0.4), ready to serve with
 * `Content-Type: text/plain; version=0.0.4`. A counter with no series still prints its `# HELP`
 * and `# TYPE` lines.
 */
export function renderPrometheus(counters: readonly Counter[]): string {
  const lines: string[] = []
  for (const counter of counters) {
    lines.push(
      `# HELP ${counter.name} ${counter.help.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`,
    )
    lines.push(`# TYPE ${counter.name} counter`)
    for (const { labels, value } of counter.series()) {
      const pairs = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([label, v]) => `${label}="${escapeLabelValue(v)}"`)
      lines.push(`${counter.name}${pairs.length ? `{${pairs.join(",")}}` : ""} ${value}`)
    }
  }
  return lines.length ? lines.join("\n") + "\n" : ""
}
