// Inclusive integer range [a, b].
export function inclusiveRange(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
