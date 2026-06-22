import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeGoalText,
  setGoal,
  updateGoal,
  pauseGoal,
  resumeGoal,
  completeGoal,
  renderGoal,
  goalContext,
  MAX_GOAL_CHARS,
  MAX_NOTE_CHARS,
  type SessionGoal,
} from "../../src/session/goal.js";
import { SessionStore, newSessionId, loadSession } from "../../src/session/sessionStore.js";

// =========================================================================
// Pure helper tests
// =========================================================================

test("1. empty goal is rejected", () => {
  assert.equal(normalizeGoalText(""), "");
  assert.equal(normalizeGoalText("   "), "");
  assert.equal(normalizeGoalText("\t\n  "), "");
  assert.throws(() => setGoal(""), { message: "Goal objective must not be empty" });
  assert.throws(() => setGoal("   "), { message: "Goal objective must not be empty" });
  assert.throws(() => updateGoal(undefined, ""), { message: "Goal objective must not be empty" });
});

test("2. long objective is bounded", () => {
  const long = "x".repeat(MAX_GOAL_CHARS + 1000);
  const normalised = normalizeGoalText(long);
  assert.equal(normalised.length, MAX_GOAL_CHARS);
  const goal = setGoal(long);
  assert.equal(goal.objective.length, MAX_GOAL_CHARS);
});

test("3. whitespace is normalized", () => {
  assert.equal(normalizeGoalText("  hello   world\nfoo\tbar  "), "hello world foo bar");
  const goal = setGoal("  implement   /goal  \ncommand  ");
  assert.equal(goal.objective, "implement /goal command");
});

test("4. setGoal creates active goal with timestamps", () => {
  const now = new Date("2026-06-22T20:18:00.000Z");
  const goal = setGoal("implement Phase 10M", now);
  assert.equal(goal.objective, "implement Phase 10M");
  assert.equal(goal.status, "active");
  assert.equal(goal.createdAt, now.toISOString());
  assert.equal(goal.updatedAt, now.toISOString());
  assert.equal(goal.note, undefined);
});

test("5. updateGoal preserves createdAt", () => {
  const now1 = new Date("2026-06-22T20:18:00.000Z");
  const now2 = new Date("2026-06-23T10:00:00.000Z");
  const goal = setGoal("original goal", now1);
  const updated = updateGoal(goal, "revised goal", now2);
  assert.equal(updated.objective, "revised goal");
  assert.equal(updated.createdAt, now1.toISOString()); // preserved
  assert.equal(updated.updatedAt, now2.toISOString());
  assert.equal(updated.note, undefined); // note cleared on update
});

test("5b. updateGoal with undefined goal delegates to setGoal", () => {
  const now = new Date("2026-06-22T20:18:00.000Z");
  const goal = updateGoal(undefined, "fresh goal", now);
  assert.equal(goal.objective, "fresh goal");
  assert.equal(goal.status, "active");
  assert.equal(goal.createdAt, now.toISOString());
});

test("6. pause/resume transitions are deterministic", () => {
  const now1 = new Date("2026-06-22T20:18:00.000Z");
  const now2 = new Date("2026-06-22T21:00:00.000Z");
  const goal = setGoal("my goal", now1);

  // pause
  const paused = pauseGoal(goal, "waiting for review", now2);
  assert.equal(paused.status, "paused");
  assert.equal(paused.note, "waiting for review");
  assert.equal(paused.updatedAt, now2.toISOString());
  assert.equal(paused.createdAt, now1.toISOString()); // preserved

  // pause again is idempotent
  const pausedAgain = pauseGoal(paused, undefined, now2);
  assert.equal(pausedAgain.status, "paused");
  assert.equal(pausedAgain.note, undefined);

  // resume
  const now3 = new Date("2026-06-22T22:00:00.000Z");
  const resumed = resumeGoal(paused, now3);
  assert.equal(resumed.status, "active");
  assert.equal(resumed.note, undefined);
  assert.equal(resumed.updatedAt, now3.toISOString());

  // resume of an active goal should throw
  assert.throws(() => resumeGoal(resumed), { message: "Only a paused goal can be resumed" });
});

test("7. done stores optional bounded note", () => {
  const now = new Date("2026-06-22T20:18:00.000Z");
  const goal = setGoal("finish feature", now);
  const done = completeGoal(goal, "committed and pushed", now);
  assert.equal(done.status, "done");
  assert.equal(done.note, "committed and pushed");

  // bounded note
  const longNote = "x".repeat(MAX_NOTE_CHARS + 100);
  const doneBounded = completeGoal(goal, longNote, now);
  assert.equal(doneBounded.note!.length, MAX_NOTE_CHARS);

  // done without note
  const doneNoNote = completeGoal(goal, undefined, now);
  assert.equal(doneNoNote.note, undefined);
});

test("8. goalContext omits cleared/done goal or marks done as non-active", () => {
  const now = new Date("2026-06-22T20:18:00.000Z");
  const goal = setGoal("implement /doctor command", now);

  // Active goal → returns context
  const ctx = goalContext(goal);
  assert.ok(ctx!.includes("[session-goal]"));
  assert.ok(ctx!.includes("status: active"));
  assert.ok(ctx!.includes("objective: implement /doctor command"));

  // Done goal → null (stops steering)
  const done = completeGoal(goal);
  assert.equal(goalContext(done), null);

  // No goal → null
  assert.equal(goalContext(undefined), null);

  // Paused goal → shows as paused
  const paused = pauseGoal(goal);
  const pausedCtx = goalContext(paused);
  assert.ok(pausedCtx!.includes("status: paused"));
});

test("9. renderGoal is bounded and stable", () => {
  // No goal
  assert.equal(renderGoal(undefined), "No active goal. Use /goal set <objective>.");

  // Active goal
  const now = new Date("2026-06-22T20:18:00.000Z");
  const goal = setGoal("implement /goal command", now);
  const rendered = renderGoal(goal);
  assert.ok(rendered.includes("Goal: implement /goal command"));
  assert.ok(rendered.includes("Status: active"));
  assert.ok(rendered.includes("Updated: 2026-06-22T20:18:00.000Z"));

  // With note
  const paused = pauseGoal(goal, "blocked on review", now);
  const renderedPaused = renderGoal(paused);
  assert.ok(renderedPaused.includes("Note: blocked on review"));
});

// =========================================================================
// Persistence tests
// =========================================================================

test("10. session save writes goal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-10-"));
  const id = newSessionId();
  const goal: SessionGoal = {
    objective: "my persistent goal",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await new SessionStore(root, id).save({
    model: "m",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    goal,
  });
  const loaded = await loadSession(root, id);
  assert.ok(loaded.goal, "goal should be persisted");
  assert.equal(loaded.goal!.objective, "my persistent goal");
  assert.equal(loaded.goal!.status, "active");
});

test("11. old session with no goal loads normally", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-11-"));
  const id = newSessionId();
  // Save without goal — simulates a pre-10M session.
  await new SessionStore(root, id).save({
    model: "m",
    mode: "ask",
    messages: [{ role: "user", content: "hello" }],
    todos: [],
    readTracker: new Set(),
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.goal, undefined);
  assert.equal(loaded.messages.length, 1);
});

test("12. resumed session restores active goal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-12-"));
  const id = newSessionId();
  const goal: SessionGoal = {
    objective: "resume test goal",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await new SessionStore(root, id).save({
    model: "m",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    goal,
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.goal!.objective, "resume test goal");
  assert.equal(loaded.goal!.status, "active");
});

test("12b. corrupt/invalid goal shape does not crash load", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-12b-"));
  const dir = path.join(root, ".deepcoder", "sessions");
  await mkdir(dir, { recursive: true });
  const id = newSessionId();
  // Manually write a session with a corrupt goal shape
  const corruptData = {
    id,
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    todos: [],
    readTracker: [],
    goal: { objective: "missing status" }, // missing status, createdAt, updatedAt
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(corruptData), "utf8");
  // Should not crash
  const loaded = await loadSession(root, id);
  // The field is present but shape is invalid; the PersistedSession still loads.
  assert.ok(loaded.goal !== undefined);
});

// =========================================================================
// Slash / goal persistence integration tests
// =========================================================================

test("14. /goal set ... persists goal via SessionStore.save", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-14-"));
  const id = newSessionId();
  const store = new SessionStore(root, id);
  const goal: SessionGoal = {
    objective: "set via store",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Simulate what runGoalSlash does: save with goal.
  await store.save({
    model: "m",
    mode: "auto",
    messages: [],
    todos: [],
    readTracker: new Set(),
    goal,
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.goal!.objective, "set via store");
  assert.equal(loaded.goal!.status, "active");
});

test("15. /goal pause reason persists paused status", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-15-"));
  const id = newSessionId();
  const store = new SessionStore(root, id);
  const goal: SessionGoal = {
    objective: "pause test",
    status: "paused",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: "waiting for review",
  };
  await store.save({
    model: "m",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    goal,
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.goal!.status, "paused");
  assert.equal(loaded.goal!.note, "waiting for review");
});

test("16. /goal clear removes persisted goal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-goal-16-"));
  const id = newSessionId();
  const store = new SessionStore(root, id);
  const goal: SessionGoal = {
    objective: "to be cleared",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  // Save with goal first
  await store.save({
    model: "m",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    goal,
  });
  // Now save without goal (simulating /goal clear)
  await store.save({
    model: "m",
    mode: "ask",
    messages: [],
    todos: [],
    readTracker: new Set(),
    // goal omitted
  });
  const loaded = await loadSession(root, id);
  assert.equal(loaded.goal, undefined);
});

test("17. invalid subcommand does not mutate", () => {
  // Pure helpers should throw on invalid transitions
  const goal = setGoal("valid goal");
  // resumeGoal on an active goal (not paused) should throw — no mutation
  assert.throws(() => resumeGoal(goal), { message: "Only a paused goal can be resumed" });
  // The original goal is unchanged
  assert.equal(goal.status, "active");
});
