import { formatMoney, parseMoney } from "@spy4x/platform/universal/money"

const price = 123456 // the smallest unit: cents, or whole yen

console.log(formatMoney(price, "EUR"))
console.log(formatMoney(price, "EUR", "de"))
console.log(formatMoney(price, "JPY"))
console.log(parseMoney("12,50", "EUR", "de"))
