import type { ApprovalDecision } from "./policy.js";
import { isSensitivePath } from "../workspace/sensitive.js";

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

// Leading commands that only read state. NOTE: `find` is deliberately excluded —
// it has -delete / -exec / -execdir / -ok primaries that mutate or run commands,
// which the shallow operand check can't safely vet. `find …` therefore falls
// through to `ask`.
const READ_ONLY_CMDS = new Set(["pwd", "ls", "cat", "head", "tail", "echo", "which", "rg", "grep", "wc"]);

// `git` subcommands that don't mutate the repo. Excludes `branch`/`remote`
// (which have mutating forms like `branch -D`, `remote add`).
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show"]);

// git flags that make a read-only subcommand write a file.
const GIT_WRITE_FLAGS = [/^--output(=|$)/, /^-o$/];

// Tokens that are never auto-runnable, anywhere in the command.
const DANGEROUS_TOKENS = [
  "rm", "sudo", "chmod", "chown", "mkfs", "dd", "shutdown", "reboot", "kill", "killall", "nohup",
];

export function classifyCommand(command: string): ApprovalDecision {
  const cmd = command.trim();
  if (!cmd) return "ask";

  // 1. Hard denials — substitution, fork bombs, pipe-to-shell.
  if (/\$\(|`|<\(/.test(cmd)) return "deny"; // command/process substitution
  if (/:\s*\(\s*\)\s*\{/.test(cmd)) return "deny"; // fork bomb
  if (/\|\s*(sh|bash|zsh|dash)\b/.test(cmd)) return "deny"; // pipe anything into a shell
  if (/>>?\s*\/(?!dev\/null\b)/.test(cmd)) return "deny"; // redirect to an absolute path
  if (/(^|\s)(?:--pre(-glob)?(=|\s|$)|--search-zip\b)/.test(cmd)) return "deny";

  // 2. Redirects and backgrounding are never auto-allowed (side effects / escape).
  const hasRedirect = />/.test(cmd) || /(^|\s)<(?!\()/.test(cmd);
  const hasBackground = /&(?!&)/.test(cmd);
  // Variable/arithmetic expansion (`$VAR`, `${VAR}`, `$((...))`) is never
  // auto-allowed: `echo $MY_SECRET` would otherwise be classified read-only and
  // exfiltrate an environment secret. Command substitution (`$(`) is already
  // denied above; any remaining `$` is an expansion → downgrade to `ask`.
  const hasExpansion = /\$/.test(cmd);

  // 3. Split into segments on sequence/pipe/background operators.
  const segments = cmd.split(/\s*(?:&&|\|\||;|\||&|\n)\s*/).map((s) => s.trim()).filter(Boolean);

  // A dangerous command is denied when it's the *leading* token of any segment
  // (its basename, so `/bin/rm` and `sudo` are caught) — but a dangerous word as
  // an OPERAND (e.g. `grep rm file`) is not, avoiding false-positive denials.
  if (segments.some(isDangerousSegment)) return "deny";
  if (segments.some(isShellSegment)) return "deny";

  const allSafe = segments.every(isReadOnlySegment);
  if (allSafe && !hasRedirect && !hasBackground && !hasExpansion) return "allow";

  // 4. Everything else we don't trust enough to auto-run.
  return "ask";
}

function cleanHead(head: string): string {
  let cleaned = head;
  if (cleaned.startsWith("\\")) {
    cleaned = cleaned.slice(1);
  }
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) || (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}

const SHELL_TOKENS = new Set(["sh", "bash", "zsh", "dash"]);

function isShellSegment(segment: string): boolean {
  const head = segment.split(/\s+/).filter(Boolean)[0];
  if (!head) return false;
  const cleaned = cleanHead(head);
  const base = cleaned.replace(/^.*\//, "");
  return SHELL_TOKENS.has(base);
}

/** True if a segment's leading command (by basename) is a dangerous token. */
function isDangerousSegment(segment: string): boolean {
  const head = segment.split(/\s+/).filter(Boolean)[0];
  if (!head) return false;
  const cleaned = cleanHead(head);
  const base = cleaned.replace(/^.*\//, ""); // strip a path like /bin/rm or ./rm
  return DANGEROUS_TOKENS.includes(base);
}

const RECURSIVE_LONG_FLAGS = new Set(["--recursive", "--hidden", "--no-ignore", "--no-ignore-vcs"]);

function isValidOperand(a: string): boolean {
  if (a === "/dev/null") return true;
  if (a.startsWith("/")) return false; // absolute path
  if (a.split("/").includes("..")) return false; // parent escape
  if (isSensitivePath(a)) return false; // .env and other secrets → not auto-allowed
  if (/[\*\?\[]/.test(a)) return false; // glob metacharacters
  return true;
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

  // A git read-only subcommand with a write flag (e.g. `git diff --output=x`)
  // actually writes a file — not read-only.
  if (head === "git" && operands.some((a) => GIT_WRITE_FLAGS.some((re) => re.test(a)))) return false;

  // Operands must not reach outside the workspace or touch secret files.
  const args = head === "git" ? operands.slice(1) : operands;
  for (const a of args) {
    if (a.startsWith("-")) {
      if (RECURSIVE_LONG_FLAGS.has(a)) return false;
      if (a.startsWith("--")) {
        const eqIdx = a.indexOf("=");
        const flagName = eqIdx !== -1 ? a.slice(0, eqIdx) : a;
        if (RECURSIVE_LONG_FLAGS.has(flagName)) return false;
      } else {
        if (/[rR]/.test(a)) return false;
      }

      if (a.includes("=")) {
        const eqIdx = a.indexOf("=");
        const val = a.slice(eqIdx + 1);
        if (!isValidOperand(val)) return false;
      }
      continue; // remaining flags are fine
    }

    if (!isValidOperand(a)) return false;
  }
  return true;
}
