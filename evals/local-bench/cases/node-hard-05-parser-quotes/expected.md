`parseLine` (in `parse.mjs`) naively does `line.split(",")`, so a double-quoted
field containing a comma is torn into multiple fields and the surrounding quotes
are never stripped. The fix is a small quote-aware scan: track whether we're
inside double quotes, only split on commas outside quotes, and drop the quote
characters. The public test uses only unquoted values, so it passes on the bug;
the hidden oracle covers a quoted comma and quote-stripping.
