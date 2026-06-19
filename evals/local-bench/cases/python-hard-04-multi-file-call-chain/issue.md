Tags that users type with surrounding spaces are being treated as different from
the same tag without spaces. After import, `"  Urgent  "` and `"urgent"` end up
as two separate tags instead of one.

Tags should be normalized so that leading/trailing whitespace and case don't
create duplicates.
