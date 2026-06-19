import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config/config.js";
import { resolveInstructions } from "../../src/cli/repl.js";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "instr-int-"));
}

test("graph OFF (default): resolveInstructions uses the legacy first-match loader, no graph", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "AGENTS.md"), "legacy agents text\n");
  await writeFile(path.join(root, "CLAUDE.md"), "claude text\n");
  const config = loadConfig({ workspaceRoot: root });
  assert.equal(config.context.instructionGraph, false);
  const { text, graph } = resolveInstructions(config);
  assert.equal(graph, undefined, "no graph when disabled");
  // First-match wins: only AGENTS.md (CLAUDE.md not concatenated).
  assert.match(text, /legacy agents text/);
  assert.doesNotMatch(text, /claude text/);
});

test("graph ON: resolveInstructions returns a live graph + concatenated rendered text", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "AGENTS.md"), "agents rule\n");
  await writeFile(path.join(root, "CLAUDE.md"), "claude rule\n");
  const config = loadConfig({ workspaceRoot: root, context: { instructionGraph: true } });
  const { text, graph } = resolveInstructions(config);
  assert.ok(graph, "graph present when enabled");
  // The graph concatenates BOTH files (unlike first-match).
  assert.match(text, /agents rule/);
  assert.match(text, /claude rule/);
  assert.equal(graph!.workspaceRoot, path.resolve(root));
});

test("security: a sensitive @import is refused even with imports enabled", async () => {
  const root = await workspace();
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "instructions.md"), "SECRET-INNER\n");
  await writeFile(path.join(root, "AGENTS.md"), "outer\n@./.deepcoder/instructions.md\n");
  const config = loadConfig({ workspaceRoot: root, context: { instructionGraph: true } });
  const { graph } = resolveInstructions(config);
  assert.ok(
    graph!.warnings.some((w) => w.kind === "unsafe_import" && /sensitive/.test(w.message)),
    "sensitive import refused",
  );
});

test("security: the graph never pulls instructions from .deepcoder/runs", async () => {
  const root = await workspace();
  await mkdir(path.join(root, ".deepcoder", "runs"), { recursive: true });
  await mkdir(path.join(root, ".deepcoder", "rules"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "runs", "leak.md"), "RUN-LOG-LEAK\n");
  await writeFile(path.join(root, ".deepcoder", "rules", "ok.md"), "legit rule\n");
  const config = loadConfig({ workspaceRoot: root, context: { instructionGraph: true } });
  const { text } = resolveInstructions(config);
  assert.match(text, /legit rule/);
  assert.doesNotMatch(text, /RUN-LOG-LEAK/);
});

test("imports can be disabled via config (instructionImports:false)", async () => {
  const root = await workspace();
  await writeFile(path.join(root, "shared.md"), "IMPORTED-BODY\n");
  await writeFile(path.join(root, "AGENTS.md"), "outer\n@./shared.md\n");
  const config = loadConfig({
    workspaceRoot: root,
    context: { instructionGraph: true, instructionImports: false },
  });
  const { text, graph } = resolveInstructions(config);
  assert.doesNotMatch(text, /IMPORTED-BODY/);
  assert.equal(graph!.sources.filter((s) => s.kind === "import").length, 0);
});
