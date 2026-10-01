/**
 * A labelled counter and its Prometheus text exposition: enough for a service to count what went
 * wrong and for a scrape endpoint to publish it. No registry, no histograms: the caller keeps the
 * counters it created and passes them to {@link renderPrometheus}.
 *
 * @module
 */

/** The labels of one series, for example `{ event: "UserSignedOut", listener: "close" }`. */
export type MetricLabels = Readonly<Record<string, string>>

/**
 * A monotonically increasing count, kept separately for every distinct set of labels.
 *
 * Every distinct label set stays in memory for the life of the process, so label values must come
 * from a small fixed set (an event name, a status), never user ids, paths or other open-ended text.
 */
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
 * Creates a counter. The name must end in `_total`, as Prometheus convention asks of counters, and
 * be a valid metric name; otherwise this throws `RangeError`. `increment` throws `RangeError` for
 * an invalid label name or an amount that is not a non-negative integer. Mind the label-value
 * rule on {@link Counter}.
 */
export function createCounter(name: string, help: string): Counter {
  if (!METRIC_NAME.test(name)) throw new RangeError(`invalid metric name: ${name}`)
  if (!name.endsWith("_total")) throw new RangeError(`a counter name ends in _total: ${name}`)
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
 * and `# TYPE` lines. Throws `RangeError` when two counters share a name: a second `# HELP` and
 * `# TYPE` pair makes Prometheus reject the whole scrape.
 */
export function renderPrometheus(counters: readonly Counter[]): string {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const counter of counters) {
    if (seen.has(counter.name)) throw new RangeError(`two counters are named ${counter.name}`)
    seen.add(counter.name)
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
