import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMessagesForQuery, withEphemeralContext } from "../src/context/queryProjection.js";
import { makeCtx, makeDeps } from "./helpers/providers.js";
import { FauxProvider } from "../src/providers/fauxProvider.js";
import type { AgentMessage } from "../src/providers/types.js";
import type { Todo } from "../src/tools/types.js";

const ROOT = "/tmp/qp-test";

function base(): AgentMessage[] {
  return [
    { role: "system", content: "You are deepcoder." },
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "on it" },
  ];
}

const TODOS: Todo[] = [{ id: "1", content: "fix", status: "pending" }];

test("ephemeral todos/jit/playbook appear in messagesForQuery but not in canonical messages", () => {
  const messages = base();
  const ctx = makeCtx(ROOT, { todos: TODOS });
  const deps = makeDeps(new FauxProvider(), ctx, {
    jitContext: () => ["JIT: rules for src/"],
    playbookContext: () => ["PLAYBOOK: do the thing"],
  });

  const before = structuredClone(messages);
  const proj = buildMessagesForQuery({ messages, ctx, deps });

  // Canonical history is untouched by the ephemeral (projection-only) stage.
  assert.deepEqual(messages, before, "canonical messages must not gain ephemeral blocks");

  const projText = proj.messagesForQuery.map((m) => m.content).join("\n");
  assert.match(projText, /Current todo list:/);
  assert.match(projText, /JIT: rules for src\//);
  assert.match(projText, /PLAYBOOK: do the thing/);
  // messagesForQuery is a fresh array, longer than canonical by the 3 blocks.
  assert.equal(proj.messagesForQuery.length, messages.length + 3);
});

test("output is byte-identical to withEphemeralContext over post-reconcile messages", () => {
  const messages = base();
  const ctx = makeCtx(ROOT, { todos: TODOS });
  const update: AgentMessage = { role: "system", content: "[context-update]\nmode: auto" };
  const deps = makeDeps(new FauxProvider(), ctx, {
    reconcileContext: () => [update],
    jitContext: () => ["JIT block"],
  });

  const proj = buildMessagesForQuery({ messages, ctx, deps });

  // After the durable reconcile push, the projection must equal exactly what the
  // old call site produced: withEphemeralContext(<post-reconcile messages>, …).
  const expected = withEphemeralContext(messages, ctx, deps);
  assert.deepEqual(proj.messagesForQuery, expected);
});

test("reconcile appends a [context-update] to canonical messages and flags it", () => {
  const messages = base();
  const ctx = makeCtx(ROOT, { todos: [] });
  const update: AgentMessage = { role: "system", content: "[context-update]\nmode: auto" };
  const deps = makeDeps(new FauxProvider(), ctx, { reconcileContext: () => [update] });

  const proj = buildMessagesForQuery({ messages, ctx, deps });

  assert.equal(proj.contextUpdatesAppended, true);
  assert.deepEqual(messages[messages.length - 1], update, "update pushed onto canonical history");
  assert.equal(proj.stageStats.find((s) => s.stage === "reconcile")?.changed, true);
});

test("below the compact threshold: no compaction, no reconcile, projection == withEphemeralContext", () => {
  const messages = base();
  const canonicalBefore = structuredClone(messages);
  const ctx = makeCtx(ROOT, { todos: TODOS });
  const deps = makeDeps(new FauxProvider(), ctx); // generous default budget, no reconcile

  const proj = buildMessagesForQuery({ messages, ctx, deps });

  assert.equal(proj.compaction.compacted, false);
  assert.equal(proj.contextUpdatesAppended, false);
  assert.deepEqual(messages, canonicalBefore, "messages unchanged below threshold");
  assert.deepEqual(proj.messagesForQuery, withEphemeralContext(messages, ctx, deps));
});

test("compaction triggers under a tiny budget: durable mutation + flag + stageStats", () => {
  const messages: AgentMessage[] = [
    { role: "system", content: "You are deepcoder." },
    { role: "user", content: "the original task description goes here and is long enough" },
    { role: "assistant", content: "thinking about the problem at some length here too" },
    { role: "user", content: "more context to push us over the small budget threshold now" },
    { role: "assistant", content: "still working through the details of the requested change" },
    { role: "user", content: "final recent turn that should survive in the kept tail region" },
  ];
  const ctx = makeCtx(ROOT, { todos: [] });
  // Tiny budget so ordinary messages exceed compactAt × budget and compact.
  const deps = makeDeps(new FauxProvider(), ctx, { contextBudgetTokens: 40, compactAt: 0.5 });

  const lenBefore = messages.length;
  const proj = buildMessagesForQuery({ messages, ctx, deps });

  assert.equal(proj.compaction.compacted, true);
  assert.ok(messages.length < lenBefore, "older turns spliced into a summary");
  assert.equal(messages[0].role, "system", "system prompt preserved at index 0");
  const compactStat = proj.stageStats.find((s) => s.stage === "auto-compact");
  assert.equal(compactStat?.changed, true);
  assert.ok(compactStat!.after <= compactStat!.before, "compaction does not grow tokens");
});

test("stageStats reports the pipeline + reconcile stages", () => {
  // Below the compact threshold: the pipeline runs only the auto-compact stage
  // (no Trident sub-stat when compaction doesn't trigger), then reconcile.
  const messages = base();
  const ctx = makeCtx(ROOT, { todos: [] });
  const deps = makeDeps(new FauxProvider(), ctx);
  const proj = buildMessagesForQuery({ messages, ctx, deps });
  assert.deepEqual(proj.stageStats.map((s) => s.stage), ["auto-compact", "reconcile"]);
});
