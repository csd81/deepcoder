export function balanced(s) {
  let n = 0;
  for (const c of s) {
    if (c === "(") n++;
    else if (c === ")") n--;
  }
  return n === 0;
}
