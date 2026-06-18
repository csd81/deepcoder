// Inclusive integer range [a, b].
export function inclusiveRange(a, b) {
  const out = [];
  // BUG: off-by-one — `i < b` excludes the upper bound `b`.
  for (let i = a; i < b; i++) out.push(i);
  return out;
}
