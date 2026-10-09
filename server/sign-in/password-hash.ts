#!/usr/bin/env -S deno run --allow-env=AUTH_PEPPER
/**
 * Prints the hash of a password, as {@link createPasswordHasher} makes it, for an app's config
 * (such as the `ownerPassword.hash` of `@spy4x/server/mcp-oauth`). Meant to be a project's whole
 * `password:hash` task:
 *
 * ```jsonc
 * "password:hash": "deno run --allow-env=AUTH_PEPPER jsr:@spy4x/server/sign-in/password-hash"
 * ```
 *
 * The pepper comes from `AUTH_PEPPER` and must be the one the app runs with. The password is read
 * from standard input, never from an argument, so it stays out of the shell history and the process
 * list. At a terminal it is typed without echo; otherwise the whole input is the password, without
 * one trailing line break:
 *
 * ```sh
 * deno task password:hash                     # type it, then Enter
 * printf %s "$PASSWORD" | deno task password:hash
 * ```
 *
 * Ported from caldav-tasks-web's `infra/scripts/password-hash.ts`.
 * @module
 */

import { createPasswordHasher } from "./password.ts"

/** Where {@link runPasswordHash} gets its two inputs. */
export interface PasswordHashInput {
  /** The pepper, from `AUTH_PEPPER`; `undefined` when it is not set. */
  pepper: string | undefined
  /** Reads the password; `null` when the user cancelled. */
  readPassword(): Promise<string | null>
}

/** What {@link runPasswordHash} prints: the hash on success, otherwise a message without secrets. */
export interface PasswordHashResult {
  success: boolean
  output?: string
  error?: string
}

/** The password in piped input: everything but one trailing `\n` or `\r\n`. */
export function passwordFromInput(text: string): string {
  return text.replace(/\r?\n$/, "")
}

/**
 * Removes the last character from UTF-8 `bytes`, however many bytes it takes: the continuation
 * bytes (`10xxxxxx`) and the byte that starts it. Backspace calls it.
 */
export function eraseLastCharacter(bytes: number[]): void {
  while (bytes.length > 0 && (bytes[bytes.length - 1] & 0xc0) === 0x80) bytes.pop()
  bytes.pop()
}

/** What one byte typed at the hidden prompt does. */
export enum KeyResult {
  /** Keep reading. */
  Continue = 1,
  /** Enter: the line is complete. */
  Submit,
  /** Ctrl-C or Ctrl-D: give up. */
  Cancel,
}

/**
 * A line typed at the hidden prompt, fed one byte at a time. Enter submits, Ctrl-C and Ctrl-D
 * cancel, Backspace erases a character. Escape sequences, such as the ones arrow and function keys
 * send, are dropped from their `ESC` byte (0x1b) to their last byte, so they never end up inside
 * the password. A sequence split across two reads is still dropped whole.
 */
export class HiddenLine {
  /** The UTF-8 bytes typed so far. */
  readonly bytes: number[] = []
  #escape: "none" | "start" | "csi" | "ss3" = "none"

  /** Applies one typed byte. */
  type(byte: number): KeyResult {
    switch (this.#escape) {
      case "start":
        // `ESC [` starts a control sequence and `ESC O` a single-character one; any other byte
        // after `ESC` ends the sequence.
        this.#escape = byte === 0x5b ? "csi" : byte === 0x4f ? "ss3" : "none"
        return KeyResult.Continue
      case "csi":
        // Parameter and intermediate bytes go on until a final byte from `@` to `~`.
        if (byte >= 0x40 && byte <= 0x7e) this.#escape = "none"
        return KeyResult.Continue
      case "ss3":
        this.#escape = "none"
        return KeyResult.Continue
    }
    if (byte === 0x03 || byte === 0x04) return KeyResult.Cancel
    if (byte === 0x0d || byte === 0x0a) return KeyResult.Submit
    if (byte === 0x1b) this.#escape = "start"
    else if (byte === 0x7f || byte === 0x08) eraseLastCharacter(this.bytes)
    else this.bytes.push(byte)
    return KeyResult.Continue
  }
}

/**
 * Hashes the password `input` reads under its pepper. The pepper is checked before the password is
 * asked for, so a missing one costs no typing. Never throws, and no message names the password or
 * the pepper.
 */
export async function runPasswordHash(input: PasswordHashInput): Promise<PasswordHashResult> {
  let hasher
  try {
    hasher = createPasswordHasher({ pepper: input.pepper ?? "" })
  } catch {
    return { success: false, error: "Set AUTH_PEPPER (at least 32 characters) first." }
  }
  const password = await input.readPassword()
  if (!password) return { success: false, error: "No password given." }
  try {
    return { success: true, output: await hasher.hash(password) }
  } catch (error) {
    // The hasher's errors name the rule broken, never the password.
    return { success: false, error: error instanceof Error ? error.message : "Cannot hash it." }
  }
}

/** Reads one line from the terminal without echoing it. Returns `null` on Ctrl-C or Ctrl-D. */
async function readHidden(): Promise<string | null> {
  const encoder = new TextEncoder()
  await Deno.stderr.write(encoder.encode("Password (not shown): "))
  Deno.stdin.setRaw(true)
  const line = new HiddenLine()
  const buffer = new Uint8Array(64)
  try {
    while (true) {
      const read = await Deno.stdin.read(buffer)
      if (read === null) return null
      for (const byte of buffer.subarray(0, read)) {
        const result = line.type(byte)
        if (result === KeyResult.Cancel) return null
        if (result === KeyResult.Submit) {
          return new TextDecoder().decode(new Uint8Array(line.bytes))
        }
      }
    }
  } finally {
    buffer.fill(0)
    line.bytes.fill(0)
    Deno.stdin.setRaw(false)
    await Deno.stderr.write(encoder.encode("\n"))
  }
}

if (import.meta.main) {
  const result = await runPasswordHash({
    pepper: Deno.env.get("AUTH_PEPPER"),
    readPassword: async () =>
      Deno.stdin.isTerminal()
        ? await readHidden()
        : passwordFromInput(await new Response(Deno.stdin.readable).text()),
  })
  if (result.success) console.log(result.output)
  else console.error(result.error)
  Deno.exit(result.success ? 0 : 1)
}
