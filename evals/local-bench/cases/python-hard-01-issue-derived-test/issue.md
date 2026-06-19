Blueprint names that contain a dot are currently accepted and stored as-is. A
dot has special meaning in our routing layer, so a name like `admin.users`
silently breaks nested lookups instead of failing early.

A name containing a `.` should raise a `ValueError` at construction time rather
than being accepted. Please also add a regression test so this can't regress.
