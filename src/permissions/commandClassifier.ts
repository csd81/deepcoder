import type { ApprovalDecision } from "./policy.js";

/**
 * Classify a raw bash command into a default permission decision.
 *
 * This is a conservative heuristic, not a sandbox. The previous version matched
 * read-only *prefixes*, which let chained or redirected commands slip through
 * (`ls; touch x`, `echo hi > f`, `cat /etc/passwd`, `git status && git checkout`).
 * We now analyse structure: a command is only `allow` when it is a pipeline/
 * sequence of explicitly read-only segments with safe operands and no
 * redirects, substitutions, or backgrounding.
 */

// Leading commands that only read state.
const READ_ONLY_CMDS = new Set(["pwd", "ls", "cat", "head", "tail", "echo", "which", "rg", "grep", "find", "wc"]);

// `git` subcommands that don't mutate the repo.
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "branch", "remote"]);

// Tokens that are never auto-runnable, anywhere in the command.
const DANGEROUS_TOKENS = [
  "rm", "sudo", "chmod", "chown", "mkfs", "dd", "shutdown", "reboot", "kill", "killall", "nohup",
];

export function classifyCommand(command: string): ApprovalDecision {
  const cmd = command.trim();
  if (!cmd) return "ask";

  // 1. Hard denials — substitution, fork bombs, pipe-to-shell, dangerous tokens.
  if (/\$\(|`|<\(/.test(cmd)) return "deny"; // command/process substitution
  if (/:\s*\(\s*\)\s*\{/.test(cmd)) return "deny"; // fork bomb
  if (/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/.test(cmd)) return "deny";
  if (/>>?\s*\/(?!dev\/null\b)/.test(cmd)) return "deny"; // redirect to an absolute path
  const tokens = cmd.split(/\s+/);
  if (tokens.some((t) => DANGEROUS_TOKENS.includes(t))) return "deny";

  // 2. Redirects and backgrounding are never auto-allowed (side effects / escape).
  //    Treat as `ask` so the user sees them, unless already denied above.
  const hasRedirect = />/.test(cmd) || /(^|\s)<(?!\()/.test(cmd);
  const hasBackground = /&(?!&)/.test(cmd);

  // 3. Split into segments on sequence/pipe/background operators.
  const segments = cmd.split(/\s*(?:&&|\|\||;|\||&|\n)\s*/).map((s) => s.trim()).filter(Boolean);

  const allSafe = segments.every(isReadOnlySegment);
  if (allSafe && !hasRedirect && !hasBackground) return "allow";

  // 4. Everything else we don't trust enough to auto-run.
  return "ask";
}

function isReadOnlySegment(segment: string): boolean {
  const parts = segment.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  const [head, ...operands] = parts;

  let safeCmd: boolean;
  if (head === "git") {
    safeCmd = operands.length > 0 && READ_ONLY_GIT.has(operands[0]!);
  } else {
    safeCmd = READ_ONLY_CMDS.has(head!);
  }
  if (!safeCmd) return false;

  // Operands must not reach outside the workspace.
  const args = head === "git" ? operands.slice(1) : operands;
  for (const a of args) {
    if (a.startsWith("-")) continue; // flags are fine
    if (a === "/dev/null") continue;
    if (a.startsWith("/")) return false; // absolute path
    if (a.split("/").includes("..")) return false; // parent escape
  }
  return true;
}
