// Bundled by `../core-bundle.test.ts`: what a browser page that formats a price imports.
import { formatMoney, isCurrencyCode } from "../money.ts"

console.log(formatMoney(1250, `EUR`), isCurrencyCode(`EUR`))
