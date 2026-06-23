/**
 * Per-prompt delegation assessment.
 *
 * deepcoder never reaches for the `delegate` tool on its own (empirically: a
 * neutral multi-subsystem audit produced 0 delegate calls and ground serially).
 * This module is the missing nudge: on each top-level user prompt it cheaply
 * decides whether the task looks worth fanning out, and if so returns ONE
 * advisory hint to inject into the model's context for that turn.
 *
 * It is ADVISORY ONLY — the model still chooses. It never invokes delegation,
 * never escalates a mutating path, and is fail-safe: a classifier failure can
 * only produce (or omit) a hint, never block or change what runs.
 */

import { classifyTask, type ClassifyDeps } from "./taskClassifier.js";

/** Breadth signals: words that mark a task as spanning multiple areas. */
const BREADTH = /\b(audit|every|all|across|each|multiple|subsystem|subsystems|throughout|entire|codebase|repo-wide|refactor|wire|survey)\b/i;

/** Below this length a prompt without breadth signals is treated as localized. */
const SUBSTANTIAL_CHARS = 160;

/**
 * Cheap, pure pre-gate. Returns true only when a prompt is substantial or shows
 * breadth signals — so trivial asks ("fix this typo") never cost a model call.
 */
export function looksDelegable(prompt: string): boolean {
  const p = prompt.trim();
  if (p.length >= SUBSTANTIAL_CHARS) return true;
  return BREADTH.test(p);
}

/**
 * Assess a prompt for delegability. Returns an advisory hint string to inject,
 * or null to inject nothing. Never throws.
 *
 * - Not delegable (pre-gate) → null, no model call.
 * - Classified "simple-edit" → null (delegating a localized change isn't worth it).
 * - Otherwise ("multi-file" or broad "research") → a one-line nudge toward `delegate`.
 */
export async function assessDelegation(prompt: string, deps: ClassifyDeps): Promise<string | null> {
  if (!looksDelegable(prompt)) return null;
  const c = await classifyTask(prompt, deps); // already fail-safe to "research"
  if (c.category === "simple-edit") return null;
  return (
    `[delegation assessment] This request looks like ${c.category} — ${c.reason}. ` +
    `Consider fanning out with the delegate tool (one read-only subagent per ` +
    `subsystem/area) instead of investigating everything serially, then act on ` +
    `their findings yourself. Advisory — you decide.`
  );
}

/**
 * Precompute the delegation assessment for a prompt and return a SYNC, yield-once
 * callback suitable for the agent loop's `deps.delegationHint`. The hint (if any)
 * is injected into exactly the first turn that asks for it; later turns get [].
 * This bridges the async assessment to the loop's synchronous ephemeral-context path.
 */
export async function makeDelegationHint(prompt: string, deps: ClassifyDeps): Promise<() => string[]> {
  const hint = await assessDelegation(prompt, deps);
  let yielded = false;
  return () => {
    if (hint && !yielded) {
      yielded = true;
      return [hint];
    }
    return [];
  };
}
