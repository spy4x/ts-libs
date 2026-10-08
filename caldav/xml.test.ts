// Behaviour tests for the WebDAV XML reader and the request builders. The recorded fixtures in
// `testdata/` are real responses from Stalwart 0.16 and Radicale 3.8 with the user, host and task
// text replaced.

import { assert, assertEquals, assertThrows } from "@std/assert"
import { describe, it } from "@std/testing/bdd"
import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  calendarMultigetBody,
  calendarQueryBody,
  CALENDARSERVER_NS,
  childElement,
  DAV_NS,
  type DavResponse,
  getProp,
  getPropText,
  mkcalendarBody,
  parseMultistatus,
  parseXml,
  propfindBody,
  proppatchBody,
  serializeXml,
  textContent,
  type XmlElement,
  xmlElement,
  XmlErrorCode,
  type XmlResult,
} from "./xml.ts"

const fixture = (name: string) => Deno.readTextFile(new URL(`./testdata/${name}`, import.meta.url))

function output<T>(result: XmlResult<T>): T {
  assert(result.success, `expected success, got ${result.error?.message}`)
  return result.output
}

function errorCode<T>(result: XmlResult<T>): XmlErrorCode {
  assert(!result.success, "expected the document to be refused")
  return result.error.code
}

const byHref = (responses: DavResponse[], suffix: string) => {
  const found = responses.find((response) => response.href.endsWith(suffix))
  assert(found, `no response ending in ${suffix}`)
  return found
}

describe("parseMultistatus on recorded Stalwart responses", () => {
  it("reads the calendar home with A:/D: prefixes, quoted ctags and encoded hrefs", async () => {
    const responses = output(
      parseMultistatus(await fixture("stalwart-propfind-home.xml")),
    )
    assertEquals(responses.length, 6)
    const inbox = byHref(responses, "/1.0%20%2F%20Inbox/")
    assertEquals(inbox.href, "/dav/cal/user%40example.com/1.0%20%2F%20Inbox/")
    assertEquals(getPropText(inbox, DAV_NS, "displayname"), "1.0 / Inbox")
    assertEquals(getPropText(inbox, CALENDARSERVER_NS, "getctag"), `"5542"`)
    const resourcetype = getProp(inbox, DAV_NS, "resourcetype")
    assert(resourcetype && childElement(resourcetype, CALDAV_NS, "calendar"))
    const components = getProp(
      inbox,
      CALDAV_NS,
      "supported-calendar-component-set",
    )
    assertEquals(
      components?.children.map((comp) => typeof comp !== "string" && comp.attributes[0].value),
      ["VTODO", "VEVENT"],
    )
  })

  it("keeps each propstat's status and ignores properties under a 404 propstat", async () => {
    const responses = output(
      parseMultistatus(await fixture("stalwart-propfind-home.xml")),
    )
    const inbox = byHref(responses, "/1.0%20%2F%20Inbox/")
    assertEquals(inbox.propstats.map((propstat) => propstat.status), [
      200,
      404,
    ])
    assertEquals(inbox.propstats[1].props.map((prop) => prop.name), [
      "calendar-color",
      "calendar-order",
    ])
    assertEquals(getProp(inbox, APPLE_ICAL_NS, "calendar-color"), undefined)
  })

  it("decodes etags to their quoted form and CDATA calendar data byte for byte", async () => {
    const responses = output(
      parseMultistatus(await fixture("stalwart-calendar-query.xml")),
    )
    assertEquals(responses.length, 4)
    const first = responses[0]
    assertEquals(
      first.href,
      "/dav/cal/user%40example.com/1.0%20%2F%20Inbox/3715224104002452840.ics",
    )
    assertEquals(getPropText(first, DAV_NS, "getetag"), `"2636778518"`)
    const data = getPropText(first, CALDAV_NS, "calendar-data") ?? ""
    assert(data.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"))
    assert(data.endsWith("END:VCALENDAR\r\n"))
    const cyrillic = getPropText(responses[1], CALDAV_NS, "calendar-data") ??
      ""
    assert(cyrillic.includes("SUMMARY:🛒 Купить новые лампочки в коридор\r\n"))
  })

  it("reads a 404 propstat for a property the resource lacks", async () => {
    const [response] = output(
      parseMultistatus(await fixture("stalwart-propfind-404.xml")),
    )
    assertEquals(getPropText(response, DAV_NS, "getetag"), `"2235220860"`)
    assertEquals(response.propstats[1].status, 404)
    assertEquals(
      response.propstats[1].props[0].namespace,
      "urn:example:missing",
    )
    assertEquals(
      getProp(response, "urn:example:missing", "no-such-property"),
      undefined,
    )
  })

  it("reads the principal and the calendar home set", async () => {
    const [response] = output(
      parseMultistatus(await fixture("stalwart-propfind-principal.xml")),
    )
    const principal = getProp(response, DAV_NS, "current-user-principal")
    const home = getProp(response, CALDAV_NS, "calendar-home-set")
    assertEquals(
      principal && textContent(principal),
      "/dav/pal/user%40example.com/",
    )
    assertEquals(home && textContent(home), "/dav/cal/user%40example.com/")
  })
})

describe("parseMultistatus on recorded Radicale responses", () => {
  it("resolves the default DAV: namespace and decodes &amp; in a display name", async () => {
    const responses = output(
      parseMultistatus(await fixture("radicale-propfind-home.xml")),
    )
    const inbox = byHref(responses, "/inbox/")
    assertEquals(getPropText(inbox, DAV_NS, "displayname"), `Inbox & "Later"`)
    const home = byHref(responses, "/user%40example.com/")
    assertEquals(home.propstats.map((propstat) => propstat.status), [200, 404])
    assertEquals(getProp(home, DAV_NS, "displayname"), undefined)
  })

  it("decodes entity-escaped calendar data and keeps a file name that differs from the UID", async () => {
    const [response] = output(
      parseMultistatus(await fixture("radicale-calendar-query.xml")),
    )
    assertEquals(response.href, "/user%40example.com/inbox/task-file-name.ics")
    assertEquals(
      getPropText(response, DAV_NS, "getetag"),
      `"81aae0839f994b318c18c4acea1896b00dafa0de7cc42c881249abab455ed167"`,
    )
    const data = getPropText(response, CALDAV_NS, "calendar-data") ?? ""
    assert(data.includes("SUMMARY:Water the plants & <check> the soil\r\n"))
    assert(data.includes("UID:6c1f0e52-7a4b-4f7e-9c3d-2b8e5a1d0f43\r\n"))
  })

  it("reads a 404 propstat under a generated ns1 prefix", async () => {
    const [response] = output(
      parseMultistatus(await fixture("radicale-propfind-404.xml")),
    )
    assertEquals(response.propstats.map((propstat) => propstat.status), [
      200,
      404,
    ])
    assertEquals(
      response.propstats[1].props[0].namespace,
      "urn:example:missing",
    )
  })

  it("reads a 404 calendar-home-set next to a found principal", async () => {
    const [response] = output(
      parseMultistatus(await fixture("radicale-propfind-principal.xml")),
    )
    const principal = getProp(response, DAV_NS, "current-user-principal")
    assertEquals(principal && textContent(principal), "/user%40example.com/")
    assertEquals(getProp(response, CALDAV_NS, "calendar-home-set"), undefined)
  })
})

describe("parseMultistatus shape", () => {
  it("reads a response-level status and every href of a status-only response", () => {
    const xml = `<d:multistatus xmlns:d="DAV:"><d:response><d:href> /a.ics </d:href>` +
      `<d:href>/b.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>` +
      `</d:multistatus>`
    const [response] = output(parseMultistatus(xml))
    assertEquals(response.hrefs, ["/a.ics", "/b.ics"])
    assertEquals(response.status, 404)
    assertEquals(response.propstats, [])
  })

  it("refuses a root element that is not DAV: multistatus", () => {
    const xml = `<multistatus xmlns="urn:other"/>`
    assertEquals(errorCode(parseMultistatus(xml)), XmlErrorCode.Malformed)
  })

  it("refuses a response without an href and a propstat without a status", () => {
    const noHref = `<multistatus xmlns="DAV:"><response><status>HTTP/1.1 200 OK</status>` +
      `</response></multistatus>`
    const noStatus = `<multistatus xmlns="DAV:"><response><href>/a</href><propstat><prop/>` +
      `</propstat></response></multistatus>`
    assertEquals(errorCode(parseMultistatus(noHref)), XmlErrorCode.Malformed)
    assertEquals(errorCode(parseMultistatus(noStatus)), XmlErrorCode.Malformed)
  })

  it("refuses a status line that is not an HTTP status", () => {
    const xml = `<multistatus xmlns="DAV:"><response><href>/a</href><propstat><prop/>` +
      `<status>200 OK</status></propstat></response></multistatus>`
    assertEquals(errorCode(parseMultistatus(xml)), XmlErrorCode.Malformed)
  })
})

describe("parseXml", () => {
  it("decodes the five predefined entities, numeric references and CDATA", () => {
    const xml = `<a>&lt;&gt;&amp;&quot;&apos;&#65;&#x1F600;<![CDATA[<b>&amp;</b>]]></a>`
    assertEquals(textContent(output(parseXml(xml))), `<>&"'A😀<b>&amp;</b>`)
  })

  it("decodes entities in attribute values", () => {
    const root = output(parseXml(`<c name='a &amp; &quot;b&quot;'/>`))
    assertEquals(root.attributes, [{
      namespace: "",
      name: "name",
      value: `a & "b"`,
    }])
  })

  it("resolves prefixes per scope, and a redeclared default namespace ends with its element", () => {
    const root = output(parseXml(
      `<p:a xmlns:p="urn:p" xmlns="urn:d"><b/><c xmlns="urn:e"><p:d/></c><q:e xmlns:q="urn:q"/><f/></p:a>`,
    ))
    const names = (element: XmlElement): string[] => [
      `${element.namespace} ${element.name}`,
      ...element.children.flatMap((child) => typeof child === "string" ? [] : names(child)),
    ]
    assertEquals(names(root), [
      "urn:p a",
      "urn:d b",
      "urn:e c",
      "urn:p d",
      "urn:q e",
      "urn:d f",
    ])
  })

  it("puts an unprefixed attribute in no namespace and a prefixed one in its namespace", () => {
    const root = output(
      parseXml(`<a xmlns="urn:d" xmlns:x="urn:x" k="1" x:k="2"/>`),
    )
    assertEquals(root.attributes, [
      { namespace: "", name: "k", value: "1" },
      { namespace: "urn:x", name: "k", value: "2" },
    ])
  })

  it("skips the declaration, comments, processing instructions and a byte order mark", () => {
    const xml = `\uFEFF<?xml version="1.0"?><!-- c --><a><?pi x?>t<!-- c -->u</a><!-- c -->\n`
    assertEquals(output(parseXml(xml)).children, ["tu"])
  })

  it("keeps carriage returns in text as sent", () => {
    assertEquals(textContent(output(parseXml(`<a>x\r\ny</a>`))), "x\r\ny")
  })

  it("refuses a DTD, even an empty one", () => {
    const xml = `<!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>`
    assertEquals(errorCode(parseXml(xml)), XmlErrorCode.Forbidden)
    assertEquals(
      errorCode(parseXml(`<!DOCTYPE a><a/>`)),
      XmlErrorCode.Forbidden,
    )
  })

  it("refuses an entity that is not predefined", () => {
    assertEquals(errorCode(parseXml(`<a>&nbsp;</a>`)), XmlErrorCode.Forbidden)
    assertEquals(errorCode(parseXml(`<a b="&e;"/>`)), XmlErrorCode.Forbidden)
  })

  it("refuses a character reference to a character XML does not allow", () => {
    for (
      const reference of ["&#0;", "&#xD800;", "&#x110000;", "&#;", "&#xZZ;"]
    ) {
      assertEquals(
        errorCode(parseXml(`<a>${reference}</a>`)),
        XmlErrorCode.Malformed,
        reference,
      )
    }
  })

  it("refuses a document over the byte limit, counting UTF-8 bytes", () => {
    const xml = `<a>${"я".repeat(10)}</a>` // 7 + 20 bytes, 17 code units
    assertEquals(
      errorCode(parseXml(xml, { maxBytes: 26 })),
      XmlErrorCode.TooLarge,
    )
    assert(parseXml(xml, { maxBytes: 27 }).success)
  })

  it("refuses nesting deeper than the depth limit", () => {
    const xml = "<a>".repeat(5) + "</a>".repeat(5)
    assertEquals(
      errorCode(parseXml(xml, { maxDepth: 4 })),
      XmlErrorCode.TooLarge,
    )
    assert(parseXml(xml, { maxDepth: 5 }).success)
  })

  it("refuses documents that are not well-formed", () => {
    const cases = [
      "",
      "text",
      "<a>",
      "<a></b>",
      "<a/><b/>",
      "<a/>trailing",
      "<a b=c/>",
      `<a b="1" b="2"/>`,
      `<a b="<"/>`,
      "<p:a/>",
      "<a><![CDATA[x</a>",
      "<a><!-- x</a>",
      "<a>&amp</a>",
      "<:a/>",
      "</a>",
    ]
    for (const xml of cases) {
      assertEquals(
        errorCode(parseXml(xml)),
        XmlErrorCode.Malformed,
        JSON.stringify(xml),
      )
    }
  })

  it("refuses element and attribute names that are not XML names", () => {
    for (const xml of [`<a<b/>`, `<1a/>`, `<a\u0000b/>`, `<a 1b="v"/>`, `<p:/>`, `<:a/>`]) {
      assertEquals(errorCode(parseXml(xml)), XmlErrorCode.Malformed, JSON.stringify(xml))
    }
  })

  it("quotes at most 64 characters of the document in an error", () => {
    const result = parseXml(`<${"a".repeat(10_000)}<b/>`)
    assert(!result.success)
    assertEquals(result.error.message, `invalid name "${"a".repeat(64)}…"`)
  })

  it("refuses declarations that rebind the reserved xml and xmlns prefixes", () => {
    for (
      const declaration of [
        `xmlns:xml="urn:x"`,
        `xmlns:xmlns="urn:x"`,
        `xmlns:p="http://www.w3.org/2000/xmlns/"`,
        `xmlns="http://www.w3.org/2000/xmlns/"`,
        `xmlns:p="http://www.w3.org/XML/1998/namespace"`,
        `xmlns:p=""`,
      ]
    ) {
      assertEquals(errorCode(parseXml(`<a ${declaration}/>`)), XmlErrorCode.Malformed, declaration)
    }
  })

  it("resolves the xml prefix without a declaration", () => {
    const root = output(
      parseXml(`<a xml:lang="en"/>`),
    )
    assertEquals(root.attributes, [{
      namespace: "http://www.w3.org/XML/1998/namespace",
      name: "lang",
      value: "en",
    }])
  })

  it("refuses the same attribute written through two prefixes bound to one namespace", () => {
    const xml = `<a xmlns:p="urn:x" xmlns:q="urn:x" p:v="1" q:v="2"/>`
    assertEquals(errorCode(parseXml(xml)), XmlErrorCode.Malformed)
  })

  // Fixed budgets on large hostile inputs. Linear code parses each in well under a second; the
  // quadratic variants these tests guard against took six minutes or more (see the PR's mutation
  // lines), so the ten-second budget leaves room for a loaded machine and is still far from them.
  const budgetMs = 10_000
  const maxBytes = 64 * 1024 * 1024
  const assertParsesWithin = (xml: string) => {
    const start = performance.now()
    output(parseXml(xml, { maxBytes }))
    const elapsed = performance.now() - start
    assert(elapsed < budgetMs, `parsing took ${elapsed.toFixed(0)} ms, budget ${budgetMs} ms`)
  }
  const declarations = (count: number, uri: (i: number) => string) =>
    Array.from({ length: count }, (_, i) => ` xmlns:p${i}="${uri(i)}"`).join("")

  it("parses a 10 MB flat document within its time budget", () => {
    const item = `<d:response><d:href>/a&amp;b.ics</d:href></d:response>`
    assertParsesWithin(`<d:multistatus xmlns:d="DAV:">${item.repeat(200_000)}</d:multistatus>`)
  })

  it("parses 80,000 root declarations over 80,000 children within its time budget", () => {
    assertParsesWithin(`<a${declarations(80_000, (i) => `urn:${i}`)}>${"<b/>".repeat(80_000)}</a>`)
  })

  it("parses 80,000 root declarations over 80,000 declaring children within its time budget", () => {
    assertParsesWithin(
      `<r${declarations(80_000, () => "u")}>${`<a xmlns="u"/>`.repeat(80_000)}</r>`,
    )
  })
})

describe("request builders", () => {
  it("round-trips any text and attribute value through serializeXml and parseXml", () => {
    // Fixed-seed generator: deterministic, covers every character the escaper handles.
    let seed = 0x2f6b1d
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    const alphabet = [..."<>&\"' \t\r\nab;#x:я😀]]>"]
    for (let run = 0; run < 200; run++) {
      const value = Array.from(
        { length: 1 + Math.floor(random() * 30) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join("")
      const tree: XmlElement = {
        namespace: DAV_NS,
        name: "a",
        attributes: [{ namespace: "urn:x", name: "v", value }],
        children: [value],
      }
      assertEquals(
        output(parseXml(serializeXml(tree))),
        tree,
        JSON.stringify(value),
      )
    }
  })

  it("refuses element and attribute names that would inject markup", () => {
    const evil = "getetag/><D:evil/><D:x"
    assertThrows(() => propfindBody([{ namespace: DAV_NS, name: evil }]), TypeError)
    for (const name of ["a<b", "1a", "a b", "", "p:a"]) {
      assertThrows(() => serializeXml(xmlElement(DAV_NS, name)), TypeError, undefined, name)
      assertThrows(
        () => serializeXml(xmlElement(DAV_NS, "a", [], [{ namespace: "", name, value: "" }])),
        TypeError,
        undefined,
        name,
      )
    }
  })

  it("refuses an unprefixed xmlns attribute, which would redeclare the default namespace", () => {
    const tree = xmlElement(DAV_NS, "a", [xmlElement(DAV_NS, "b")], [{
      namespace: "",
      name: "xmlns",
      value: "urn:other",
    }])
    assertThrows(() => serializeXml(tree), TypeError)
  })

  it("refuses characters XML 1.0 cannot carry, in text and in attribute values", () => {
    for (const bad of ["\u0001", "\u001f", "\ufffe", "\ud800", "a\udc00b"]) {
      assertThrows(() => serializeXml(xmlElement(DAV_NS, "a", [bad])), RangeError)
      assertThrows(
        () => serializeXml(xmlElement(DAV_NS, "a", [], [{ namespace: "", name: "v", value: bad }])),
        RangeError,
      )
    }
    assertEquals(
      textContent(output(parseXml(serializeXml(xmlElement(DAV_NS, "a", ["😀\t\n"]))))),
      "😀\t\n",
    )
  })

  it("writes carriage returns, and line breaks and tabs in attributes, as references", () => {
    const tree = xmlElement(DAV_NS, "a", ["x\r\ny"], [{
      namespace: "",
      name: "v",
      value: "\r\n\t",
    }])
    const xml = serializeXml(tree)
    assert(xml.includes(`v="&#13;&#10;&#9;"`), xml)
    assert(xml.includes(`>x&#13;\ny<`), xml)
    assertEquals(output(parseXml(xml)), tree)
  })

  it("writes an xml:lang attribute without declaring the xml prefix", () => {
    const xmlNs = "http://www.w3.org/XML/1998/namespace"
    const tree = xmlElement(DAV_NS, "a", [], [{ namespace: xmlNs, name: "lang", value: "en" }])
    const xml = serializeXml(tree)
    assert(xml.includes(` xml:lang="en"`) && !xml.includes("xmlns:xml"), xml)
    assertEquals(output(parseXml(xml)), tree)
  })

  it("writes a PROPFIND that asks for each property in its namespace", () => {
    const body = propfindBody([
      { namespace: DAV_NS, name: "getetag" },
      { namespace: CALENDARSERVER_NS, name: "getctag" },
    ])
    const prop = childElement(output(parseXml(body)), DAV_NS, "prop")
    assertEquals(
      prop?.children.map((child) => typeof child !== "string" && child.namespace),
      [
        DAV_NS,
        CALENDARSERVER_NS,
      ],
    )
  })

  it("writes a calendar-query without a time range when none is given", () => {
    for (const timeRange of [undefined, {}]) {
      const body = calendarQueryBody({ component: "VTODO", timeRange })
      assert(!body.includes("time-range"), body)
      assert(body.includes(`name="VTODO"`), body)
    }
  })

  it("writes a calendar-query with the component and a UTC time range", () => {
    const body = calendarQueryBody({
      component: "VEVENT",
      timeRange: {
        start: new Date(Date.UTC(2026, 9, 1)),
        end: new Date(Date.UTC(2026, 10, 1)),
      },
    })
    const root = output(parseXml(body))
    assertEquals([root.namespace, root.name], [CALDAV_NS, "calendar-query"])
    const outer = childElement(
      childElement(root, CALDAV_NS, "filter")!,
      CALDAV_NS,
      "comp-filter",
    )!
    const inner = childElement(outer, CALDAV_NS, "comp-filter")!
    assertEquals(inner.attributes[0].value, "VEVENT")
    assertEquals(
      childElement(inner, CALDAV_NS, "time-range")?.attributes.map((a) => a.value),
      [
        "20261001T000000Z",
        "20261101T000000Z",
      ],
    )
  })

  it("writes multiget hrefs exactly as given, escaped", () => {
    const hrefs = ["/cal/user%40example.com/a%2Fb.ics", "/cal/x&y.ics"]
    const body = calendarMultigetBody(hrefs)
    assert(body.includes("/cal/x&amp;y.ics"))
    const root = output(parseXml(body))
    assertEquals(
      root.children.slice(1).map((href) => textContent(href as XmlElement)),
      hrefs,
    )
  })

  it("escapes a display name in MKCALENDAR and PROPPATCH bodies", () => {
    const name = `</D:displayname><D:owner>x</D:owner> & "quotes"`
    for (
      const body of [
        mkcalendarBody({ displayName: name, components: ["VTODO"] }),
        proppatchBody({ displayName: name, color: "#3366ff" }),
      ]
    ) {
      const root = output(parseXml(body))
      const prop = childElement(
        childElement(root, DAV_NS, "set")!,
        DAV_NS,
        "prop",
      )!
      assertEquals(getText(prop, DAV_NS, "displayname"), name)
      assertEquals(childElement(prop, DAV_NS, "owner"), undefined)
    }
  })
})

function getText(
  element: XmlElement,
  namespace: string,
  name: string,
): string | undefined {
  const child = childElement(element, namespace, name)
  return child && textContent(child)
}
