`mapInOrder` (in `fetcher.mjs`) pushes each result as its promise resolves, so the
output is in completion order, not input order. The fix preserves input order —
e.g. write each result to its own index (`out[i] = await load(id)`) instead of
`push`. The shipped public test only uses a single id (order is trivially
correct), so it passes on the buggy code; the hidden oracle runs two lookups with
different delays and asserts input order.
