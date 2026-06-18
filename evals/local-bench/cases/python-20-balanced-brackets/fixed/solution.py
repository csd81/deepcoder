def balanced(s):
    pairs = {")": "(", "]": "[", "}": "{"}
    opening = set("([{")
    stack = []
    for c in s:
        if c in opening:
            stack.append(c)
        elif c in pairs:
            if not stack or stack.pop() != pairs[c]:
                return False
    return not stack
