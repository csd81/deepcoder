import { parseShellProgram } from "../permissions/shellAst.js";
import { buildCommandMatrix } from "../permissions/commandMatrix.js";
import { isSensitivePath } from "../workspace/sensitive.js";
import type { PreToolUseInput } from "../hooks/types.js";

export interface RuleResult {
  hardBlock: boolean;
  softBlock: boolean;
  reason: string;
}

export function evaluateRules(input: PreToolUseInput): RuleResult | { hardBlock: false; softBlock: false } {
  let hasHardBlock = false;
  let hasSoftBlock = false;
  let reason = "";

  if (input.command) {
    const parsed = parseShellProgram(input.command);
    if (!parsed.ok) {
      return { hardBlock: true, softBlock: false, reason: "undecodable or invalid shell payload" };
    }
    const matrix = buildCommandMatrix(parsed.program);

    for (const seg of matrix.segments) {
      const bn = seg.basename;
      const isNetwork = bn === "curl" || bn === "wget" || bn === "nc";

      // HARD BLOCK: curl | sh
      if (isNetwork && matrix.hazards.includes("pipe_to_shell")) {
        hasHardBlock = true;
        reason = "exfil command (curl ... | sh to external host)";
        break;
      }

      // HARD BLOCK: sending data externally
      const isSending = seg.argv.some(a => a === "-d" || a === "--data" || a === "-T" || a === "-XPOST");
      if (isNetwork && isSending) {
        hasHardBlock = true;
        reason = "exfiltration of data to external host";
        break;
      }

      // HARD BLOCK: read of a sensitive path crossing trust boundary
      if (isNetwork && input.affectedPaths?.some(p => isSensitivePath(p))) {
        hasHardBlock = true;
        reason = "read of a sensitive/credential path when content crosses the trust boundary";
        break;
      }

      // SOFT BLOCK: git force-push / history rewrite
      if (bn === "git") {
        const isForce = seg.argv.some(a => a === "--force" || a === "-f");
        const isPush = seg.argv[1] === "push";
        if (isPush && isForce) {
          hasSoftBlock = true;
          reason = "git force-push / history rewrite";
        }
      }
    }
  }

  // Also check if affectedPaths contains sensitive path and tool is network-bound (e.g. web_fetch)
  // But wait, the test specifically said "read of a sensitive/credential path in affectedPaths ... when content crosses the trust boundary"
  // Let's assume web_fetch doesn't read local paths. But if it did, it would be an issue.
  if (input.affectedPaths && !hasHardBlock) {
    const hasSensitive = input.affectedPaths.some(p => isSensitivePath(p));
    if (hasSensitive && (input.tool === "web_fetch" || input.tool === "web_search" || input.command?.includes("curl"))) {
      hasHardBlock = true;
      reason = "read of a sensitive/credential path when content crosses the trust boundary";
    }
  }

  if (hasHardBlock) {
    return { hardBlock: true, softBlock: false, reason };
  }
  if (hasSoftBlock) {
    return { hardBlock: false, softBlock: true, reason };
  }

  return { hardBlock: false, softBlock: false };
}
