/**
 * commandMatrix.ts — token-matrix construction and classification.
 *
 * Turns a parsed {@link ShellProgram} into an explicit {@link CommandMatrix}
 * (segments + operators + hazards), then maps that matrix to an
 * {@link ApprovalDecision} using the Phase 7F Deny/Ask/Allow rules.
 *
 * All allowlist / dangerous-set / git-flag policy data lives here. The parser
 * (shellAst.ts) only describes structure; this module owns the decision.
 *
 * Fail-closed invariants:
 * - constructs that execute nested commands → "deny"
 * - anything not provably read-only & safe → "ask"
 * - "allow" only when every segment is read-only and every token is safe
 */

import type { ApprovalDecision } from "./policy.js";
import type {
  ShellProgram,
  ShellToken,
  ShellRedirect,
  ShellOperator,
} from "./shellAst.js";
import { isSensitivePath } from "../workspace/sensitive.js";

// ---------------------------------------------------------------------------
// Policy data (moved here from commandClassifier.ts)
// ---------------------------------------------------------------------------

/**
 * Leading commands that only read state. NOTE: `find` is deliberately excluded —
 * it has -delete / -exec / -execdir / -ok primaries that mutate or run commands,
 * which the shallow operand check can't safely vet. `find …` therefore falls
 * through to `ask`.
 */
const READ_ONLY_CMDS = new Set([
  "pwd",
  "ls",
  "cat",
  "head",
  "tail",
  "echo",
  "which",
  "rg",
  "grep",
  "wc",
]);

/**
 * `git` subcommands that don't mutate the repo. Excludes `branch`/`remote`
 * (which have mutating forms like `branch -D`, `remote add`).
 */
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show"]);

/** git flags that make a read-only subcommand write a file. */
const GIT_WRITE_FLAGS = [/^--output(=|$)/, /^-o$/];

/** Tokens that are never auto-runnable when they lead a segment (by basename). */
const DANGEROUS_COMMANDS = new Set([
  "rm",
  "sudo",
  "chmod",
  "chown",
  "mkfs",
  "dd",
  "shutdown",
  "reboot",
  "kill",
  "killall",
  "nohup",
]);

/** Shell interpreters: piping/feeding into these executes arbitrary input. */
const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Long flags that broaden a search into hidden / ignored / recursive scope. */
const RECURSIVE_LONG_FLAGS = new Set([
  "--recursive",
  "--hidden",
  "--no-ignore",
  "--no-ignore-vcs",
]);

/**
 * ripgrep flags that run an external preprocessor or decompress archives — i.e.
 * arbitrary code execution / data exfiltration channels. Always deny.
 */
const PREPROCESSOR_FLAGS = [
  /^--pre$/,
  /^--pre=/,
  /^--pre-glob$/,
  /^--pre-glob=/,
  /^--search-zip$/,
  /^-z$/,
];

// ---------------------------------------------------------------------------
// Matrix types
// ---------------------------------------------------------------------------

export type Hazard =
  | "parse_error"
  | "compound_command"
  | "command_substitution"
  | "process_substitution"
  | "arithmetic_expansion"
  | "parameter_expansion"
  | "glob"
  | "brace_expansion"
  | "redirect"
  | "background"
  | "pipe_to_shell"
  | "dangerous_command"
  | "absolute_operand"
  | "parent_escape"
  | "sensitive_operand"
  | "recursive_flag"
  | "preprocessor_flag"
  | "git_write_flag"
  | "unknown_segment";

export interface Segment {
  command: string;
  basename: string;
  argv: string[];
  tokens: ShellToken[];
  redirects: ShellRedirect[];
}

export interface CommandMatrix {
  segments: Segment[];
  operators: ShellOperator[];
  hazards: Hazard[];
}

// ---------------------------------------------------------------------------
// Matrix construction
// ---------------------------------------------------------------------------

/** Strip a leading backslash and surrounding matched quotes from a raw word. */
function cleanCommandWord(token: ShellToken): string {
  // The parser already removed quotes/escapes into `normalized`; that is the
  // value the shell would actually exec. Use it directly.
  return token.normalized;
}

/** Reduce a command word to its basename (strip a path like /bin/rm or ./rm). */
function basenameOf(command: string): string {
  return command.replace(/^.*\//, "");
}

/**
 * True when a segment's COMMAND head is a function definition, brace group, or
 * subshell — compound constructs the shallow parser can't vet and which can
 * execute nested commands (e.g. `:(){ :|:& };:`, `foo(){ rm -rf /; }`,
 * `(rm -rf x)`). These fail closed to "deny". Only the command head is checked,
 * so a parenthesised OPERAND like `grep "foo()" file` is unaffected.
 */
function isCompoundConstructCommand(command: string): boolean {
  if (!command) return false;
  if (/\(\)/.test(command)) return true; // function definition: name() / name(){
  if (command === "{" || command === "}" || command === "(" || command === ")") return true;
  if (command.startsWith("(")) return true; // subshell: (cmd …
  return false;
}

export function buildCommandMatrix(program: ShellProgram): CommandMatrix {
  const hazards = new Set<Hazard>();

  // Program-level hazards from parser metadata.
  if (program.hasCommandSubstitution) hazards.add("command_substitution");
  if (program.hasProcessSubstitution) hazards.add("process_substitution");
  if (program.hasArithmeticExpansion) hazards.add("arithmetic_expansion");
  if (program.hasParameterExpansion) hazards.add("parameter_expansion");
  if (program.hasGlob) hazards.add("glob");
  if (program.hasBraceExpansion) hazards.add("brace_expansion");
  if (program.hasBackground) hazards.add("background");
  if (program.hasRedirect) hazards.add("redirect");

  const segments: Segment[] = [];

  for (const node of program.commands) {
    const tokens = node.argv;
    const argv = tokens.map((t) => t.normalized);
    const head = tokens[0];
    const command = head ? cleanCommandWord(head) : "";
    const basename = basenameOf(command);

    segments.push({
      command,
      basename,
      argv,
      tokens,
      redirects: node.redirects,
    });

    // Per-segment hazards.
    if (isCompoundConstructCommand(command)) {
      hazards.add("compound_command");
    }
    if (basename && DANGEROUS_COMMANDS.has(basename)) {
      hazards.add("dangerous_command");
    }
    if (basename && SHELL_COMMANDS.has(basename)) {
      // A bare/abs-path shell as a segment is a pipe-to-shell sink. (For the
      // first segment this is just running a shell; still never auto-allowed
      // and, if any pipe feeds it, it executes arbitrary input.)
      hazards.add("pipe_to_shell");
    }
  }

  // Redirect targets: absolute (non /dev/null) → deny-class hazard handled in
  // classifyMatrix; here we just surface them via the redirect hazard already
  // added. We also inspect operands for the ask/deny operand hazards.
  for (const seg of segments) {
    inspectSegmentTokens(seg, hazards);
  }

  return {
    segments,
    operators: program.operators,
    hazards: [...hazards],
  };
}

/** Scan a segment's argv + redirect targets for operand/flag hazards. */
function inspectSegmentTokens(seg: Segment, hazards: Set<Hazard>): void {
  const isGit = seg.basename === "git";
  // For git, the first operand is the subcommand; flags/operands follow.
  const operandTokens = isGit ? seg.tokens.slice(2) : seg.tokens.slice(1);

  if (isGit) {
    const sub = seg.argv[1];
    if (sub && READ_ONLY_GIT.has(sub)) {
      // check write flags across all git operands
      for (const a of seg.argv.slice(2)) {
        if (GIT_WRITE_FLAGS.some((re) => re.test(a))) hazards.add("git_write_flag");
      }
    }
  }

  for (const tok of operandTokens) {
    const a = tok.normalized;
    if (a.startsWith("-")) {
      // Preprocessor / archive flags (rg) — hard deny class.
      if (PREPROCESSOR_FLAGS.some((re) => re.test(a))) {
        hazards.add("preprocessor_flag");
      }
      // Recursive / hidden / no-ignore long flags.
      const eqIdx = a.indexOf("=");
      const flagName = eqIdx !== -1 ? a.slice(0, eqIdx) : a;
      if (RECURSIVE_LONG_FLAGS.has(flagName)) hazards.add("recursive_flag");
      // Short combined flags carrying r/R (e.g. -R, -rn) imply recursion.
      if (!a.startsWith("--") && /[rR]/.test(a)) hazards.add("recursive_flag");
      // A value embedded in a flag (e.g. --include=/etc/passwd) is an operand.
      if (eqIdx !== -1) addOperandHazards(a.slice(eqIdx + 1), hazards);
      continue;
    }
    addOperandHazards(a, hazards);
  }

  // Redirect targets are operands with side effects.
  for (const r of seg.redirects) {
    addOperandHazards(r.target.normalized, hazards);
  }
}

/** Classify a single operand path for ask/deny hazards. */
function addOperandHazards(value: string, hazards: Set<Hazard>): void {
  if (!value) return;
  if (value === "/dev/null") return;
  if (value.startsWith("/")) {
    hazards.add("absolute_operand");
    return;
  }
  if (value.split("/").includes("..")) hazards.add("parent_escape");
  if (isSensitivePath(value)) hazards.add("sensitive_operand");
  if (/[*?[]/.test(value)) hazards.add("glob");
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Hazards that mean "deny" outright (nested execution / destructive). */
const DENY_HAZARDS: Hazard[] = [
  "compound_command",
  "command_substitution",
  "process_substitution",
  "arithmetic_expansion",
  "pipe_to_shell",
  "dangerous_command",
  "preprocessor_flag",
];

export function classifyMatrix(matrix: CommandMatrix): ApprovalDecision {
  const set = new Set(matrix.hazards);

  // 1. Deny: nested execution, destructive commands, preprocessor flags.
  for (const h of DENY_HAZARDS) {
    if (set.has(h)) return "deny";
  }

  // 2. Deny: absolute-path redirect target (anything but /dev/null).
  for (const seg of matrix.segments) {
    for (const r of seg.redirects) {
      const t = r.target.normalized;
      if (t && t !== "/dev/null" && t.startsWith("/")) return "deny";
    }
  }

  // 3. Empty / malformed → ask (fail closed).
  if (matrix.segments.length === 0) return "ask";

  // 4. Every segment must be a known read-only command with safe operands and
  //    no remaining hazards to be allowed.
  const everySegmentReadOnly = matrix.segments.every(isReadOnlySegment);
  if (!everySegmentReadOnly) return "ask";

  // Ask-class hazards block auto-allow but are not destructive.
  const askHazards: Hazard[] = [
    "parameter_expansion",
    "glob",
    "brace_expansion",
    "redirect",
    "background",
    "absolute_operand",
    "parent_escape",
    "sensitive_operand",
    "recursive_flag",
    "git_write_flag",
    "unknown_segment",
    "parse_error",
  ];
  if (askHazards.some((h) => set.has(h))) return "ask";

  return "allow";
}

/** True if a segment's leading command is in the read-only allowlist. */
function isReadOnlySegment(seg: Segment): boolean {
  if (!seg.basename) return false;
  if (seg.basename === "git") {
    const sub = seg.argv[1];
    return sub !== undefined && READ_ONLY_GIT.has(sub);
  }
  // Commands must be invoked by bare name (no path prefix) to be allowlisted;
  // a path-prefixed read-only command like /usr/bin/cat is ambiguous → not
  // auto-allowed. (Dangerous path-prefixed commands are already denied above.)
  if (seg.command !== seg.basename) return false;
  return READ_ONLY_CMDS.has(seg.basename);
}
