/**
 * A graph walk over everything a value can hand out, for the scope-check tests.
 *
 * This file is a **test helper**, not part of the package's public surface. It sits in
 * `server/db/testing/`, which `deno.jsonc`'s `publish.exclude` keeps out of the package.
 *
 * The clone's executor in `services.ts` is a `Proxy` whose job is to be *closed*: nothing
 * read through it may be the driver's own function or object, however many property reads
 * away it is. A test that lists the routes somebody thought of cannot show that — round 3
 * of the review found `sql.prototype.constructor`, which no list had, because every
 * ordinary function carries a `prototype` object and that object's `constructor` is the
 * function itself. So the test walks instead of listing: it collects everything reachable
 * and asks whether any of it is a value the driver owns.
 *
 * What the walk follows, from every object and every function it meets:
 *
 *  - every own property, enumerable or not, string-keyed or symbol-keyed, through its
 *    descriptor rather than through a plain read, so a getter is collected rather than
 *    invoked — and `value`, `get` and `set` are all followed;
 *  - `prototype` and `constructor`, read normally, because `constructor` is inherited
 *    rather than own and is exactly the edge that was missed;
 *  - the prototype chain, through `Object.getPrototypeOf`.
 *
 * A read that throws is recorded rather than swallowed, so a walk of a retired handle
 * says which properties refused instead of looking like an empty graph.
 */

/** What one walk found. */
export interface Reachable {
  /** Every distinct object and function met, the root included. */
  values: Set<unknown>
  /** Properties whose read threw, as `<description>: <error name>`. */
  refused: string[]
  /** `true` when the walk stopped at {@link WALK_LIMIT} rather than running out of graph. */
  truncated: boolean
}

/**
 * The most values one walk will collect.
 *
 * The graph of the language's own intrinsics is closed and small, so a walk that reaches
 * this number has found something unbounded and the test should say so rather than hang.
 */
export const WALK_LIMIT = 5000

/**
 * Everything reachable from `root` by reading.
 *
 * Primitives are not collected: they cannot be the driver, and they cannot lead to it.
 */
export function reachableFrom(root: unknown): Reachable {
  const values = new Set<unknown>()
  const refused: string[] = []
  const queue: unknown[] = [root]
  let truncated = false

  const enqueue = (value: unknown, description: string): void => {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return
    if (values.has(value)) return
    if (values.size >= WALK_LIMIT) {
      truncated = true
      return
    }
    values.add(value)
    queue.push(value)
    void description
  }

  const read = (description: string, take: () => unknown): unknown => {
    try {
      return take()
    } catch (error) {
      refused.push(`${description}: ${(error as Error).name}`)
      return undefined
    }
  }

  enqueue(root, "root")
  while (queue.length > 0) {
    const current = queue.shift() as object

    const keys = read("ownKeys", () => Reflect.ownKeys(current)) as
      | Array<string | symbol>
      | undefined
    for (const key of keys ?? []) {
      const label = typeof key === "symbol" ? key.toString() : key
      const descriptor = read(
        `descriptor ${label}`,
        () => Reflect.getOwnPropertyDescriptor(current, key),
      ) as PropertyDescriptor | undefined
      if (descriptor === undefined) continue
      enqueue(descriptor.value, `${label}.value`)
      enqueue(descriptor.get, `${label}.get`)
      enqueue(descriptor.set, `${label}.set`)
    }

    // The two edges a descriptor walk alone misses: `constructor` is inherited, and
    // `prototype` is where it is inherited from.
    enqueue(read("prototype", () => Reflect.get(current, "prototype")), "prototype")
    enqueue(read("constructor", () => Reflect.get(current, "constructor")), "constructor")
    enqueue(read("getPrototypeOf", () => Reflect.getPrototypeOf(current)), "[[Prototype]]")
  }

  return { values, refused, truncated }
}

/**
 * Everything the language itself puts within reach of a function.
 *
 * `Function.prototype`, `Object`, `Symbol.iterator`'s owner and the rest are reachable
 * from any function at all, so they are nobody's property in particular. One probe is not
 * enough: an `async` function's `constructor` is `AsyncFunction`, which a plain function
 * cannot reach, and the driver has one `async` helper (`notify`). All four function kinds
 * are walked so that none of their realms is mistaken for something a driver owns.
 */
export function intrinsics(): Set<unknown> {
  const probes = [
    function syncProbe(): void {},
    async function asyncProbe(): Promise<void> {},
    function* generatorProbe(): Generator<void> {},
    async function* asyncGeneratorProbe(): AsyncGenerator<void> {},
  ]
  const all = new Set<unknown>()
  for (const probe of probes) {
    for (const value of reachableFrom(probe).values) all.add(value)
  }
  return all
}

/**
 * The values reachable from `root` that are not part of the language itself.
 *
 * Subtracting {@link intrinsics} from a walk of `root` leaves exactly what `root` itself
 * owns. That is the set a wrapper must never hand out.
 */
export function ownedBy(root: unknown): Set<unknown> {
  const shared = intrinsics()
  const owned = new Set<unknown>()
  for (const value of reachableFrom(root).values) {
    if (!shared.has(value)) owned.add(value)
  }
  return owned
}
