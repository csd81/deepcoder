export function product(xs) {
  let p = 1;
  for (const x of xs) p *= x;
  return p;
}
