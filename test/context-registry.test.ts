import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextRegistry,
  defaultContextRegistry,
  contextRegistry,
  isContextUpdateMessage,
  CONTEXT_UPDATE_PREFIX,
  type ContextInputs,
} from "../src/context/registry.js";

const INPUTS = (over: Partial<ContextInputs> = {}): ContextInputs => ({
  instructions: "use npm",
  memory: "- remembered fact",
  skills: "- review: code review",
  mode: "ask",
  ...over,
});

test("[registry] the source set is exactly the four trusted, project-owned facts", () => {
  // A regression guard: no untrusted source (MCP/check/subagent/skill-body) may
  // ever be reconciled into context.
  assert.deepEqual(contextRegistry.keys().sort(), ["instructions", "memory", "mode", "skills"]);
});

test("[registry] snapshot is deterministic and epochId is content-addressed", () => {
  const a = contextRegistry.snapshot(INPUTS());
  const b = contextRegistry.snapshot(INPUTS());
  assert.deepEqual(a, b);
  assert.equal(a.epochId, b.epochId);
  // Different content → different epoch id.
  const c = contextRegistry.snapshot(INPUTS({ mode: "auto" }));
  assert.notEqual(c.epochId, a.epochId);
});

test("[registry] snapshot honors an explicit epochId (reconcile keeps epoch identity)", () => {
  const base = contextRegistry.snapshot(INPUTS());
  const next = contextRegistry.snapshot(INPUTS({ mode: "auto" }), base.epochId);
  assert.equal(next.epochId, base.epochId); // identity stable across reconcile
  assert.equal(next.sources.mode, "auto"); // values updated
});

test("[registry] diff returns only the changed keys", () => {
  const prev = contextRegistry.snapshot(INPUTS());
  const next = contextRegistry.snapshot(INPUTS({ mode: "auto", memory: "- new fact" }));
  assert.deepEqual(contextRegistry.diff(prev, next).sort(), ["memory", "mode"]);
  // No change → empty.
  assert.deepEqual(contextRegistry.diff(prev, contextRegistry.snapshot(INPUTS())), []);
});

test("[registry] a net-zero flip (ask→auto→ask) produces no diff (updates coalesce)", () => {
  const prev = contextRegistry.snapshot(INPUTS({ mode: "ask" }));
  // The user toggled to auto then back to ask before the next turn.
  const next = contextRegistry.snapshot(INPUTS({ mode: "ask" }), prev.epochId);
  assert.deepEqual(contextRegistry.diff(prev, next), []);
});

test("[registry] renderUpdate emits one [context-update] block for only the changed keys", () => {
  const prev = contextRegistry.snapshot(INPUTS());
  const next = contextRegistry.snapshot(INPUTS({ mode: "auto" }), prev.epochId);
  const changed = contextRegistry.diff(prev, next);
  const block = contextRegistry.renderUpdate(next, changed);
  assert.ok(block.startsWith(CONTEXT_UPDATE_PREFIX));
  assert.match(block, /### Approval mode/);
  assert.match(block, /Approval mode: auto/);
  // Unchanged sources are NOT included.
  assert.doesNotMatch(block, /### Project instructions/);
  assert.doesNotMatch(block, /### Project memory/);
});

test("[registry] renderBaseline omits empty sources but always keeps mode", () => {
  const snap = contextRegistry.snapshot(INPUTS({ instructions: "", memory: "", skills: "" }));
  const baseline = contextRegistry.renderBaseline(snap);
  assert.match(baseline, /Approval mode: ask/);
  assert.doesNotMatch(baseline, /## Project instructions/);
  assert.doesNotMatch(baseline, /## Project memory/);
  assert.doesNotMatch(baseline, /## Available skills/);
});

test("[registry] isContextUpdateMessage keys strictly on the prefix + system role", () => {
  assert.equal(
    isContextUpdateMessage({ role: "system", content: `${CONTEXT_UPDATE_PREFIX} changed` }),
    true,
  );
  assert.equal(isContextUpdateMessage({ role: "user", content: `${CONTEXT_UPDATE_PREFIX} x` }), false);
  assert.equal(isContextUpdateMessage({ role: "system", content: "## Project instructions" }), false);
});

test("[registry] a removed source renders as '(now empty)' in an update", () => {
  const prev = contextRegistry.snapshot(INPUTS({ memory: "- a fact" }));
  const next = contextRegistry.snapshot(INPUTS({ memory: "" }), prev.epochId);
  const block = contextRegistry.renderUpdate(next, contextRegistry.diff(prev, next));
  assert.match(block, /### Project memory\n\(now empty\)/);
});

test("[registry] register() is additive and order-preserving on a fresh registry", () => {
  const reg = new ContextRegistry();
  assert.deepEqual(reg.keys(), []);
  const def = defaultContextRegistry();
  assert.deepEqual(def.keys(), ["instructions", "memory", "skills", "mode"]);
});
