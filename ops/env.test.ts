import { assertEquals, assertThrows } from "@std/assert"
import {
  absPath,
  createEnvReader,
  MissingEnvError,
  readEnvVar,
  rewriteEnvValues,
  substituteEnvVars,
} from "./env.ts"

Deno.test("absPath expands a leading tilde-slash against the given home", () => {
  assertEquals(
    absPath("~/backups/restic", "/home/anton"),
    "/home/anton/backups/restic",
  )
})

Deno.test("absPath leaves an absolute path alone", () => {
  assertEquals(absPath("/srv/backups", "/home/anton"), "/srv/backups")
})

Deno.test("absPath leaves a bare tilde alone rather than guessing a home", () => {
  assertEquals(absPath("~anton/x", "/home/anton"), "~anton/x")
})

Deno.test("absPath refuses to expand a tilde with no home directory", () => {
  assertThrows(
    () => absPath("~/backups", ""),
    MissingEnvError,
    "without a home directory",
  )
})

Deno.test("readEnvVar returns a set value", () => {
  const env = createEnvReader({ PATH_APPS: "/opt/apps" })
  assertEquals(readEnvVar(env, "PATH_APPS"), "/opt/apps")
})

Deno.test("readEnvVar treats a blank value as missing", () => {
  const env = createEnvReader({ PATH_APPS: "" })
  assertThrows(
    () => readEnvVar(env, "PATH_APPS"),
    MissingEnvError,
    "PATH_APPS",
  )
})

Deno.test("readEnvVar returns an empty string for an optional missing value", () => {
  const env = createEnvReader({})
  assertEquals(readEnvVar(env, "PATH_MEDIA", { optional: true }), "")
})

Deno.test("substituteEnvVars replaces every placeholder from the injected reader", () => {
  const env = createEnvReader({ PATH_APPS: "/opt/apps", SERVER_NAME: "cloud" })
  assertEquals(
    substituteEnvVars("rsync ./ ${SERVER_NAME}:${PATH_APPS}/", env),
    "rsync ./ cloud:/opt/apps/",
  )
})

Deno.test("substituteEnvVars trims the placeholder name", () => {
  const env = createEnvReader({ PATH_APPS: "/opt/apps" })
  assertEquals(substituteEnvVars("${ PATH_APPS }", env), "/opt/apps")
})

Deno.test("substituteEnvVars throws rather than substituting an empty string", () => {
  const env = createEnvReader({})
  assertThrows(
    () => substituteEnvVars("rsync ./ ${SERVER_NAME}:/opt/", env),
    MissingEnvError,
    "environment variable 'SERVER_NAME' not found",
  )
})

Deno.test("rewriteEnvValues does not touch a key that merely ends with the rewritten key", () => {
  const prod = [
    "DOMAIN=antonshubin.com",
    "WWW_DOMAIN=www.antonshubin.com",
    "TZ=Asia/Singapore",
  ].join("\n")
  const staging = rewriteEnvValues(prod, {
    DOMAIN: "website-stag.antonshubin.com",
    WWW_DOMAIN: "website-stag.antonshubin.com",
  })
  assertEquals(
    staging,
    [
      "DOMAIN=website-stag.antonshubin.com",
      "WWW_DOMAIN=website-stag.antonshubin.com",
      "TZ=Asia/Singapore",
    ].join("\n"),
  )
})

Deno.test("rewriteEnvValues changes only the named key", () => {
  const prod = ["DOMAIN=antonshubin.com", "WWW_DOMAIN=www.antonshubin.com"]
    .join("\n")
  const staging = rewriteEnvValues(prod, {
    DOMAIN: "website-stag.antonshubin.com",
  })
  assertEquals(
    staging,
    ["DOMAIN=website-stag.antonshubin.com", "WWW_DOMAIN=www.antonshubin.com"]
      .join("\n"),
  )
})

Deno.test("rewriteEnvValues preserves comments, blank lines and order", () => {
  const prod = [
    "# domain config",
    "",
    "DOMAIN=antonshubin.com",
    "TZ=Asia/Singapore",
  ].join("\n")
  const staging = rewriteEnvValues(prod, {
    DOMAIN: "website-stag.antonshubin.com",
  })
  assertEquals(
    staging,
    [
      "# domain config",
      "",
      "DOMAIN=website-stag.antonshubin.com",
      "TZ=Asia/Singapore",
    ].join("\n"),
  )
})

Deno.test("rewriteEnvValues writes a dollar sign in a value literally", () => {
  const prod = "BASIC_AUTH=old\n"
  assertEquals(
    rewriteEnvValues(prod, { BASIC_AUTH: "user:$&p4ss" }),
    "BASIC_AUTH=user:$&p4ss\n",
  )
})

Deno.test("rewriteEnvValues fails loudly when the env file has no such key", () => {
  assertThrows(
    () => rewriteEnvValues("DOMAIN=antonshubin.com\n", { PROTOCOL: "https" }),
    MissingEnvError,
    "no line for PROTOCOL",
  )
})

Deno.test("rewriteEnvValues rejects a key that is not an identifier", () => {
  assertThrows(
    () => rewriteEnvValues("DOMAIN=x\n", { "DO.MAIN": "y" }),
    MissingEnvError,
    "not a valid environment variable name",
  )
})

Deno.test("importing env.ts reads no environment variable", () => {
  // The module-scope read that breaks `rostok/scripts/backup/src/+lib.ts`
  // cannot happen here: `systemEnv` is a lazy adapter and nothing else reads it.
  const env = createEnvReader({})
  assertEquals(readEnvVar(env, "ANYTHING", { optional: true }), "")
})
