`safe_join` (in `safe.py`) uses a `".." in name` string blacklist, which is
bypassable: an absolute `name` (`/etc/passwd`) contains no `..`, and segment
games can normalize outside the base. The correct fix normalizes the resolved
path (e.g. `os.path.realpath`/`normpath`) and rejects any target that is not the
base or under `base + os.sep`. A string blacklist is not acceptable. The shipped
public test only covers the literal-`..` and simple-join cases; the hidden oracle
checks the absolute-path and normalization bypasses.
