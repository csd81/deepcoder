export function product(xs) {
  let p = 0;
  for (const x of xs) p *= x;
  return p;
}
