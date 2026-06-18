export function safeDiv(a, b) {
  if (b === 0) throw new RangeError("divide by zero");
  return a / b;
}
