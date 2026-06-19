Our path-joining helper is supposed to keep callers confined to a base
directory, but it only blocks the literal `..` sequence. Absolute paths and
paths that normalize to somewhere outside the base still slip through (e.g. an
attacker passes an absolute path and escapes the sandbox).

It should reject anything that resolves outside the base directory, and still
allow legitimate nested paths.
