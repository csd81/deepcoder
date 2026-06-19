import type { HookConfig, PreToolUseInput } from "./types.js";

/**
 * Core matcher: keep hooks whose matcher matches ANY of the given keys. A hook
 * with no matcher matches everything. `*` (or empty) matches all. `a|b` is an
 * exact-alternative list. Otherwise the matcher is a JavaScript regex. An
 * invalid regex is silently skipped (fail-open — never throws).
 */
export function matchHooksByKeys(hooks: HookConfig[], keys: (string | undefined)[]): HookConfig[] {
  const present = keys.filter((k): k is string => k !== undefined);
  const result: HookConfig[] = [];
  for (const h of hooks) {
    if (!h.matcher || h.matcher === "*") {
      result.push(h);
      continue;
    }
    // Exact-alternative form "a|b|c" — match a whole key exactly.
    if (/^[\w$.|-]+$/.test(h.matcher) && h.matcher.includes("|")) {
      const alts = new Set(h.matcher.split("|"));
      if (present.some((k) => alts.has(k))) result.push(h);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(h.matcher);
    } catch {
      continue; // invalid regex — skip (fail-open)
    }
    if (present.some((k) => re.test(k))) result.push(h);
  }
  return result;
}

/**
 * Filter PreToolUse hooks whose matcher matches the tool name OR the command.
 * Kept as the stable entry point for the blocking pre-tool path.
 */
export function matchHooks(hooks: HookConfig[], input: PreToolUseInput): HookConfig[] {
  return matchHooksByKeys(hooks, [input.tool, input.command]);
}
