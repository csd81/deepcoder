// Apply a percentage discount to a price.
export function applyDiscount(price, percent) {
  // BUG: a discount should SUBTRACT, but this adds the percentage.
  return price + (price * percent) / 100;
}
