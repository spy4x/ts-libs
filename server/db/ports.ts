/**
 * The Postgres ports.
 *
 * Neither interface touches the network, the environment or a driver: the SQL
 * client arrives as a value and the cache arrives as a port, so the base class
 * and its helpers are exercised without a live database and without a cache
 * implementation of this package's choosing.
 */

import type postgres from "postgres"

/** The tag function `postgres` exposes, narrowed to what this package reads from it. */
export type Sql = postgres.Sql<Record<string, unknown>>

/** A transaction handle, as `sql.begin` hands it to its callback. */
export type Transaction = postgres.TransactionSql<Record<string, unknown>>

/**
 * The cache a {@link DbServiceBase} may be given.
 *
 * Adapted from the template's `PublicAPICacheModel` (`template/libs/server/db/+index.ts:51-90`),
 * which this package cannot import: it is a domain class from a host app. The
 * four operations used are all that is required, so a caller passes the cache it
 * already has rather than one shaped here. Keys are `string | number` because the
 * template keys rows by numeric id and other callers key by string.
 */
export interface RowCache<T> {
  /** Return the cached row, or compute, store and return it. */
  wrap(key: string | number, compute: () => Promise<T>): Promise<T>
  set(key: string | number, value: T): Promise<void>
  delete(key: string | number): Promise<void>
}
