/**
 * shellAst.ts — Custom shell tokenizer/parser for command classification.
 *
 * This is NOT a full shell parser. It is a conservative tokenizer that
 * identifies command structure just enough to classify commands as
 * allow / ask / deny. It never expands variables, globs, or braces.
 *
 * Design principles:
 * - Parse failure → ask (never allow)
 * - Parser crash → ask (never allow)
 * - Unknown constructs → ask (never allow)
 * - All third-party AST assumptions are isolated here.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; program: ShellProgram }
  | { ok: false; reason: "empty" | "parse_error" | "unsupported" };

export interface ShellProgram {
  commands: ShellCommandNode[];
  operators: ShellOperator[];
  hasCommandSubstitution: boolean;
  hasProcessSubstitution: boolean;
  hasArithmeticExpansion: boolean;
  hasParameterExpansion: boolean;
  hasGlob: boolean;
  hasBraceExpansion: boolean;
  hasBackground: boolean;
  hasRedirect: boolean;
  redirects: ShellRedirect[];
}

export interface ShellCommandNode {
  argv: ShellToken[];
  assignments: ShellToken[];
  redirects: ShellRedirect[];
  sourceRange?: { start: number; end: number };
}

export interface ShellToken {
  raw: string;
  normalized: string;
  quoted: boolean;
  containsExpansion: boolean;
  containsGlob: boolean;
}

export interface ShellRedirect {
  operator: string; // e.g. ">", ">>", "<", "2>", "&>"
  target: ShellToken;
  fd: number | null; // file descriptor or null
}

export type ShellOperator =
  | "pipe"
  | "and"
  | "or"
  | "semicolon"
  | "background";

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * A token is a single shell word after quote/escape processing.
 * We track whether it was quoted (even partially) and whether it
 * contains expansion or glob metacharacters.
 */
interface RawToken {
  raw: string;       // original text as written
  normalized: string; // after quote/backslash removal (NOT shell-expanded)
  quoted: boolean;   // any part was quoted
  containsExpansion: boolean;
  containsGlob: boolean;
  containsProcessSub: boolean; // <( ... ) or >( ... ) process substitution
}

/**
 * Tokenize a shell command string into words and operators.
 *
 * This is a simplified shell lexer that handles:
 * - Single quotes (literal)
 * - Double quotes (literal except $ ` \ " and newline)
 * - Backslash escaping
 * - Operator detection: |, ||, &&, ;, &
 * - Redirect detection: >, >>, <, 2>, &>, etc.
 *
 * It does NOT:
 * - Expand variables/globs/braces
 * - Interpret aliases or functions
 * - Handle here-docs (falls back to unsupported)
 */
function tokenize(input: string): {
  tokens: Array<{ type: "word" | "operator" | "redirect"; value: string; rawToken?: RawToken }>;
  hasHereDoc: boolean;
  error?: string;
} {
  const tokens: Array<{ type: "word" | "operator" | "redirect"; value: string; rawToken?: RawToken }> = [];
  let i = 0;
  let hasHereDoc = false;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) {
      i++;
      continue;
    }

    // Check for here-doc operator <<
    if (input[i] === "<" && input[i + 1] === "<") {
      hasHereDoc = true;
      // Consume the << operator and skip the rest (here-doc delimiter)
      i += 2;
      // Skip whitespace and then the delimiter word
      while (i < input.length && /\s/.test(input[i]!)) i++;
      while (i < input.length && !/\s/.test(input[i]!)) i++;
      continue;
    }

    // Check for operators
    if (input[i] === "|") {
      if (input[i + 1] === "|") {
        tokens.push({ type: "operator", value: "||" });
        i += 2;
      } else {
        tokens.push({ type: "operator", value: "|" });
        i++;
      }
      continue;
    }

    if (input[i] === "&") {
      if (input[i + 1] === "&") {
        tokens.push({ type: "operator", value: "&&" });
        i += 2;
      } else {
        tokens.push({ type: "operator", value: "&" });
        i++;
      }
      continue;
    }

    if (input[i] === ";") {
      tokens.push({ type: "operator", value: ";" });
      i++;
      continue;
    }

    // Check for redirects (must be checked before general word parsing)
    // Patterns: >, >>, <, 2>, &>, 1>, etc.
    const redirectMatch = input.slice(i).match(/^(\d*)(&?)(>+|<+)/);
    if (redirectMatch && redirectMatch[0]!.length > 0) {
      // Make sure it's not part of a longer word (e.g., "->" is not a redirect)
      const after = i + redirectMatch[0]!.length;
      if (after >= input.length || /\s/.test(input[after]!)) {
        tokens.push({ type: "redirect", value: redirectMatch[0]! });
        i = after;
        continue;
      }
    }

    // Parse a word (possibly quoted, with escapes)
    const wordResult = parseWord(input, i);
    if (wordResult.error) {
      return { tokens, hasHereDoc, error: wordResult.error };
    }
    tokens.push({ type: "word", value: wordResult.raw, rawToken: wordResult.token });
    i = wordResult.endIndex;
  }

  return { tokens, hasHereDoc };
}

function parseWord(
  input: string,
  start: number,
): { raw: string; token: RawToken; endIndex: number; error?: string } {
  let raw = "";
  let normalized = "";
  let quoted = false;
  let containsExpansion = false;
  let containsGlob = false;
  let containsProcessSub = false;
  let i = start;

  while (i < input.length) {
    const ch = input[i]!;

    // Process substitution: <( ... ) or >( ... ). Must be checked before the
    // redirect/word-break logic so we capture the nested command as one token
    // and flag it as a hazard (it executes a nested command).
    if ((ch === "<" || ch === ">") && input[i + 1] === "(") {
      containsProcessSub = true;
      raw += ch + "(";
      normalized += ch + "(";
      i += 2;
      let depth = 1;
      while (i < input.length && depth > 0) {
        const pc = input[i]!;
        raw += pc;
        normalized += pc;
        if (pc === "(") depth++;
        if (pc === ")") depth--;
        i++;
      }
      continue;
    }

    // Whitespace or operator ends the word
    if (/\s/.test(ch)) break;
    if (ch === "|" || ch === ";" || ch === "&") break;
    // Redirect operators also end words (but we handle them before calling parseWord)
    if ((ch === ">" || ch === "<") && (i + 1 >= input.length || /\s/.test(input[i + 1]!))) break;

    if (ch === "'") {
      // Single-quoted string: everything literal until closing quote
      quoted = true;
      raw += "'";
      i++;
      while (i < input.length && input[i] !== "'") {
        raw += input[i];
        normalized += input[i];
        i++;
      }
      if (i >= input.length) {
        return { raw, token: { raw, normalized, quoted, containsExpansion, containsGlob, containsProcessSub }, endIndex: i, error: "unclosed single quote" };
      }
      raw += "'";
      i++; // skip closing quote
      continue;
    }

    if (ch === '"') {
      // Double-quoted string: literal except $ ` \ " and newline
      quoted = true;
      raw += '"';
      i++;
      while (i < input.length && input[i] !== '"') {
        const dq = input[i]!;
        if (dq === "\\") {
          raw += "\\";
          i++;
          if (i < input.length) {
            const next = input[i]!;
            raw += next;
            // In double quotes, only \, $, `, " and newline are escaped
            if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
              normalized += next;
            } else {
              normalized += "\\" + next;
            }
            i++;
          }
        } else if (dq === "$") {
          raw += "$";
          normalized += "$";
          containsExpansion = true;
          i++;
          // Check for $((...)) arithmetic, $(...) command sub, ${...} param expansion
          if (i < input.length && input[i] === "(") {
            raw += "(";
            normalized += "(";
            i++;
            if (i < input.length && input[i] === "(") {
              // $((...)) - arithmetic expansion
              raw += "(";
              normalized += "(";
              i++;
              let depth = 2;
              while (i < input.length && depth > 0) {
                const ac = input[i]!;
                raw += ac;
                normalized += ac;
                if (ac === "(") depth++;
                if (ac === ")") depth--;
                i++;
              }
            } else {
              // $(...) - command substitution
              let depth = 1;
              while (i < input.length && depth > 0) {
                const cs = input[i]!;
                raw += cs;
                normalized += cs;
                if (cs === "(") depth++;
                if (cs === ")") depth--;
                i++;
              }
            }
          } else if (i < input.length && input[i] === "{") {
            // ${...} - parameter expansion
            raw += "{";
            normalized += "{";
            i++;
            let depth = 1;
            while (i < input.length && depth > 0) {
              const pe = input[i]!;
              raw += pe;
              normalized += pe;
              if (pe === "{") depth++;
              if (pe === "}") depth--;
              i++;
            }
          }
        } else if (dq === "`") {
          raw += "`";
          normalized += "`";
          containsExpansion = true;
          i++;
          // Backtick command substitution
          while (i < input.length && input[i] !== "`") {
            raw += input[i];
            normalized += input[i];
            i++;
          }
          if (i < input.length) {
            raw += "`";
            normalized += "`";
            i++;
          }
        } else {
          raw += dq;
          normalized += dq;
          i++;
        }
      }
      if (i >= input.length) {
        return { raw, token: { raw, normalized, quoted, containsExpansion, containsGlob, containsProcessSub }, endIndex: i, error: "unclosed double quote" };
      }
      raw += '"';
      i++; // skip closing quote
      continue;
    }

    if (ch === "\\") {
      // Backslash escape: next character is literal
      raw += "\\";
      i++;
      if (i < input.length) {
        raw += input[i];
        normalized += input[i];
        i++;
      }
      continue;
    }

    if (ch === "$") {
      raw += "$";
      normalized += "$";
      containsExpansion = true;
      i++;
      // Check for $((...)), $(...), ${...}
      if (i < input.length && input[i] === "(") {
        raw += "(";
        normalized += "(";
        i++;
        if (i < input.length && input[i] === "(") {
          // $((...))
          raw += "(";
          normalized += "(";
          i++;
          let depth = 2;
          while (i < input.length && depth > 0) {
            const ac = input[i]!;
            raw += ac;
            normalized += ac;
            if (ac === "(") depth++;
            if (ac === ")") depth--;
            i++;
          }
        } else {
          // $(...)
          let depth = 1;
          while (i < input.length && depth > 0) {
            const cs = input[i]!;
            raw += cs;
            normalized += cs;
            if (cs === "(") depth++;
            if (cs === ")") depth--;
            i++;
          }
        }
      } else if (i < input.length && input[i] === "{") {
        // ${...}
        raw += "{";
        normalized += "{";
        i++;
        let depth = 1;
        while (i < input.length && depth > 0) {
          const pe = input[i]!;
          raw += pe;
          normalized += pe;
          if (pe === "{") depth++;
          if (pe === "}") depth--;
          i++;
        }
      }
      continue;
    }

    if (ch === "`") {
      raw += "`";
      normalized += "`";
      containsExpansion = true;
      i++;
      while (i < input.length && input[i] !== "`") {
        raw += input[i];
        normalized += input[i];
        i++;
      }
      if (i < input.length) {
        raw += "`";
        normalized += "`";
        i++;
      }
      continue;
    }

    // Check for glob/brace metacharacters
    if (ch === "*" || ch === "?" || ch === "[") {
      containsGlob = true;
    }
    if (ch === "{") {
      // Could be brace expansion like {a,b} or just a literal {
      // We'll check for comma inside
      containsGlob = true; // treat as expansion
    }

    raw += ch;
    normalized += ch;
    i++;
  }

  return { raw, token: { raw, normalized, quoted, containsExpansion, containsGlob, containsProcessSub }, endIndex: i };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse a shell command string into a ShellProgram.
 *
 * This is a simplified parser that handles:
 * - Simple commands (cmd arg1 arg2)
 * - Pipelines (cmd1 | cmd2)
 * - Logical operators (cmd1 && cmd2, cmd1 || cmd2)
 * - Sequences (cmd1; cmd2)
 * - Background (cmd &)
 * - Redirects (cmd > file, cmd < file)
 *
 * It does NOT handle:
 * - Here-docs (<<) — detected and returns unsupported
 * - Complex compound constructs (for, while, if, case, etc.)
 * - Function definitions
 * - Subshells ((...))
 */
export function parseShellProgram(command: string): ParseResult {
  try {
    const trimmed = command.trim();
    if (!trimmed) {
      return { ok: false, reason: "empty" };
    }

    const { tokens, hasHereDoc, error } = tokenize(trimmed);

    if (error) {
      return { ok: false, reason: "parse_error" };
    }

    if (hasHereDoc) {
      return { ok: false, reason: "unsupported" };
    }

    // Build the program from tokens
    const program = buildProgram(tokens);
    return { ok: true, program };
  } catch {
    return { ok: false, reason: "parse_error" };
  }
}

function buildProgram(tokens: Array<{ type: "word" | "operator" | "redirect"; value: string; rawToken?: RawToken }>): ShellProgram {
  const commands: ShellCommandNode[] = [];
  const operators: ShellOperator[] = [];
  const allRedirects: ShellRedirect[] = [];

  let hasCommandSubstitution = false;
  let hasProcessSubstitution = false;
  let hasArithmeticExpansion = false;
  let hasParameterExpansion = false;
  let hasGlob = false;
  let hasBraceExpansion = false;
  let hasBackground = false;
  let hasRedirect = false;

  // Current command being built
  let currentArgv: ShellToken[] = [];
  let currentAssignments: ShellToken[] = [];
  let currentRedirects: ShellRedirect[] = [];
  let pendingRedirect: string | null = null;

  function flushCommand() {
    if (currentArgv.length > 0 || currentAssignments.length > 0 || currentRedirects.length > 0) {
      commands.push({
        argv: currentArgv,
        assignments: currentAssignments,
        redirects: currentRedirects,
      });
      allRedirects.push(...currentRedirects);
      currentArgv = [];
      currentAssignments = [];
      currentRedirects = [];
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.type === "operator") {
      flushCommand();
      if (token.value === "|") {
        operators.push("pipe");
      } else if (token.value === "&&") {
        operators.push("and");
      } else if (token.value === "||") {
        operators.push("or");
      } else if (token.value === ";") {
        operators.push("semicolon");
      } else if (token.value === "&") {
        operators.push("background");
        hasBackground = true;
      }
      continue;
    }

    if (token.type === "redirect") {
      hasRedirect = true;
      pendingRedirect = token.value;
      continue;
    }

    if (token.type === "word" && token.rawToken) {
      const rt = token.rawToken;

      // Check for expansions in the token
      if (rt.containsExpansion) {
        // Determine what kind of expansion
        if (/\$\(/.test(rt.raw)) {
          hasCommandSubstitution = true;
        }
        if (/`/.test(rt.raw)) {
          hasCommandSubstitution = true;
        }
        if (/\$\(\(/.test(rt.raw)) {
          hasArithmeticExpansion = true;
        }
        if (/\$\{/.test(rt.raw) || (/\$[a-zA-Z_]/.test(rt.raw) && !/\$\(/.test(rt.raw))) {
          hasParameterExpansion = true;
        }
      }

      // Process substitution <( ... ) / >( ... ) executes a nested command; it
      // is flagged on the raw token by the tokenizer (it does not set
      // containsExpansion, so this check lives outside that block).
      if (rt.containsProcessSub) {
        hasProcessSubstitution = true;
      }

      if (rt.containsGlob) {
        hasGlob = true;
        // Check for brace expansion pattern
        if (/\{[^}]+,/.test(rt.raw)) {
          hasBraceExpansion = true;
        }
      }

      const shellToken: ShellToken = {
        raw: rt.raw,
        normalized: rt.normalized,
        quoted: rt.quoted,
        containsExpansion: rt.containsExpansion,
        containsGlob: rt.containsGlob,
      };

      if (pendingRedirect) {
        // This word is the target of a redirect
        const op = pendingRedirect;
        // Parse fd from redirect operator
        const fdMatch = op.match(/^(\d+)/);
        const fd = fdMatch ? parseInt(fdMatch[1]!, 10) : null;
        currentRedirects.push({
          operator: op,
          target: shellToken,
          fd,
        });
        pendingRedirect = null;
      } else {
        // Check if it looks like an assignment (var=value)
        // Simple heuristic: contains = and doesn't start with -
        if (/^[a-zA-Z_][a-zA-Z0-9_]*=/.test(rt.normalized) && currentArgv.length === 0) {
          currentAssignments.push(shellToken);
        } else {
          currentArgv.push(shellToken);
        }
      }
    }
  }

  // Flush any remaining command
  flushCommand();

  // If there's a dangling redirect (no target), add a synthetic token
  if (pendingRedirect) {
    hasRedirect = true;
    const fdMatch = pendingRedirect.match(/^(\d+)/);
    const fd = fdMatch ? parseInt(fdMatch[1]!, 10) : null;
    allRedirects.push({
      operator: pendingRedirect,
      target: { raw: "", normalized: "", quoted: false, containsExpansion: false, containsGlob: false },
      fd,
    });
  }

  return {
    commands,
    operators,
    hasCommandSubstitution,
    hasProcessSubstitution,
    hasArithmeticExpansion,
    hasParameterExpansion,
    hasGlob,
    hasBraceExpansion,
    hasBackground,
    hasRedirect,
    redirects: allRedirects,
  };
}
