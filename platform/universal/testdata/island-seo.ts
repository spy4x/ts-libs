// A theme island that writes JSON-LD, as preact-components' theme does.
import { jsonLdText } from "../seo.ts"

console.log(jsonLdText({ "@type": "WebSite" }))
