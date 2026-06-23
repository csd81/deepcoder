import { test } from "node:test";
import assert from "node:assert/strict";
import { looksDelegable, assessDelegation, makeDelegationHint } from "../src/delegate/assess.js";
import type { ModelProvider } from "../src/providers/types.js";

/** Fake provider: returns canned text, throws, or records that it was called. */
function fakeProvider(reply: string | { throw: true }, calls?: { n: number }): ModelProvider {
  return {
    chat: async () => {
      if (calls) calls.n++;
      if (typeof reply !== "string") throw new Error("provider exploded");
      return { text: reply, toolCalls: [] };
    },
  } as unknown as ModelProvider;
}

const BROAD = "Audit every subsystem across the entire codebase and report which modules are wired to the entry point and which are dead.";

test("[assess] looksDelegable: trivial short prompt → false", () => {
  assert.equal(looksDelegable("fix the typo teh -> the"), false);
});

test("[assess] looksDelegable: breadth keyword → true", () => {
  assert.equal(looksDelegable("audit the tools registry"), true);
});

test("[assess] looksDelegable: long prompt → true", () => {
  assert.equal(looksDelegable("x".repeat(200)), true);
});

test("[assess] not delegable → null and NO model call", async () => {
  const calls = { n: 0 };
  const r = await assessDelegation("fix typo", { provider: fakeProvider("{}", calls), model: "m" });
  assert.equal(r, null);
  assert.equal(calls.n, 0, "must not spend a model call on a trivially non-delegable prompt");
});

test("[assess] simple-edit classification → null (no nudge)", async () => {
  const r = await assessDelegation(BROAD, {
    provider: fakeProvider('{"category":"simple-edit","reason":"one spot"}'),
    model: "m",
  });
  assert.equal(r, null);
});

test("[assess] multi-file → hint mentioning the delegate tool", async () => {
  const r = await assessDelegation(BROAD, {
    provider: fakeProvider('{"category":"multi-file","reason":"spans many files"}'),
    model: "m",
  });
  assert.ok(r && /delegate/i.test(r), "hint should mention delegate");
  assert.ok(/multi-file/.test(r!), "hint should name the category");
  assert.ok(/spans many files/.test(r!), "hint should carry the reason");
});

test("[assess] broad research → hint", async () => {
  const r = await assessDelegation(BROAD, {
    provider: fakeProvider('{"category":"research","reason":"multi-area audit"}'),
    model: "m",
  });
  assert.ok(r && /delegate/i.test(r));
});

test("[assess] fail-safe: provider throws → never throws, still returns a hint (research)", async () => {
  const r = await assessDelegation(BROAD, { provider: fakeProvider({ throw: true }), model: "m" });
  // classifyTask is fail-safe to "research"; broad prompt is delegable → hint, no throw.
  assert.ok(r && /delegate/i.test(r));
});

test("[assess] makeDelegationHint: yields the hint exactly once, then empty", async () => {
  const yieldHint = await makeDelegationHint(BROAD, {
    provider: fakeProvider('{"category":"multi-file","reason":"spans files"}'),
    model: "m",
  });
  const first = yieldHint();
  assert.equal(first.length, 1);
  assert.ok(/delegate/i.test(first[0]));
  assert.deepEqual(yieldHint(), [], "second call yields nothing");
  assert.deepEqual(yieldHint(), [], "stays empty");
});

test("[assess] makeDelegationHint: non-delegable prompt → always empty", async () => {
  const yieldHint = await makeDelegationHint("fix typo", {
    provider: fakeProvider('{"category":"simple-edit","reason":"x"}'),
    model: "m",
  });
  assert.deepEqual(yieldHint(), []);
});
