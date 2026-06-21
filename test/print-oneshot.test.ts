import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runOneShot, systemMessage, type Session } from "../src/cli/repl.js";
import { defaultRegistry } from "../src/tools/registry.js";
import { SessionStore, newSessionId } from "../src/session/sessionStore.js";
import { loadConfig } from "../src/config/config.js";
import type { ChatRequest, ChatResponse, ModelEvent, ModelProvider } from "../src/providers/types.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

// Streams its text like a real provider (the agent loop renders streamed deltas).
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

async function session(provider: ModelProvider): Promise<Session> {
  const root = await mkdtemp(path.join(tmpdir(), "print-oneshot-"));
  const config = loadConfig({ workspaceRoot: root, model: "deepseek-chat", approvalMode: "auto", apiKey: "fixture" });
  return {
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

test("runOneShot with print:true writes only the raw assistant text to stdout", async () => {
  const s = await session(new TextProvider("The answer is 4."));
  const out = await captureStdout(() => runOneShot(s, "what is 2+2", { print: true }));
  assert.equal(out, "The answer is 4.\n");
  assert.ok(!/assistant>/.test(out), "no assistant> header in print mode");
});

test("runOneShot without print uses the chrome'd plain renderer (assistant> header)", async () => {
  const s = await session(new TextProvider("hello"));
  const out = await captureStdout(() => runOneShot(s, "hi"));
  assert.ok(/assistant>/.test(out), "default plain renderer prints an assistant> header");
});
