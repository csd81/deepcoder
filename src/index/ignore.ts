import { readFileSync } from "node:fs";
import path from "node:path";

// Pragmatic ignore matching (a subset of .gitignore semantics): blank lines and
// `#` comments are skipped; a trailing `/` marks a directory; `*` is a wildcard
// within a segment. A pattern matches if it equals the path, equals any path
// segment (directory ignore), prefixes the path as a directory, or its basename
// glob matches the file's basename. Good enough to keep node_modules/dist/etc.
// and common `*.log`-style rules out of the index without a full gitignore engine.

const DEFAULT_IGNORES = [
  "node_modules", ".git", "dist", "build", "out", "coverage",
  ".deepcoder", ".next", ".cache", ".turbo", "__pycache__", ".venv", "venv",
];

export interface Ignorer {
  ignored(relPath: string): boolean;
}

export function loadIgnorer(root: string): Ignorer {
  const patterns = [...DEFAULT_IGNORES];
  for (const f of [".gitignore", ".deepcoderignore"]) {
    try {
      for (const line of readFileSync(path.join(root, f), "utf8").split("\n")) {
        const t = line.trim();
        if (t && !t.startsWith("#")) patterns.push(t.replace(/\/+$/, ""));
      }
    } catch {
      /* file absent — fine */
    }
  }
  const compiled = patterns.map(compile);
  return {
    ignored(relPath: string): boolean {
      const norm = relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
      const segments = norm.split("/");
      const base = segments[segments.length - 1]!;
      return compiled.some((m) => m(norm, segments, base));
    },
  };
}

type Matcher = (norm: string, segments: string[], base: string) => boolean;

function compile(pattern: string): Matcher {
  const p = pattern.replace(/^\.?\//, "");
  if (p.includes("*")) {
    const re = globToRegExp(p);
    // glob with a slash matches the full path; otherwise the basename.
    return p.includes("/") ? (norm) => re.test(norm) : (_n, _s, base) => re.test(base);
  }
  if (p.includes("/")) {
    return (norm) => norm === p || norm.startsWith(p + "/");
  }
  // a bare name: match any path segment (so `node_modules` ignores it at any depth)
  return (_norm, segments, base) => base === p || segments.includes(p);
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (const c of glob) {
    if (c === "*") re += "[^/]*";
    else if (".+^${}()|[]\\?".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}
