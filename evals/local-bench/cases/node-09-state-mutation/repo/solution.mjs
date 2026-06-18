export function topTwo(a) {
  a.sort((x, y) => y - x);
  return a.slice(0, 2);
}
