// Return the two largest numbers, highest first.
export function topTwo(arr) {
  return [...arr].sort((a, b) => b - a).slice(0, 2);
}
