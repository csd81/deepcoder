/**
 * Instruction-file loading must not become an arbitrary-file-read primitive.
 * A repo can commit `AGENTS.md -> ~/.ssh/id_ed25519` (or -> ./.env) or a huge
 * file; loadInstructions must refuse symlinks that escape the workspace, point
 * at sensitive files, or are oversized.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadInstructions } from "../../src/context/projectInstructions.js";

async function ws(prefix = "instr-"): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("a symlink instruction file pointing OUTSIDE the workspace is ignored", async () => {
  const root = await ws();
  const outside = await ws("outside-");
  try {
    await writeFile(path.join(outside, "secret"), "SECRET-OUTSIDE-WORKSPACE", "utf8");
    await symlink(path.join(outside, "secret"), path.join(root, "AGENTS.md"));
    const { source, text } = loadInstructions(root);
    assert.equal(source, null, "must not read a symlink escaping the workspace");
    assert.ok(!text.includes("SECRET-OUTSIDE-WORKSPACE"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlink instruction file pointing at an in-workspace sensitive file (.env) is ignored", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, ".env"), "API_KEY=supersecret", "utf8");
    await symlink(path.join(root, ".env"), path.join(root, "AGENTS.md"));
    const { text } = loadInstructions(root);
    assert.ok(!text.includes("supersecret"), "must not surface a symlinked .env");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized instruction file is skipped (startup-DoS / huge-special-file guard)", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "AGENTS.md"), "x".repeat(300 * 1024), "utf8"); // > 256 KB
    const { source } = loadInstructions(root);
    assert.equal(source, null, "oversized instruction file must be skipped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a normal in-workspace instruction file is still loaded", async () => {
  const root = await ws();
  try {
    await writeFile(path.join(root, "AGENTS.md"), "be terse and cite sources", "utf8");
    const { source, text } = loadInstructions(root);
    assert.equal(source, "AGENTS.md");
    assert.equal(text, "be terse and cite sources");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the legitimate .deepcoder/instructions.md (sensitive by name) still loads (no over-block)", async () => {
  const root = await ws();
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, ".deepcoder"), { recursive: true });
    await writeFile(path.join(root, ".deepcoder", "instructions.md"), "house rules", "utf8");
    const { source, text } = loadInstructions(root);
    assert.equal(source, ".deepcoder/instructions.md");
    assert.equal(text, "house rules");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
