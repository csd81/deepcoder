/**
 * Phase 8B follow-up — proactive auto-memory in the REPL run loop:
 * after a successful turn that changed files, stage an inbox candidate.
 * Candidates go to the inbox only — never auto-recalled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOneShot, systemMessage, type Session } from "../src/cli/repl.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { ChatRequest, ChatResponse, ModelEvent, ModelProvider } from "../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

/** A provider that streams back the given text (no tool calls). */
class TextProvider implements ModelProvider {
  constructor(private text: string) {}
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    return { text: this.text, toolCalls: [] };
  }
  async *streamChat(_req: ChatRequest): AsyncIterable<ModelEvent> {
    yield { type: "assistant_text_delta", text: this.text };
    yield { type: "done" };
  }
}

async function makeSession(provider: ModelProvider): Promise<{ session: Session; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "repl-auto-mem-"));
  const config = loadConfig({
    workspaceRoot: root,
    model: "deepseek-chat",
    approvalMode: "auto",
    apiKey: "fixture",
  });
  const session: Session = {
    config,
    provider,
    registry: defaultRegistry(),
    store: new SessionStore(root, newSessionId()),
    messages: [systemMessage(config, "auto")],
    mode: "auto",
    todos: [],
    readTracker: new Set(),
    writeTracker: new Set(),
    reviews: [],
  };
  return { session, root };
}

/** Capture everything written to process.stdout during fn(). */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (s: unknown) => boolean }).write = (s: unknown) => {
    chunks.push(String(s));
    return true;
  };
  try {
    await fn();
  } finally {
    (process.stdout as unknown as { write: typeof orig }).write = orig;
  }
  return chunks.join("");
}

test("Phase 8B follow-up: a successful mutating turn stages one inbox candidate naming the changed files", async () => {
  const { loadInbox, loadStartupMemory } = await import("../src/memory/store.js");
  const { session, root } = await makeSession(new TextProvider("done."));
  try {
    // Simulate a turn that changed files by pre-populating the write tracker.
    session.writeTracker.add(path.join(root, "src/editor.ts"));
    session.writeTracker.add(path.join(root, "src/utils.ts"));

    // Non-print mode so the memory notice goes directly to stdout (the print
    // renderer suppresses notices) — we verify both the inbox state AND the
    // printed notice in this single test.
    const out = await captureStdout(() => runOneShot(session, "do something"));

    const inbox = await loadInbox(root);
    assert.equal(inbox.length, 1, "exactly one candidate was staged");
    assert.match(inbox[0]!.text, /Edited editor\.ts, utils\.ts/, "the candidate names the changed files");
    assert.equal(inbox[0]!.source, "agent-loop", "source is agent-loop");
    // Safety: staged candidates must NOT be auto-recalled into the prompt.
    assert.ok(!(await loadStartupMemory(root)).includes("Edited"), "inbox must not reach startup memory");
    // The notice must be printed to stdout.
    assert.match(out, /memory: staged 1 candidate/, "the memory notice appears in output");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Phase 8B follow-up: a non-mutating successful turn stages nothing", async () => {
  const { loadInbox } = await import("../src/memory/store.js");
  const { session, root } = await makeSession(new TextProvider("nothing changed."));
  try {
    // writeTracker starts empty — no files changed this turn.
    await runOneShot(session, "just read something", { print: true });

    const inbox = await loadInbox(root);
    assert.equal(inbox.length, 0, "no candidate was staged for a non-mutating turn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
