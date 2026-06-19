import type { HookConfig, PreToolUseInput } from "./types.js";

/**
 * Filter hooks whose matcher (regex, tested against input.tool OR input.command)
 * match. A hook with no matcher matches all inputs. An invalid regex is silently
 * skipped (never throws).
 */
export function matchHooks(hooks: HookConfig[], input: PreToolUseInput): HookConfig[] {
  const result: HookConfig[] = [];
  for (const h of hooks) {
    if (!h.matcher) {
      result.push(h);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(h.matcher);
    } catch {
      // Invalid regex — skip this hook silently (fail-open).
      continue;
    }
    if (re.test(input.tool)) {
      result.push(h);
      continue;
    }
    if (input.command !== undefined && re.test(input.command)) {
      result.push(h);
      continue;
    }
  }
  return result;
}
