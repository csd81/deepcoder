// Local mini-benchmark tasks. Each task is a self-contained JS bug:
//   - `buggy`: the source the agent must fix (written as src.mjs).
//   - `fixed`: a known-good reference, used ONLY by `--selftest` to prove the
//     task is well-formed (verify fails on buggy, passes on fixed). Never shown
//     to the agent.
//   - `verify`: a deterministic checker (written as verify.mjs) that imports
//     ./src.mjs and exits non-zero on wrong behaviour.
//   - `prompt`: the symptom handed to the agent (as a failing-test report).
//
// This is a TRANSPARENT custom eval, not SWE-bench. It measures "given a
// described bug in a small file, does the agent produce a fix that passes a
// hidden deterministic test."

export const TASKS = [
  {
    id: "sum-offbyone",
    prompt:
      "src.mjs exports sum(nums). Test fails: sum([1,2,3]) returned NaN, expected 6. " +
      "There is an off-by-one bug. Fix src.mjs.",
    buggy: `export function sum(nums) {
  let t = 0;
  for (let i = 0; i <= nums.length; i++) t += nums[i];
  return t;
}
`,
    fixed: `export function sum(nums) {
  let t = 0;
  for (let i = 0; i < nums.length; i++) t += nums[i];
  return t;
}
`,
    verify: `import { sum } from "./src.mjs";
import assert from "node:assert/strict";
assert.equal(sum([1,2,3]), 6);
assert.equal(sum([]), 0);
assert.equal(sum([5]), 5);
assert.equal(sum([-1,1]), 0);
console.log("ok");
`,
  },
  {
    id: "fizzbuzz-order",
    prompt:
      "src.mjs exports fizzbuzz(n). Test fails: fizzbuzz(15) returned 'Fizz', expected 'FizzBuzz'. " +
      "The divisibility checks are in the wrong order. Fix src.mjs.",
    buggy: `export function fizzbuzz(n) {
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  if (n % 15 === 0) return "FizzBuzz";
  return String(n);
}
`,
    fixed: `export function fizzbuzz(n) {
  if (n % 15 === 0) return "FizzBuzz";
  if (n % 3 === 0) return "Fizz";
  if (n % 5 === 0) return "Buzz";
  return String(n);
}
`,
    verify: `import { fizzbuzz } from "./src.mjs";
import assert from "node:assert/strict";
assert.equal(fizzbuzz(15), "FizzBuzz");
assert.equal(fizzbuzz(3), "Fizz");
assert.equal(fizzbuzz(5), "Buzz");
assert.equal(fizzbuzz(7), "7");
console.log("ok");
`,
  },
  {
    id: "binary-search",
    prompt:
      "src.mjs exports binarySearch(arr, target) returning the index or -1. Test fails: " +
      "binarySearch([1,3,5,7,9], 9) returned -1, expected 4. Fix the bug in src.mjs.",
    buggy: `export function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`,
    fixed: `export function binarySearch(arr, target) {
  let lo = 0, hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === target) return mid;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
`,
    verify: `import { binarySearch } from "./src.mjs";
import assert from "node:assert/strict";
assert.equal(binarySearch([1,3,5,7,9], 9), 4);
assert.equal(binarySearch([1,3,5,7,9], 1), 0);
assert.equal(binarySearch([1,3,5,7,9], 5), 2);
assert.equal(binarySearch([1,3,5,7,9], 4), -1);
console.log("ok");
`,
  },
  {
    id: "chunk-remainder",
    prompt:
      "src.mjs exports chunk(arr, size) splitting arr into groups of size. Test fails: " +
      "chunk([1,2,3,4,5], 2) dropped the last element (returned [[1,2],[3,4]], expected [[1,2],[3,4],[5]]). Fix src.mjs.",
    buggy: `export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i + size <= arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
`,
    fixed: `export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
`,
    verify: `import { chunk } from "./src.mjs";
import assert from "node:assert/strict";
assert.deepEqual(chunk([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
assert.deepEqual(chunk([1,2,3,4], 2), [[1,2],[3,4]]);
assert.deepEqual(chunk([], 3), []);
console.log("ok");
`,
  },
  {
    id: "title-case",
    prompt:
      "src.mjs exports titleCase(s) which should capitalise the first letter of each word and " +
      "lowercase the rest, splitting on spaces AND hyphens. Test fails: titleCase('foo-bar BAZ') returned " +
      "'Foo-bar BAZ', expected 'Foo-Bar Baz'. Fix src.mjs.",
    buggy: `export function titleCase(s) {
  return s.split(" ").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}
`,
    fixed: `export function titleCase(s) {
  return s
    .split(" ")
    .map((word) =>
      word
        .split("-")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
        .join("-"),
    )
    .join(" ");
}
`,
    verify: `import { titleCase } from "./src.mjs";
import assert from "node:assert/strict";
assert.equal(titleCase("foo-bar BAZ"), "Foo-Bar Baz");
assert.equal(titleCase("hello world"), "Hello World");
console.log("ok");
`,
  },
  {
    id: "parse-query",
    prompt:
      "src.mjs exports parseQuery(qs) returning an object from a query string. Two bugs: it should " +
      "URL-decode values and split each pair on the FIRST '=' only. Test fails: " +
      "parseQuery('a=1&b=hello%20world&c=x=y') gave {a:'1',b:'hello%20world',c:'x'}, " +
      "expected {a:'1',b:'hello world',c:'x=y'}. Fix src.mjs.",
    buggy: `export function parseQuery(qs) {
  const out = {};
  for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    out[k] = v;
  }
  return out;
}
`,
    fixed: `export function parseQuery(qs) {
  const out = {};
  for (const pair of qs.split("&")) {
    const i = pair.indexOf("=");
    const k = i === -1 ? pair : pair.slice(0, i);
    const v = i === -1 ? "" : pair.slice(i + 1);
    out[k] = decodeURIComponent(v);
  }
  return out;
}
`,
    verify: `import { parseQuery } from "./src.mjs";
import assert from "node:assert/strict";
assert.deepEqual(parseQuery("a=1&b=hello%20world&c=x=y"), { a: "1", b: "hello world", c: "x=y" });
console.log("ok");
`,
  },
  {
    id: "memoize-multiarg",
    prompt:
      "src.mjs exports memoize(fn). Bug: it only keys the cache on the first argument, so calls with " +
      "different later args return stale results. Test fails: after add(1,2)=3, add(1,5) returned 3, expected 6. Fix src.mjs.",
    buggy: `export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = args[0];
    if (cache.has(key)) return cache.get(key);
    const v = fn(...args);
    cache.set(key, v);
    return v;
  };
}
`,
    fixed: `export function memoize(fn) {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const v = fn(...args);
    cache.set(key, v);
    return v;
  };
}
`,
    verify: `import { memoize } from "./src.mjs";
import assert from "node:assert/strict";
const add = memoize((a, b) => a + b);
assert.equal(add(1, 2), 3);
assert.equal(add(1, 5), 6);
assert.equal(add(1, 2), 3);
console.log("ok");
`,
  },
  {
    id: "flatten-depth",
    prompt:
      "src.mjs exports flatten(arr) which should fully flatten a nested array of any depth. Test fails: " +
      "flatten([1,[2,[3,[4]]]]) returned [1,2,[3,[4]]], expected [1,2,3,4]. It only flattens one level. Fix src.mjs.",
    buggy: `export function flatten(arr) {
  const out = [];
  for (const x of arr) {
    if (Array.isArray(x)) out.push(...x);
    else out.push(x);
  }
  return out;
}
`,
    fixed: `export function flatten(arr) {
  const out = [];
  for (const x of arr) {
    if (Array.isArray(x)) out.push(...flatten(x));
    else out.push(x);
  }
  return out;
}
`,
    verify: `import { flatten } from "./src.mjs";
import assert from "node:assert/strict";
assert.deepEqual(flatten([1,[2,[3,[4]]]]), [1,2,3,4]);
assert.deepEqual(flatten([1,2,3]), [1,2,3]);
assert.deepEqual(flatten([]), []);
console.log("ok");
`,
  },
];
