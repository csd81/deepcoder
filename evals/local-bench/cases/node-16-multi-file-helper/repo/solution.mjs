import { cents } from "./helpers.mjs";
export function totalCents(prices) {
  return prices.reduce((s, p) => s + cents(p), 0);
}
