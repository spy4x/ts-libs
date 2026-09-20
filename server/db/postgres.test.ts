/**
 * Tests for the Postgres pool tuning and environment parsing.
 *
 * `buildPostgresOptions` is asserted rather than `createSql`, because a pool option is
 * only observable through a live server: `postgres` opens its first connection on the
 * first query, and this suite has none. The four values are checked on the object the
 * driver receives, and the claim that they reach the wire is the one thing here a
 * reviewer should treat as untested.
 */

import { assertEquals, assertStrictEquals, assertThrows } from "@std/assert"
import postgres from "postgres"
import {
  buildPostgresOptions,
  createSqlFromEnv,
  DEFAULT_POOL_OPTIONS,
  parsePostgresEnv,
  PostgresEnvName,
} from "./postgres.ts"

Deno.test("DEFAULT_POOL_OPTIONS carries the values gb tuned", () => {
  assertEquals(DEFAULT_POOL_OPTIONS, {
    connectTimeout: 10,
    idleTimeout: 30,
    maxLifetimeSeconds: 1800,
    max: 15,
  })
})

Deno.test("buildPostgresOptions fills every pool option from the defaults", () => {
  const options = buildPostgresOptions({
    connection: {
      host: "db.internal",
      port: 5432,
      user: "app",
      password: "secret",
      database: "app",
    },
  })

  assertEquals(options.connect_timeout, 10)
  assertEquals(options.idle_timeout, 30)
  assertEquals(options.max_lifetime, 1800)
  assertEquals(options.max, 15)
  assertEquals(DEFAULT_POOL_OPTIONS.connectTimeout, 10)
  assertEquals(DEFAULT_POOL_OPTIONS.idleTimeout, 30)
  assertEquals(DEFAULT_POOL_OPTIONS.maxLifetimeSeconds, 1800)
  assertEquals(DEFAULT_POOL_OPTIONS.max, 15)
  assertEquals(options.host, "db.internal")
  assertEquals(options.pass, "secret")
  // No `transform` and no `connection` key unless the caller asked for them: a default
  // transform would be a silent decision about every row in the process.
  assertStrictEquals(Object.hasOwn(options, "transform"), false)
  assertStrictEquals(options.connection, undefined)
})

Deno.test("buildPostgresOptions lets a caller override each pool option", () => {
  const options = buildPostgresOptions({
    connection: { host: "db.internal", user: "app", password: "secret", database: "app" },
    connectTimeout: 1,
    idleTimeout: 2,
    maxLifetimeSeconds: 3,
    max: 4,
  })

  assertEquals(options.connect_timeout, 1)
  assertEquals(options.idle_timeout, 2)
  assertEquals(options.max_lifetime, 3)
  assertEquals(options.max, 4)
  assertEquals(options.port, 5432)
})

Deno.test("buildPostgresOptions defaults the port to 5432 and honours an explicit one", () => {
  const connection = { host: "db.internal", user: "app", password: "secret", database: "app" }
  assertEquals(buildPostgresOptions({ connection }).port, 5432)
  assertEquals(buildPostgresOptions({ connection: { ...connection, port: 6432 } }).port, 6432)
})

Deno.test("buildPostgresOptions passes application_name and transform only when given", () => {
  const options = buildPostgresOptions({
    connection: { host: "db.internal", user: "app", password: "secret", database: "app" },
    applicationName: "app-backend",
    transform: postgres.camel,
  })

  assertEquals(options.connection, { application_name: "app-backend" })
  assertStrictEquals(Object.hasOwn(options, "transform"), true)
})

Deno.test("parsePostgresEnv returns undefined when DB_HOST is unset or empty", () => {
  assertStrictEquals(parsePostgresEnv({}), undefined)
  assertStrictEquals(parsePostgresEnv({ [PostgresEnvName.Host]: "" }), undefined)
})

Deno.test("parsePostgresEnv defaults the port to 5432 when DB_PORT is unset", () => {
  assertEquals(parsePostgresEnv({ [PostgresEnvName.Host]: "db.internal" })?.port, 5432)
  assertEquals(
    parsePostgresEnv({ [PostgresEnvName.Host]: "db.internal", [PostgresEnvName.Port]: "" })?.port,
    5432,
  )
})

Deno.test("parsePostgresEnv reads every field from the record it is given", () => {
  assertEquals(
    parsePostgresEnv({
      [PostgresEnvName.Host]: "db.internal",
      [PostgresEnvName.Port]: "6432",
      [PostgresEnvName.User]: "app",
      [PostgresEnvName.Pass]: "secret",
      [PostgresEnvName.Name]: "app_production",
    }),
    {
      host: "db.internal",
      port: 6432,
      user: "app",
      password: "secret",
      database: "app_production",
    },
  )
})

Deno.test("parsePostgresEnv rejects a port that is not a decimal integer", () => {
  for (const port of ["abc", "5432.5", "0x1f", "-1", " "]) {
    assertThrows(
      () => parsePostgresEnv({ [PostgresEnvName.Host]: "h", [PostgresEnvName.Port]: port }),
      RangeError,
    )
  }
})

Deno.test("parsePostgresEnv rejects a port outside the TCP range", () => {
  assertThrows(
    () => parsePostgresEnv({ [PostgresEnvName.Host]: "h", [PostgresEnvName.Port]: "65536" }),
    RangeError,
    "DB_PORT must be between 1 and 65535, got 65536",
  )
  assertThrows(
    () => parsePostgresEnv({ [PostgresEnvName.Host]: "h", [PostgresEnvName.Port]: "0" }),
    RangeError,
    "DB_PORT must be between 1 and 65535, got 0",
  )
})

Deno.test("parsePostgresEnv leaves an unset user, password and database empty", () => {
  assertEquals(parsePostgresEnv({ [PostgresEnvName.Host]: "db.internal" }), {
    host: "db.internal",
    port: 5432,
    user: "",
    password: "",
    database: "",
  })
})

Deno.test("createSqlFromEnv returns undefined rather than a client pointed at nothing", () => {
  assertStrictEquals(createSqlFromEnv({}), undefined)
})
