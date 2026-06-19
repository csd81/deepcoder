Values that contain commas are being split into multiple columns when imported
from our CSV-like config. A quoted value like `"Smith, John"` should stay a
single field, and its surrounding quotes should be removed in the result.

Unquoted values and plain comma separation should keep working as before.
