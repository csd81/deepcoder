// Merge overlapping (and touching) closed intervals, returning them sorted.
export function mergeIntervals(intervals) {
  // BUG: assumes input is already sorted, and `s < last[1]` misses touching
  // intervals like [1,4] and [4,5].
  const out = [];
  for (const [s, e] of intervals) {
    const last = out[out.length - 1];
    if (last && s < last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}
