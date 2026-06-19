# Fenced-code-block detector. Looks like the place to fix the "--- inside a
# fence" bug, but split_document never calls this — decoy.
def in_fence(lines, index):
    fence = False
    for i in range(index):
        if lines[i].strip().startswith("```"):
            fence = not fence
    return fence
