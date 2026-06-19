When a cached value is updated, readers keep getting the old value. The first
read after an update still returns the previous value — callers only see the new
value once the process restarts.

Updating a key should be reflected by the very next read.
