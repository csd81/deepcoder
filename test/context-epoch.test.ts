import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type ApprovalMode } from "../src/config/config.js";
import { defaultRegistry } from "../src/tools/registry.js";
import {
  systemMessage,
  resolveInstructions,
  buildContextSnapshot,
  reconcileSessionContext,
  resetSessionContextEpoch,
  type Session,
} from "../src/cli/repl.js";
import { isContextUpdateMessage, CONTEXT_UPDATE_PREFIX } from "../src/context/registry.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

async function makeSession(mode: ApprovalMode = "ask"): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "ctx-epoch-"));
  await writeFile(path.join(root, "AGENTS.md"), "# Project\nUse npm.\n");
  await mkdir(path.join(root, ".deepcoder", "memory"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "memory", "MEMORY.md"), "- remembered: prefer X\n");
  const config = loadConfig({ workspaceRoot: root, model: "deepseek-chat", approvalMode: mode, apiKey: "fixture" });
  const registry = defaultRegistry();
  const instr = resolveInstructions(config);
  const messages = [systemMessage(config, mode, instr.text, "", registry.names())];
  const contextSnapshot = buildContextSnapshot(config, mode, instr.text, "");
  return { config, mode, registry, messages, contextSnapshot } as unknown as Session;
}

test("[epoch] a freshly built session is in sync — reconciliation emits nothing", async () => {
  const session = await makeSession("ask");
  assert.deepEqual(reconcileSessionContext(session), []);
  // The baseline carries the project sources.
  assert.match(session.messages[0]!.content, /Project instructions/);
  assert.match(session.messages[0]!.content, /Project memory/);
  assert.match(session.messages[0]!.content, /Approval mode: ask/);
});

test("[epoch] /mode change appends ONE [context-update] and never mutates messages[0]", async () => {
  const session = await makeSession("ask");
  const baselineBefore = session.messages[0]!.content;
  const epochBefore = session.contextSnapshot.epochId;

  // Simulate `/mode auto` (slashCommands sets session.mode; no rebuild of [0]).
  session.mode = "auto";
  const updates = reconcileSessionContext(session);

  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.role, "system");
  assert.ok(updates[0]!.content.startsWith(CONTEXT_UPDATE_PREFIX));
  assert.match(updates[0]!.content, /Approval mode: auto/);
  // messages[0] is byte-stable — the whole prefix stays cacheable.
  assert.equal(session.messages[0]!.content, baselineBefore);
  // Snapshot advanced, epoch identity preserved.
  assert.equal(session.contextSnapshot.sources.mode, "auto");
  assert.equal(session.contextSnapshot.epochId, epochBefore);
});

test("[epoch] reconciliation is idempotent — a second call with no change emits nothing", async () => {
  const session = await makeSession("ask");
  session.mode = "auto";
  assert.equal(reconcileSessionContext(session).length, 1);
  assert.deepEqual(reconcileSessionContext(session), []);
});

test("[epoch] a changed memory file is folded into a [context-update]", async () => {
  const session = await makeSession("ask");
  const memPath = path.join(session.config.workspaceRoot, ".deepcoder", "memory", "MEMORY.md");
  await writeFile(memPath, "- remembered: prefer Y now\n");
  const updates = reconcileSessionContext(session);
  assert.equal(updates.length, 1);
  assert.match(updates[0]!.content, /### Project memory/);
  assert.match(updates[0]!.content, /prefer Y now/);
});

test("[epoch] compaction reset rebuilds messages[0], strips stale updates, re-syncs snapshot", async () => {
  const session = await makeSession("ask");
  const baselineBefore = session.messages[0]!.content;

  session.mode = "auto";
  session.messages.push(...reconcileSessionContext(session));
  // Add some conversation + a stale update to be stripped.
  session.messages.push({ role: "user", content: "do a thing" });
  assert.ok(session.messages.some(isContextUpdateMessage));

  resetSessionContextEpoch(session);

  // New baseline reflects current mode; no stale [context-update] survives.
  assert.equal(session.messages[0]!.role, "system");
  assert.notEqual(session.messages[0]!.content, baselineBefore);
  assert.match(session.messages[0]!.content, /Approval mode: auto/);
  assert.ok(!session.messages.some(isContextUpdateMessage));
  // Snapshot back in sync → next reconcile emits nothing.
  assert.deepEqual(reconcileSessionContext(session), []);
  // Non-context conversation is preserved.
  assert.ok(session.messages.some((m) => m.role === "user" && m.content === "do a thing"));
});
