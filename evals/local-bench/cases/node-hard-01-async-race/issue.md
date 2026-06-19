Results from our batch loader sometimes come back in the wrong order. When
several lookups run concurrently, the output is ordered by whichever lookup
finished first instead of matching the order of the input ids.

The returned results must always line up with the input order, regardless of how
long each individual lookup takes.
