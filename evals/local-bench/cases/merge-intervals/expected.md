A correct fix sorts by start first (without mutating the input) and merges when
`s <= last[1]` (so touching intervals merge). Only `merge.mjs` changes.
