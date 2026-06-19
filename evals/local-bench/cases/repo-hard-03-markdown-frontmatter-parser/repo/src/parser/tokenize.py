# Line tokenizer. NOT used by split_document — decoy.
def tokenize(text):
    return [{"line": i, "text": ln} for i, ln in enumerate(text.split("\n"))]
