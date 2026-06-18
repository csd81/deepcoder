`applyDiscount(price, percent)` should reduce the price by the given percentage,
but it currently increases it: `applyDiscount(100, 10)` returns `110` instead of
`90`. Fix the arithmetic so a discount subtracts.
