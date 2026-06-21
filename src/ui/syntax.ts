/**
 * Phase 10A.4 — dependency-free code syntax highlighter (pure, no I/O, no deps).
 *
 * A deliberately shallow, single-pass scanner that wraps keywords / strings /
 * numbers / line-comments in ANSI SGR colors. Designed to be SAFE:
 *   - color:false → identity (so a no-color terminal / plain theme is untouched).
 *   - lossless → it only ever wraps original substrings; stripping the SGR codes
 *     yields the exact input. It never drops, adds, or reorders characters.
 *   - never throws on malformed input (unterminated strings/comments just run to
 *     end-of-line).
 *
 * It is NOT a real lexer — it is good enough to make a code block readable in the
 * terminal without pulling in a highlighting dependency.
 */

export interface HighlightOptions {
  color: boolean;
}

// Foreground SGR colors (close with 39 = default foreground).
const FG = {
  keyword: 35, // magenta
  string: 32, // green
  number: 36, // cyan
  comment: 90, // bright black / gray
} as const;

const paint = (code: number, s: string): string => `\x1b[${code}m${s}\x1b[39m`;

type Lang = "python" | "js" | "bash" | "json" | "diff" | "plain";

/** Normalize a fence language tag to a highlighter language family. */
export function normalizeLang(tag: string): Lang {
  const t = (tag || "").toLowerCase();
  if (["py", "python"].includes(t)) return "python";
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "javascript", "typescript"].includes(t)) return "js";
  if (["sh", "bash", "shell", "zsh"].includes(t)) return "bash";
  if (t === "json") return "json";
  if (["diff", "patch"].includes(t)) return "diff";
  return "plain";
}

const KEYWORDS: Record<Lang, Set<string>> = {
  python: new Set([
    "def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or",
    "import", "from", "class", "try", "except", "finally", "raise", "with", "as",
    "lambda", "None", "True", "False", "pass", "break", "continue", "yield", "global",
    "nonlocal", "assert", "del", "is", "await", "async",
  ]),
  js: new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while", "do",
    "switch", "case", "break", "continue", "new", "class", "extends", "super", "import",
    "export", "from", "default", "try", "catch", "finally", "throw", "typeof",
    "instanceof", "in", "of", "await", "async", "yield", "this", "null", "undefined",
    "true", "false", "void", "delete", "interface", "type", "enum", "public", "private",
    "protected", "readonly", "as", "implements", "extends",
  ]),
  bash: new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac",
    "function", "return", "in", "export", "local", "echo", "set", "source",
  ]),
  json: new Set(["true", "false", "null"]),
  diff: new Set(),
  plain: new Set(),
};

/** The line-comment opener for a language ("" = none). */
function commentToken(lang: Lang): string {
  if (lang === "python" || lang === "bash") return "#";
  if (lang === "js") return "//";
  return "";
}

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Highlight a diff/patch line by its leading marker (whole-line color). */
function highlightDiff(line: string): string {
  const c = line[0];
  if (c === "+") return paint(FG.string, line); // additions green
  if (c === "-") return paint(31, line); // removals red
  if (c === "@" || line.startsWith("diff ") || line.startsWith("index ")) return paint(FG.number, line);
  return line;
}

/**
 * Highlight one line of code. Single forward pass; every original character is
 * emitted exactly once (optionally wrapped in an SGR pair).
 */
export function highlightCode(line: string, langTag: string, opts: HighlightOptions): string {
  if (!opts.color) return line;
  const lang = normalizeLang(langTag);
  if (lang === "diff") return highlightDiff(line);

  const kw = KEYWORDS[lang];
  const comment = commentToken(lang);
  let out = "";
  let i = 0;
  const n = line.length;

  while (i < n) {
    const c = line[i];

    // Line comment → color the rest of the line, then stop.
    if (comment && line.startsWith(comment, i)) {
      out += paint(FG.comment, line.slice(i));
      return out;
    }
    // Block comment opener /* ... */ (js) — color to the closer or end of line.
    if (lang === "js" && c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += paint(FG.comment, line.slice(i, stop));
      i = stop;
      continue;
    }

    // String literal — scan to the matching, unescaped quote (or end of line).
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === c) { j++; break; }
        j++;
      }
      out += paint(FG.string, line.slice(i, Math.min(j, n)));
      i = Math.min(j, n);
      continue;
    }

    // Number — a run of digits (with an optional single dot).
    if (isDigit(c) && !(i > 0 && isIdentPart(line[i - 1]))) {
      let j = i + 1;
      let dot = false;
      while (j < n && (isDigit(line[j]) || (line[j] === "." && !dot))) {
        if (line[j] === ".") dot = true;
        j++;
      }
      out += paint(FG.number, line.slice(i, j));
      i = j;
      continue;
    }

    // Identifier — color it if it is a keyword, else pass through verbatim.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(line[j])) j++;
      const word = line.slice(i, j);
      out += kw.has(word) ? paint(FG.keyword, word) : word;
      i = j;
      continue;
    }

    // Any other character — emit verbatim.
    out += c;
    i++;
  }

  return out;
}
