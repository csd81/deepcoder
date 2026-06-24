import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionStore, newSessionId } from "../../src/session/sessionStore.js";
import { defaultRegistry } from "../../src/tools/registry.js";
import { handleSlashCommand } from "../../src/cli/slashCommands.js";
import { ScriptedProvider } from "../helpers/providers.js";
import type { Session } from "../../src/cli/repl.js";
import type { Config } from "../../src/config/config.js";
import type { ModelProvider } from "../../src/providers/types.js";

async function makeSession(provider: ModelProvider): Promise<{ session: Session; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "scaffold-adv-"));
  const config: Config = {
    provider: "deepseek", apiKey: "test", baseUrl: "https://example.com", model: "deepseek-chat",
    maxTurns: 20, approvalMode: "ask", contextBudgetTokens: 64000, compactAt: 0.8,
    checkpoints: "off", workspaceRoot: root, mcpServers: {}, mcpExecuteEnabled: false,
  } as Config;
  const session = {
    config, provider, registry: defaultRegistry(), store: new SessionStore(root, newSessionId()),
    messages: [{ role: "system", content: "system prompt" }], profiles: {},
    mode: "ask", todos: [], readTracker: new Set(), writeTracker: new Set(), reviews: [], briefs: [], plans: [], activatedSkills: [],
  } as unknown as Session;
  return { session, root };
}

const save = async (): Promise<void> => {};

// The model controls `targetPath`. A path escaping the workspace MUST be refused —
// the handler routes it through resolveInWorkspace, the canonical confinement.
test("[scaffold-adv] refuses a model targetPath that escapes the workspace", async () => {
  const escape = JSON.stringify({ content: "PWNED", targetPath: "../escape-pwned.txt" });
  const { session, root } = await makeSession(new ScriptedProvider([{ text: escape, toolCalls: [] }]));

  await handleSlashCommand("/scaffold module evil", session, save);

  // Nothing must have been written at the escaped location (one level above root).
  const escaped = path.join(root, "..", "escape-pwned.txt");
  await assert.rejects(stat(escaped), "escaping scaffold target must not be written");
});

// Scaffold only CREATES new files; it must never clobber an existing one.
test("[scaffold-adv] refuses to overwrite an existing file", async () => {
  const target = JSON.stringify({ content: "NEW CONTENT", targetPath: "keep.txt" });
  const { session, root } = await makeSession(new ScriptedProvider([{ text: target, toolCalls: [] }]));
  await writeFile(path.join(root, "keep.txt"), "ORIGINAL", "utf8");

  await handleSlashCommand("/scaffold module keep", session, save);

  assert.equal(await readFile(path.join(root, "keep.txt"), "utf8"), "ORIGINAL", "existing file must be left untouched");
});

// Happy path: a valid in-workspace targetPath is written.
test("[scaffold] writes a new file at a confined target path", async () => {
  const ok = JSON.stringify({ content: "export const x = 1;\n", targetPath: "src/generated/x.ts" });
  const { session, root } = await makeSession(new ScriptedProvider([{ text: ok, toolCalls: [] }]));

  await handleSlashCommand("/scaffold module x", session, save);

  assert.equal(await readFile(path.join(root, "src/generated/x.ts"), "utf8"), "export const x = 1;\n");
});
