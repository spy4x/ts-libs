/**
 * WebDAV XML: a namespace-aware reader for the subset CalDAV servers send (multistatus), and
 * request builders that escape every value they write.
 *
 * The reader is a single forward pass over the text: no regular expression runs over the whole
 * document, so its time is linear in the input. It refuses a DTD and any entity other than the
 * five predefined ones and numeric references, so a document cannot expand itself, and it refuses
 * input over a size limit and elements nested deeper than a depth limit.
 *
 * Text is returned exactly as decoded, line breaks included: `calendar-data` is iCalendar, whose
 * wire format is CRLF, so the reader does not apply XML's CRLF-to-LF normalisation.
 *
 * @module
 */

import { formatIcsUtc } from "@spy4x/time/ics-core"

/** The WebDAV namespace (RFC 4918). */
export const DAV_NS = "DAV:"
/** The CalDAV namespace (RFC 4791). */
export const CALDAV_NS = "urn:ietf:params:xml:ns:caldav"
/** The CalendarServer namespace, home of `getctag`. */
export const CALENDARSERVER_NS = "http://calendarserver.org/ns/"
/** Apple's iCal namespace, home of `calendar-color` and `calendar-order`. */
export const APPLE_ICAL_NS = "http://apple.com/ns/ical/"

const XML_NS = "http://www.w3.org/XML/1998/namespace"

/** Default size limit of {@link parseXml} and {@link parseMultistatus}: 10 MiB of UTF-8. */
export const DEFAULT_MAX_XML_BYTES: number = 10 * 1024 * 1024
/** Default nesting limit of {@link parseXml} and {@link parseMultistatus}. */
export const DEFAULT_MAX_XML_DEPTH: number = 64

/** Why a document was refused. */
export enum XmlErrorCode {
  /** The document is larger than `maxBytes` or nested deeper than `maxDepth`. */
  TooLarge = 1,
  /** The document declares a DTD or uses an entity other than the predefined ones. */
  Forbidden,
  /** The document is not well-formed, or not the expected WebDAV shape. */
  Malformed,
}

/** A refused document: the code to branch on and a message for logs. */
export interface XmlError {
  code: XmlErrorCode
  message: string
}

/** The outcome of a parse: the value, or why the document was refused. */
export type XmlResult<T> =
  | { success: true; output: T; error: null }
  | { success: false; output: null; error: XmlError }

/** A namespace-qualified name. `namespace` is `""` for a name in no namespace. */
export interface XmlName {
  namespace: string
  name: string
}

/** An attribute with its namespace resolved. `xmlns` declarations are not listed. */
export interface XmlAttribute extends XmlName {
  value: string
}

/** An element with its namespace resolved. Adjacent text and CDATA are merged into one string. */
export interface XmlElement extends XmlName {
  attributes: XmlAttribute[]
  children: XmlNode[]
}

/** A child of an element: another element, or decoded text. */
export type XmlNode = XmlElement | string

/** Limits for {@link parseXml} and {@link parseMultistatus}. */
export interface XmlParseOptions {
  /** Refuse a document longer than this many UTF-8 bytes. Default {@link DEFAULT_MAX_XML_BYTES}. */
  maxBytes?: number
  /** Refuse elements nested deeper than this. Default {@link DEFAULT_MAX_XML_DEPTH}. */
  maxDepth?: number
}

class XmlFailure extends Error {
  constructor(readonly code: XmlErrorCode, message: string) {
    super(message)
  }
}

/** Shorten document text quoted in an error message, so a hostile document cannot make it huge. */
const clip = (text: string) => text.length > 64 ? `${text.slice(0, 64)}…` : text

const fail = (code: XmlErrorCode, message: string): never => {
  throw new XmlFailure(code, message)
}

const PREDEFINED: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: `"`,
  apos: "'",
}

/** Decode the five predefined entities and numeric character references in `raw`. */
function decodeEntities(raw: string): string {
  let at = raw.indexOf("&")
  if (at === -1) return raw
  let out = ""
  let from = 0
  while (at !== -1) {
    const end = raw.indexOf(";", at)
    if (end === -1) {
      fail(XmlErrorCode.Malformed, "an `&` is not followed by an entity")
    }
    const entity = raw.slice(at + 1, end)
    out += raw.slice(from, at)
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x"
      const digits = entity.slice(hex ? 2 : 1)
      const valid = hex ? /^[0-9a-fA-F]{1,6}$/.test(digits) : /^[0-9]{1,7}$/.test(digits)
      const code = valid ? parseInt(digits, hex ? 16 : 10) : -1
      const allowed = code === 0x9 || code === 0xa || code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      if (!allowed) {
        fail(XmlErrorCode.Malformed, `invalid character reference &${clip(entity)};`)
      }
      out += String.fromCodePoint(code)
    } else if (Object.hasOwn(PREDEFINED, entity)) {
      out += PREDEFINED[entity]
    } else {
      fail(
        XmlErrorCode.Forbidden,
        `entity &${clip(entity)}; is not one of the predefined five`,
      )
    }
    from = end + 1
    at = raw.indexOf("&", from)
  }
  return out + raw.slice(from)
}

/** The UTF-8 length of `text`, without allocating an encoded copy. */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    if (unit < 0x80) bytes += 1
    else if (unit < 0x800) bytes += 2
    else if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

const isSpace = (char: string) => char === " " || char === "\t" || char === "\n" || char === "\r"

const XMLNS_NS = "http://www.w3.org/2000/xmlns/"

/**
 * An XML name without a colon (an NCName), simplified to the ranges that matter here: a letter,
 * `_` or any non-ASCII character first, then also digits, `-` and `.`. Run on one name at a time.
 */
const NC_NAME = /^[A-Za-z_\u00C0-\uFFFF][A-Za-z0-9_.\-\u00B7\u00C0-\uFFFF]*$/

/**
 * An open element and the namespaces it declares itself. Scopes are not copied: a prefix is
 * resolved by walking up the open elements, at most `maxDepth` of them, so the cost per name is
 * bounded however many declarations the document makes.
 */
interface OpenElement {
  qname: string
  element: XmlElement
  declared: Map<string, string> | null
}

/** Split `prefix:local`, refusing anything that is not a valid qualified name. */
function splitQName(qname: string): [string, string] {
  const colon = qname.indexOf(":")
  const prefix = colon === -1 ? "" : qname.slice(0, colon)
  const local = colon === -1 ? qname : qname.slice(colon + 1)
  if ((colon !== -1 && !NC_NAME.test(prefix)) || !NC_NAME.test(local)) {
    fail(XmlErrorCode.Malformed, `invalid name "${clip(qname)}"`)
  }
  return [prefix, local]
}

/** The namespace bound to `prefix` ("" for the default) by `own` or the open elements. */
function lookupPrefix(
  stack: OpenElement[],
  own: Map<string, string> | null,
  prefix: string,
): string | undefined {
  const mine = own?.get(prefix)
  if (mine !== undefined) return mine
  for (let i = stack.length - 1; i >= 0; i--) {
    const found = stack[i].declared?.get(prefix)
    if (found !== undefined) return found
  }
  if (prefix === "xml") return XML_NS
  return prefix === "" ? "" : undefined
}

function resolvePrefix(
  stack: OpenElement[],
  own: Map<string, string> | null,
  prefix: string,
  qname: string,
): string {
  const namespace = lookupPrefix(stack, own, prefix)
  if (namespace === undefined) {
    fail(XmlErrorCode.Malformed, `unbound prefix in "${clip(qname)}"`)
  }
  return namespace as string
}

/** Refuse the declarations the Namespaces spec forbids: rebinding `xml` or `xmlns`. */
function checkDeclaration(prefix: string, namespace: string): void {
  const reserved = prefix === "xml" ? namespace !== XML_NS : prefix === "xmlns" ||
    namespace === XMLNS_NS || (namespace === XML_NS && prefix !== "xml")
  if (reserved) fail(XmlErrorCode.Malformed, `reserved namespace binding for "${clip(prefix)}"`)
  if (prefix !== "" && namespace === "") {
    fail(XmlErrorCode.Malformed, `empty namespace for xmlns:${clip(prefix)}`)
  }
}

/**
 * Parse an XML document into a tree of elements with resolved namespaces.
 *
 * Accepts the XML declaration, processing instructions and comments (all skipped), CDATA sections,
 * the five predefined entities and numeric references. Refuses a `<!DOCTYPE`, any other entity, a
 * document over `maxBytes` and nesting deeper than `maxDepth`.
 */
export function parseXml(
  text: string,
  options: XmlParseOptions = {},
): XmlResult<XmlElement> {
  try {
    return { success: true, output: tokenize(text, options), error: null }
  } catch (error) {
    if (!(error instanceof XmlFailure)) throw error
    return {
      success: false,
      output: null,
      error: { code: error.code, message: error.message },
    }
  }
}

function tokenize(text: string, options: XmlParseOptions): XmlElement {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_XML_BYTES
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_XML_DEPTH
  // A UTF-16 code unit is never more than its UTF-8 bytes, so the cheap check can only refuse.
  if (text.length > maxBytes || utf8Length(text) > maxBytes) {
    fail(XmlErrorCode.TooLarge, `document is larger than ${maxBytes} bytes`)
  }
  const stack: OpenElement[] = []
  let root: XmlElement | null = null
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0

  const addText = (value: string) => {
    const top = stack.at(-1)
    if (top === undefined) {
      for (const char of value) {
        if (!isSpace(char)) {
          fail(XmlErrorCode.Malformed, "text outside the root element")
        }
      }
      return
    }
    if (value === "") return
    const children = top.element.children
    const last = children.length - 1
    if (typeof children[last] === "string") children[last] += value
    else children.push(value)
  }

  const skipTo = (marker: string, what: string): number => {
    const end = text.indexOf(marker, pos)
    if (end === -1) fail(XmlErrorCode.Malformed, `unterminated ${what}`)
    return end + marker.length
  }

  while (pos < text.length) {
    const lt = text.indexOf("<", pos)
    if (lt === -1) {
      addText(decodeEntities(text.slice(pos)))
      break
    }
    if (lt > pos) addText(decodeEntities(text.slice(pos, lt)))
    pos = lt
    if (text.startsWith("<?", pos)) {
      pos = skipTo("?>", "processing instruction")
    } else if (text.startsWith("<!--", pos)) {
      pos = skipTo("-->", "comment")
    } else if (text.startsWith("<![CDATA[", pos)) {
      if (stack.length === 0) {
        fail(XmlErrorCode.Malformed, "CDATA outside the root element")
      }
      const start = pos + 9
      pos = skipTo("]]>", "CDATA section")
      addText(text.slice(start, pos - 3))
    } else if (text.startsWith("<!", pos)) {
      fail(
        XmlErrorCode.Forbidden,
        "a DTD or markup declaration is not accepted",
      )
    } else if (text.startsWith("</", pos)) {
      const end = skipTo(">", "end tag")
      const qname = text.slice(pos + 2, end - 1).trimEnd()
      const open = stack.pop()
      if (open === undefined || open.qname !== qname) {
        fail(XmlErrorCode.Malformed, `unexpected end tag </${clip(qname)}>`)
      }
      pos = end
    } else {
      pos = readStartTag(pos + 1)
    }
  }
  if (root === null) fail(XmlErrorCode.Malformed, "no root element")
  if (stack.length > 0) {
    fail(XmlErrorCode.Malformed, `unclosed element <${clip(stack.at(-1)?.qname ?? "")}>`)
  }
  return root as unknown as XmlElement

  function readStartTag(from: number): number {
    let at = from
    while (
      at < text.length && !isSpace(text[at]) && text[at] !== ">" &&
      text[at] !== "/"
    ) at++
    const qname = text.slice(from, at)
    if (qname === "") fail(XmlErrorCode.Malformed, "an element has no name")
    const rawAttributes: [string, string][] = []
    let selfClosing = false
    for (;;) {
      while (at < text.length && isSpace(text[at])) at++
      if (at >= text.length) {
        fail(XmlErrorCode.Malformed, `unterminated start tag <${clip(qname)}`)
      }
      if (text[at] === ">") break
      if (text.startsWith("/>", at)) {
        selfClosing = true
        at++
        break
      }
      const nameStart = at
      while (
        at < text.length && !isSpace(text[at]) && !"=/>".includes(text[at])
      ) at++
      const name = text.slice(nameStart, at)
      while (at < text.length && isSpace(text[at])) at++
      if (name === "" || text[at] !== "=") {
        fail(XmlErrorCode.Malformed, `bad attribute in <${clip(qname)}`)
      }
      at++
      while (at < text.length && isSpace(text[at])) at++
      const quote = text[at]
      if (quote !== `"` && quote !== "'") {
        fail(XmlErrorCode.Malformed, `unquoted attribute ${clip(name)}`)
      }
      const close = text.indexOf(quote, at + 1)
      if (close === -1) {
        fail(XmlErrorCode.Malformed, `unterminated attribute ${clip(name)}`)
      }
      const raw = text.slice(at + 1, close)
      if (raw.includes("<")) {
        fail(XmlErrorCode.Malformed, `"<" in attribute ${clip(name)}`)
      }
      rawAttributes.push([name, decodeEntities(raw)])
      at = close + 1
    }
    if (stack.length === 0 && root !== null) {
      fail(XmlErrorCode.Malformed, "more than one root element")
    }
    if (stack.length >= maxDepth) {
      fail(XmlErrorCode.TooLarge, `elements nested deeper than ${maxDepth}`)
    }
    let declared: Map<string, string> | null = null
    const seen = new Set<string>()
    for (const [name, value] of rawAttributes) {
      if (seen.has(name)) {
        fail(XmlErrorCode.Malformed, `duplicate attribute ${clip(name)}`)
      }
      seen.add(name)
      if (name !== "xmlns" && !name.startsWith("xmlns:")) continue
      const declaredPrefix = name === "xmlns" ? "" : splitQName(name)[1]
      checkDeclaration(declaredPrefix, value)
      declared ??= new Map()
      declared.set(declaredPrefix, value)
    }
    const [prefix, local] = splitQName(qname)
    const element: XmlElement = {
      namespace: resolvePrefix(stack, declared, prefix, qname),
      name: local,
      attributes: [],
      children: [],
    }
    const attributeNames = new Set<string>()
    for (const [name, value] of rawAttributes) {
      if (name === "xmlns" || name.startsWith("xmlns:")) continue
      const [attributePrefix, attributeLocal] = splitQName(name)
      const namespace = attributePrefix === ""
        ? ""
        : resolvePrefix(stack, declared, attributePrefix, name)
      // Two prefixes bound to one namespace still name the same attribute.
      const key = `${namespace} ${attributeLocal}`
      if (attributeNames.has(key)) fail(XmlErrorCode.Malformed, `duplicate attribute ${clip(name)}`)
      attributeNames.add(key)
      element.attributes.push({ namespace, name: attributeLocal, value })
    }
    const parent = stack.at(-1)
    if (parent === undefined) root = element
    else parent.element.children.push(element)
    if (!selfClosing) stack.push({ qname, element, declared })
    return at + 1
  }
}

/** The child elements of `element` named `namespace`/`name`, in document order. */
export function childElements(
  element: XmlElement,
  namespace: string,
  name: string,
): XmlElement[] {
  return element.children.filter((child): child is XmlElement =>
    typeof child !== "string" && child.namespace === namespace &&
    child.name === name
  )
}

/** The first child element of `element` named `namespace`/`name`. */
export function childElement(
  element: XmlElement,
  namespace: string,
  name: string,
): XmlElement | undefined {
  return childElements(element, namespace, name)[0]
}

/** All text under `element`, in document order, with nothing trimmed. */
export function textContent(element: XmlElement): string {
  let out = ""
  for (const child of element.children) {
    out += typeof child === "string" ? child : textContent(child)
  }
  return out
}

/** One `propstat` of a `response`: its HTTP status and the property elements under it. */
export interface DavPropstat {
  status: number
  props: XmlElement[]
}

/** One `response` of a multistatus. */
export interface DavResponse {
  /** The first `href`, exactly as the server sent it (percent-encoding kept). */
  href: string
  /** Every `href` of the response; a status-only response may name several. */
  hrefs: string[]
  /** The response-level status (a resource-wide result such as 404), when the server sent one. */
  status?: number
  /** Each `propstat` with its own status. A 404 propstat names properties the resource lacks. */
  propstats: DavPropstat[]
}

/** The status code from a WebDAV status line such as `HTTP/1.1 404 Not Found`. */
function parseStatusLine(line: string): number {
  const match = /^HTTP\/\d+(?:\.\d+)?\s+(\d{3})(?:\s|$)/.exec(line.trim())
  if (match === null) {
    fail(XmlErrorCode.Malformed, `invalid status line "${clip(line.trim())}"`)
  }
  return Number((match as RegExpExecArray)[1])
}

/**
 * Parse a `207 Multi-Status` body into its responses.
 *
 * Every `propstat` keeps its own status; read properties through {@link getProp} or
 * {@link getPropText}, which look only at 2xx propstats, so a value under a 404 propstat is never
 * mistaken for a real one. Hrefs and status lines are trimmed of surrounding whitespace; property
 * text is not.
 */
export function parseMultistatus(
  text: string,
  options: XmlParseOptions = {},
): XmlResult<DavResponse[]> {
  const parsed = parseXml(text, options)
  if (!parsed.success) return parsed
  try {
    const root = parsed.output
    if (root.namespace !== DAV_NS || root.name !== "multistatus") {
      fail(
        XmlErrorCode.Malformed,
        `root element is {${clip(root.namespace)}}${clip(root.name)}, not multistatus`,
      )
    }
    const responses = childElements(root, DAV_NS, "response").map(
      (response) => {
        const hrefs = childElements(response, DAV_NS, "href").map((href) =>
          textContent(href).trim()
        )
        if (hrefs.length === 0 || hrefs.includes("")) {
          fail(XmlErrorCode.Malformed, "response has no href")
        }
        const statusElement = childElement(response, DAV_NS, "status")
        const propstats = childElements(response, DAV_NS, "propstat").map(
          (propstat) => {
            const status = childElement(propstat, DAV_NS, "status")
            if (status === undefined) {
              fail(XmlErrorCode.Malformed, "propstat has no status")
            }
            const prop = childElement(propstat, DAV_NS, "prop")
            return {
              status: parseStatusLine(textContent(status as XmlElement)),
              props: prop === undefined
                ? []
                : prop.children.filter((child): child is XmlElement => typeof child !== "string"),
            }
          },
        )
        const result: DavResponse = { href: hrefs[0], hrefs, propstats }
        if (statusElement !== undefined) {
          result.status = parseStatusLine(textContent(statusElement))
        }
        return result
      },
    )
    return { success: true, output: responses, error: null }
  } catch (error) {
    if (!(error instanceof XmlFailure)) throw error
    return {
      success: false,
      output: null,
      error: { code: error.code, message: error.message },
    }
  }
}

/** The property `namespace`/`name` from a 2xx propstat of `response`; never from a 404 one. */
export function getProp(
  response: DavResponse,
  namespace: string,
  name: string,
): XmlElement | undefined {
  for (const propstat of response.propstats) {
    if (propstat.status < 200 || propstat.status > 299) continue
    const found = propstat.props.find((prop) => prop.namespace === namespace && prop.name === name)
    if (found !== undefined) return found
  }
  return undefined
}

/** The text of {@link getProp}, untrimmed, or `undefined` when the property is not there. */
export function getPropText(
  response: DavResponse,
  namespace: string,
  name: string,
): string | undefined {
  const prop = getProp(response, namespace, name)
  return prop === undefined ? undefined : textContent(prop)
}

/** Characters XML 1.0 cannot carry at all, not even as a reference, and lone surrogates. */
const NOT_XML_CHAR =
  // deno-lint-ignore no-control-regex -- matching control characters is the point of this pattern
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

const ESCAPE_FOR: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
  "\r": "&#13;",
  "\n": "&#10;",
  "\t": "&#9;",
}

/**
 * Escape text for an XML element body or a double-quoted attribute value. A carriage return is
 * written as `&#13;` so that a reader's line-ending normalisation cannot drop it. Throws a
 * `RangeError` on a character XML 1.0 cannot carry, such as U+0001 or a lone surrogate.
 */
export function escapeXml(value: string): string {
  return escapeWith(value, /[&<>"'\r]/g)
}

/** {@link escapeXml}, plus line feeds and tabs, which a reader would turn into spaces in an attribute. */
function escapeAttribute(value: string): string {
  return escapeWith(value, /[&<>"'\r\n\t]/g)
}

function escapeWith(value: string, special: RegExp): string {
  const bad = NOT_XML_CHAR.exec(value)
  if (bad !== null) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
    throw new RangeError(`U+${code} cannot be written in XML`)
  }
  return value.replace(special, (char) => ESCAPE_FOR[char])
}

/** Throw a `TypeError` unless `name` is a valid XML name without a prefix. */
function assertXmlName(name: string): void {
  if (!NC_NAME.test(name)) throw new TypeError(`"${clip(name)}" is not a valid XML name`)
}

/**
 * Serialise an element tree as an XML document. Every namespace gets a generated prefix declared
 * on the root, and every text and attribute value is escaped, so `parseXml(serializeXml(e))`
 * gives back an equal tree. Throws a `TypeError` on a name that is not a valid XML name, so a
 * property name cannot inject markup, and a `RangeError` on text XML cannot carry.
 */
export function serializeXml(root: XmlElement): string {
  // The `xml` prefix is bound by definition and may not be declared again.
  const prefixes = new Map<string, string>([[XML_NS, "xml"]])
  const collect = (element: XmlElement) => {
    for (const attribute of element.attributes) {
      // An unprefixed `xmlns` attribute would be read as a default namespace declaration.
      if (attribute.namespace === "" && attribute.name === "xmlns") {
        throw new TypeError("namespace declarations are written by serializeXml itself")
      }
    }
    for (const name of [element, ...element.attributes]) {
      assertXmlName(name.name)
      if (name.namespace === XMLNS_NS) {
        throw new TypeError("namespace declarations are written by serializeXml itself")
      }
      if (name.namespace !== "" && !prefixes.has(name.namespace)) {
        prefixes.set(
          name.namespace,
          name.namespace === DAV_NS ? "D" : `N${prefixes.size - 1}`,
        )
      }
    }
    for (const child of element.children) {
      if (typeof child !== "string") collect(child)
    }
  }
  collect(root)
  const qualify = (name: XmlName) =>
    name.namespace === "" ? name.name : `${prefixes.get(name.namespace)}:${name.name}`
  const write = (element: XmlElement, declarations: string): string => {
    const attributes = element.attributes
      .map((attribute) => ` ${qualify(attribute)}="${escapeAttribute(attribute.value)}"`)
      .join("")
    const open = `${qualify(element)}${declarations}${attributes}`
    if (element.children.length === 0) return `<${open}/>`
    const body = element.children
      .map((child) => typeof child === "string" ? escapeXml(child) : write(child, ""))
      .join("")
    return `<${open}>${body}</${qualify(element)}>`
  }
  const declarations = [...prefixes]
    .filter(([namespace]) => namespace !== XML_NS)
    .map(([namespace, prefix]) => ` xmlns:${prefix}="${escapeAttribute(namespace)}"`)
    .join("")
  return `<?xml version="1.0" encoding="utf-8"?>\n${write(root, declarations)}`
}

/** Build an element. A shorthand for request bodies. */
export function xmlElement(
  namespace: string,
  name: string,
  children: XmlNode[] = [],
  attributes: XmlAttribute[] = [],
): XmlElement {
  return { namespace, name, attributes, children }
}

const propElement = (props: XmlName[]) =>
  xmlElement(
    DAV_NS,
    "prop",
    props.map((prop) => xmlElement(prop.namespace, prop.name)),
  )

/** A `PROPFIND` body asking for `props`. */
export function propfindBody(props: XmlName[]): string {
  return serializeXml(xmlElement(DAV_NS, "propfind", [propElement(props)]))
}

/** Options of {@link calendarQueryBody}. */
export interface CalendarQueryOptions {
  /** The component to match inside `VCALENDAR`, such as `VTODO` or `VEVENT`. */
  component: string
  /** Properties to return. Default: `getetag` and `calendar-data`. */
  props?: XmlName[]
  /** Only components overlapping this range (RFC 4791 §9.9), sent as UTC. */
  timeRange?: { start?: Date; end?: Date }
}

const OBJECT_PROPS: XmlName[] = [
  { namespace: DAV_NS, name: "getetag" },
  { namespace: CALDAV_NS, name: "calendar-data" },
]

/** A `calendar-query` REPORT body (RFC 4791 §7.8). */
export function calendarQueryBody(options: CalendarQueryOptions): string {
  const range = options.timeRange
  const rangeAttributes: XmlAttribute[] = []
  if (range?.start) {
    rangeAttributes.push({
      namespace: "",
      name: "start",
      value: formatIcsUtc(range.start),
    })
  }
  if (range?.end) {
    rangeAttributes.push({
      namespace: "",
      name: "end",
      value: formatIcsUtc(range.end),
    })
  }
  const inner = xmlElement(
    CALDAV_NS,
    "comp-filter",
    rangeAttributes.length === 0 ? [] : [xmlElement(CALDAV_NS, "time-range", [], rangeAttributes)],
    [{ namespace: "", name: "name", value: options.component }],
  )
  const filter = xmlElement(CALDAV_NS, "filter", [
    xmlElement(CALDAV_NS, "comp-filter", [inner], [{
      namespace: "",
      name: "name",
      value: "VCALENDAR",
    }]),
  ])
  return serializeXml(
    xmlElement(CALDAV_NS, "calendar-query", [
      propElement(options.props ?? OBJECT_PROPS),
      filter,
    ]),
  )
}

/** A `calendar-multiget` REPORT body (RFC 4791 §7.9) for `hrefs`, written as given. */
export function calendarMultigetBody(
  hrefs: string[],
  props: XmlName[] = OBJECT_PROPS,
): string {
  return serializeXml(xmlElement(CALDAV_NS, "calendar-multiget", [
    propElement(props),
    ...hrefs.map((href) => xmlElement(DAV_NS, "href", [href])),
  ]))
}

/** Calendar collection properties written by {@link mkcalendarBody} and {@link proppatchBody}. */
export interface CalendarProps {
  displayName?: string
  /** Component names the calendar accepts, such as `["VTODO"]`. Only `MKCALENDAR` may set it. */
  components?: string[]
  /** A CSS colour such as `#3366ff`, stored in Apple's `calendar-color`. */
  color?: string
}

function calendarPropElements(props: CalendarProps): XmlElement[] {
  const out: XmlElement[] = []
  if (props.displayName !== undefined) {
    out.push(xmlElement(DAV_NS, "displayname", [props.displayName]))
  }
  if (props.components !== undefined) {
    out.push(xmlElement(
      CALDAV_NS,
      "supported-calendar-component-set",
      props.components.map((name) =>
        xmlElement(CALDAV_NS, "comp", [], [{
          namespace: "",
          name: "name",
          value: name,
        }])
      ),
    ))
  }
  if (props.color !== undefined) {
    out.push(xmlElement(APPLE_ICAL_NS, "calendar-color", [props.color]))
  }
  return out
}

/** A `MKCALENDAR` body (RFC 4791 §5.3.1). */
export function mkcalendarBody(props: CalendarProps): string {
  const prop = xmlElement(DAV_NS, "prop", calendarPropElements(props))
  return serializeXml(
    xmlElement(CALDAV_NS, "mkcalendar", [xmlElement(DAV_NS, "set", [prop])]),
  )
}

/** A `PROPPATCH` body that sets the given calendar properties (RFC 4918 §9.2). */
export function proppatchBody(
  props: Omit<CalendarProps, "components">,
): string {
  const prop = xmlElement(DAV_NS, "prop", calendarPropElements(props))
  return serializeXml(
    xmlElement(DAV_NS, "propertyupdate", [xmlElement(DAV_NS, "set", [prop])]),
  )
}
