// Return the two largest numbers, highest first.
export function topTwo(arr) {
  // BUG: Array.prototype.sort mutates `arr` in place, corrupting the caller's
  // array as a side effect.
  arr.sort((a, b) => b - a);
  return arr.slice(0, 2);
}
