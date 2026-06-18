export function unique(xs) {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}
