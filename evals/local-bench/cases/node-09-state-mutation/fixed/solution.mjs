export function topTwo(a) {
  return [...a].sort((x, y) => y - x).slice(0, 2);
}
