// Apply a percentage discount to a price.
export function applyDiscount(price, percent) {
  return price - (price * percent) / 100;
}
