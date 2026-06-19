import path from "node:path";

// Relative-import extraction + resolution (Phase 8C). Only in-repo (relative)
// imports matter for the impact graph; external packages are ignored. Resolution
// matches deepcoder's own ESM style where a `.js` specifier refers to a `.ts`
// source. Regex-based — "good enough to guide search, not a compiler".

const TS_IMPORT_RES = [
  /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // import x from "..."
  /import\s*['"]([^'"]+)['"]/g, // side-effect import "..."
  /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, // re-export
  /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require("...")
  /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import("...")
];

/** Relative import specifiers in a file (only those starting with "." / leading-dot for py). */
export function extractImportSpecifiers(text: string, lang: string | undefined): string[] {
  const out = new Set<string>();
  if (lang === "ts" || lang === "js") {
    for (const re of TS_IMPORT_RES) {
      for (const m of text.matchAll(re)) {
        if (m[1] && m[1].startsWith(".")) out.add(m[1]);
      }
    }
  } else if (lang === "py") {
    for (const m of text.matchAll(/^\s*from\s+(\.[.\w]*)\s+import\s/gm)) {
      if (m[1]) out.add(m[1]);
    }
  }
  return [...out];
}

/**
 * Resolve a relative specifier from `fromFile` to a known workspace file, or
 * undefined. Tries common extensions and index/__init__ files, and (for the
 * deepcoder ESM convention) maps a `.js`-family specifier onto a `.ts` source.
 */
export function resolveSpecifier(fromFile: string, spec: string, fileSet: ReadonlySet<string>): string | undefined {
  const dir = path.posix.dirname(fromFile);

  // Python relative import: leading dots = level (1 = same package).
  if (spec.startsWith(".") && /[A-Za-z]/.test(spec) && (spec.match(/^\.+/)?.[0].length ?? 0) >= 1 && fromFile.endsWith(".py")) {
    const dots = spec.match(/^\.+/)![0].length;
    const mod = spec.slice(dots).replace(/\./g, "/");
    let base = dir;
    for (let i = 1; i < dots; i++) base = path.posix.dirname(base);
    const target = mod ? path.posix.join(base, mod) : base;
    for (const c of [`${target}.py`, path.posix.join(target, "__init__.py")]) if (fileSet.has(c)) return c;
    return undefined;
  }

  const basePath = path.posix.normalize(path.posix.join(dir, spec));
  const stripped = basePath.replace(/\.(js|jsx|mjs|cjs)$/, ""); // .js specifier → .ts source
  const cands: string[] = [];
  for (const b of new Set([basePath, stripped])) {
    cands.push(b);
    for (const e of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) cands.push(b + e);
    for (const e of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) cands.push(path.posix.join(b, "index" + e));
  }
  return cands.find((c) => fileSet.has(c));
}
