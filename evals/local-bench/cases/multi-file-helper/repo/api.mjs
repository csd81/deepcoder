import { cents } from "./helpers.mjs";

// Total a list of dollar prices, in integer cents.
export function totalCents(prices) {
  return prices.reduce((sum, p) => sum + cents(p), 0);
}
