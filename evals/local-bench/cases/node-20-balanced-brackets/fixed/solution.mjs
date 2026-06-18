export function balanced(s) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const open = new Set(["(", "[", "{"]);
  const stack = [];
  for (const c of s) {
    if (open.has(c)) stack.push(c);
    else if (c in pairs) {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return stack.length === 0;
}
