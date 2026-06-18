import type { ApprovalDecision } from "./policy.js";

/**
 * Classify a raw bash command into a default permission decision. This is a
 * conservative heuristic, not a sandbox: it errs toward `ask`/`deny` and never
 * tries to be clever about commands it doesn't recognise.
 */

// Commands that only read state — safe to allow even in `auto` mode.
const READ_ONLY = [
  /^pwd\b/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^echo\b/,
  /^which\b/,
  /^rg\b/,
  /^grep\b/,
  /^find\b/,
  /^wc\b/,
  /^git\s+(status|diff|log|show|branch|remote)\b/,
];

// Patterns that are never auto-runnable — destructive, privileged, or able to
// escape the workspace / current command.
const DANGEROUS = [
  /\brm\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill(all)?\b/,
  /:\s*\(\s*\)\s*\{/, // fork bomb :(){
  /\$\(/, // command substitution $(...)
  /`/, // command substitution backticks
  /(^|\s)>\s*\/(?!dev\/null)/, // redirect to an absolute path (outside workspace)
  /\s&\s*$/, // background daemon
  /\bnohup\b/,
  /\bcurl\b[^|]*\|\s*(sh|bash)/, // curl | sh
  /\bwget\b[^|]*\|\s*(sh|bash)/,
];

export function classifyCommand(command: string): ApprovalDecision {
  const cmd = command.trim();
  for (const re of DANGEROUS) {
    if (re.test(cmd)) return "deny";
  }
  for (const re of READ_ONLY) {
    if (re.test(cmd)) return "allow";
  }
  // Builds, tests, installs, and everything else we don't explicitly trust.
  return "ask";
}
