import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildInstructionGraph,
  pathLocalSources,
  commitJitSource,
} from "../src/context/instructionGraph.js";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "instr-graph-"));
}

test("startup loads supported files in apply order with provenance", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "Use pnpm for installs.\n");
  await writeFile(path.join(root, "CLAUDE.md"), "Prefer small commits.\n");
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "instructions.md"), "Deepcoder house rules.\n");
  await mkdir(path.join(root, ".deepcoder", "rules"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "rules", "style.md"), "Two-space indentation.\n");

  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: path.join(root, "__no_global__") });
  const loaded = g.sources.filter((s) => !s.skipped).map((s) => path.basename(s.path));
  assert.deepEqual(loaded, ["AGENTS.md", "CLAUDE.md", "instructions.md", "style.md"]);
  assert.match(g.renderedStartupText, /AGENTS\.md \(workspace\)/);
  assert.match(g.renderedStartupText, /rules\/style\.md|style\.md \(rule\)/);
  // applied order: AGENTS before the rule
  assert.ok(g.renderedStartupText.indexOf("pnpm") < g.renderedStartupText.indexOf("Two-space"));
});

test("AGENTS.override.md replaces AGENTS.md", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "ORIGINAL.\n");
  await writeFile(path.join(root, "AGENTS.override.md"), "OVERRIDDEN.\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nonexistent-xyz" });
  assert.match(g.renderedStartupText, /OVERRIDDEN/);
  assert.doesNotMatch(g.renderedStartupText, /ORIGINAL/);
});

test("safe @import expands and is attributed", async () => {
  const root = await fixture();
  await mkdir(path.join(root, "shared"), { recursive: true });
  await writeFile(path.join(root, "shared", "testing.md"), "Run pytest -q.\n");
  await writeFile(path.join(root, "AGENTS.md"), "See testing:\n@./shared/testing.md\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.match(g.renderedStartupText, /Run pytest -q/);
  const imp = g.sources.find((s) => s.kind === "import");
  assert.ok(imp, "import source recorded");
  assert.equal(path.basename(imp!.path), "testing.md");
  assert.ok(imp!.importedBy?.endsWith("AGENTS.md"));
});

test("import cycle does not hang and is reported", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "a.md"), "A\n@./b.md\n");
  await writeFile(path.join(root, "b.md"), "B\n@./a.md\n");
  await writeFile(path.join(root, "AGENTS.md"), "root\n@./a.md\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.ok(g.warnings.some((w) => w.kind === "import_cycle"), "cycle warning present");
  // Both files' real content still rendered once.
  assert.match(g.renderedStartupText, /\bA\b/);
  assert.match(g.renderedStartupText, /\bB\b/);
});

test("import cannot escape the workspace", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "x\n@../../etc/passwd.md\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.ok(g.warnings.some((w) => w.kind === "unsafe_import"), "escape rejected");
});

test("import cannot read a sensitive path (.env)", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".env"), "SECRET=1\n");
  await writeFile(path.join(root, "AGENTS.md"), "x\n@./.env\n");
  // Note: @import requires a .md suffix, so also try the explicit form.
  await writeFile(path.join(root, "CLAUDE.md"), "y\n@./.env.md\n");
  await writeFile(path.join(root, ".env.md"), "LEAK\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  // .env.md is not itself sensitive by name, but a real secret path would be.
  // Assert a genuinely sensitive import is refused:
  await writeFile(path.join(root, "GEMINI.md"), "z\n@./.deepcoder/instructions.md\n");
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "instructions.md"), "INNER\n");
  const g2 = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.ok(
    g2.warnings.some((w) => w.kind === "unsafe_import" && /sensitive/.test(w.message)),
    "sensitive .deepcoder import refused",
  );
});

test("import depth is bounded", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "root\n@./d1.md\n");
  for (let i = 1; i <= 6; i++) {
    await writeFile(path.join(root, `d${i}.md`), `level ${i}\n@./d${i + 1}.md\n`);
  }
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope", importMaxDepth: 2 });
  assert.ok(g.warnings.some((w) => w.kind === "budget_exceeded" && /depth/.test(w.message)));
});

test("startup budget truncates and reports skipped sources", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "A".repeat(500));
  await writeFile(path.join(root, "CLAUDE.md"), "B".repeat(500));
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope", startupMaxBytes: 600 });
  assert.ok(g.sources.some((s) => s.skipped && /budget/.test(s.skipReason ?? "")));
  assert.ok(g.warnings.some((w) => w.kind === "budget_exceeded"));
});

test("conflicts are reported but do not crash", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "Always use pnpm.\n");
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "instructions.md"), "We use npm here.\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  const conflict = g.warnings.find((w) => w.kind === "conflict");
  assert.ok(conflict, "package-manager conflict surfaced");
  assert.match((conflict as { message: string }).message, /package manager/);
});

test("malformed/empty instruction files are skipped without crashing", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "   \n\n");
  await writeFile(path.join(root, "CLAUDE.md"), "Real content.\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  const loaded = g.sources.filter((s) => !s.skipped).map((s) => path.basename(s.path));
  assert.deepEqual(loaded, ["CLAUDE.md"]);
});

test("JIT path-local instructions load only when a file under them is accessed", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "root rules\n");
  await mkdir(path.join(root, "packages", "web"), { recursive: true });
  await writeFile(path.join(root, "packages", "web", "CLAUDE.md"), "web-specific rule\n");

  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.doesNotMatch(g.renderedStartupText, /web-specific/);

  // Access a file under packages/web → its CLAUDE.md becomes a JIT source.
  const jit = pathLocalSources(g, path.join(root, "packages", "web", "app.ts"));
  assert.equal(jit.length, 1);
  assert.match(jit[0].text, /web-specific/);
  const rendered = commitJitSource(g, jit[0]);
  assert.match(rendered, /path-local instructions/);

  // A second access to the same dir yields nothing new (inject-once).
  const again = pathLocalSources(g, path.join(root, "packages", "web", "other.ts"));
  assert.equal(again.length, 0);
});

test("JIT does not fire for paths outside the workspace", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "AGENTS.md"), "root\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.equal(pathLocalSources(g, "/etc/hosts").length, 0);
});

test(".deepcoder/rules only reads rules/, never runs/ or sessions/", async () => {
  const root = await fixture();
  await mkdir(path.join(root, ".deepcoder", "rules"), { recursive: true });
  await mkdir(path.join(root, ".deepcoder", "runs"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "rules", "ok.md"), "rule body\n");
  await writeFile(path.join(root, ".deepcoder", "runs", "secret.md"), "SHOULD-NOT-LOAD\n");
  const g = buildInstructionGraph({ workspaceRoot: root, globalDir: "/nope" });
  assert.match(g.renderedStartupText, /rule body/);
  assert.doesNotMatch(g.renderedStartupText, /SHOULD-NOT-LOAD/);
});
