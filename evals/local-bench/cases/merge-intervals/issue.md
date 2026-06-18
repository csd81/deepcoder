`mergeIntervals(intervals)` should merge all overlapping or touching closed
intervals and return them sorted by start. It currently has two bugs:

- it assumes the input is already sorted, so unsorted input like `[[2,3],[1,5]]`
  is merged incorrectly; and
- it uses `s < last[1]`, which fails to merge *touching* intervals such as
  `[1,4]` and `[4,5]` (should become `[1,5]`).

Fix both so the examples in the issue merge correctly.
