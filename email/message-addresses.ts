/**
 * The one place a message's mailbox fields are parsed, shared by every sender so
 * `to` and `replyTo` cannot drift apart. Internal: not an entry point.
 * @module
 */

import { parseAddresses, type ParsedRecipients } from "./address.ts"
import type { EmailMessage } from "./message.ts"

/** A message's parsed mailbox fields. */
export interface MessageAddresses {
  /** The parsed, deduplicated `to` list. */
  recipients: ParsedRecipients
  /** The parsed, deduplicated `replyTo` list; `undefined` when the message has none. */
  replyTo: ParsedRecipients | undefined
}

/**
 * Parse `to` and `replyTo` with the same function, naming the field in any error.
 *
 * A refused `replyTo` fails the whole message just as a refused `to` does, so the
 * error has to say which of the two it was: `replyTo: Invalid email address …`.
 *
 * @throws {TypeError} from `parseAddresses`, its message prefixed with the field name.
 */
export function parseMessageAddresses(message: EmailMessage): MessageAddresses {
  const recipients = parseField("to", message.to)
  const replyTo = message.replyTo === undefined ? undefined : parseField("replyTo", message.replyTo)
  return { recipients, replyTo }
}

/** `parseAddresses`, with the field name in front of the error message. */
function parseField(field: string, values: string | readonly string[]): ParsedRecipients {
  try {
    return parseAddresses(values)
  } catch (error) {
    if (error instanceof TypeError) throw new TypeError(`${field}: ${error.message}`)
    throw error
  }
}
