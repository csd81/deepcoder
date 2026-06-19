import path from "node:path";
import type { FileKind } from "./types.js";

const CODE_EXT: Record<string, string> = {
  ".ts": "ts", ".tsx": "ts", ".mts": "ts", ".cts": "ts",
  ".js": "js", ".jsx": "js", ".mjs": "js", ".cjs": "js",
  ".py": "py", ".go": "go", ".rs": "rs", ".java": "java",
  ".rb": "rb", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "cs", ".kt": "kt", ".swift": "swift", ".php": "php", ".scala": "scala",
};
const DOC_EXT = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf"]);
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|(\.|_|-)(test|spec)\.[A-Za-z]+$|(^|\/)test_[^/]*\.py$|(^|\/)conftest\.py$/i;
const GENERATED_RE = /(^|\/)(dist|build|out|coverage|generated|\.next)\/|\.min\.(js|css)$|\.map$/i;
const DOC_NAMES = new Set(["readme", "license", "licence", "changelog", "contributing", "authors", "notice"]);
const CONFIG_NAMES = new Set([".gitignore", ".npmrc", ".editorconfig", "dockerfile", "makefile", ".env"]);

/** Classify a workspace-relative path into a coarse kind (+ language for code/tests). */
export function classify(relPath: string): { kind: FileKind; lang?: string } {
  const norm = relPath.replace(/\\/g, "/");
  const base = path.basename(norm).toLowerCase();
  const ext = path.extname(norm).toLowerCase();
  const stem = base.replace(ext, "");
  const lang = CODE_EXT[ext];

  if (GENERATED_RE.test(norm)) return { kind: "generated", lang };
  if (TEST_RE.test(norm)) return { kind: "test", lang };
  if (lang) return { kind: "code", lang };
  if (CONFIG_EXT.has(ext) || CONFIG_NAMES.has(base) || base.startsWith(".env") || stem.endsWith(".config")) {
    return { kind: "config" };
  }
  if (DOC_EXT.has(ext) || DOC_NAMES.has(stem)) return { kind: "docs" };
  return { kind: "other" };
}
