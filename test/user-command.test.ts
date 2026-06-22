import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFileConfig } from "../src/config/fileConfig.js";
import { runUserCommand } from "../src/cli/runUserCommand.js";

// Red-seed anchor (do NOT weaken). Config parse is the pure-ish core; runUserCommand
// is the dispatch entrypoint. Offline (real fs temp dir), no model.

async function ws(cfg: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ucmd-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(path.join(root, ".deepcoder", "config.json"), JSON.stringify(cfg));
  return root;
}

test("loadFileConfig parses a valid commands block", async () => {
  const root = await ws({ commands: { lint: { command: "npm run lint" } } });
  try {
    const fc = loadFileConfig(root);
    assert.equal(fc.commands?.lint?.command, "npm run lint");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a reserved built-in name (help) is not accepted as a user command", async () => {
  const root = await ws({ commands: { help: { command: "echo nope" } } });
  try {
    const fc = loadFileConfig(root);
    assert.ok(!fc.commands || fc.commands.help === undefined, "reserved name 'help' must be dropped");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("no commands key → commands is absent/empty", async () => {
  const root = await ws({});
  try {
    const fc = loadFileConfig(root);
    assert.ok(!fc.commands || Object.keys(fc.commands).length === 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("runUserCommand is exported as the dispatch entrypoint", () => {
  assert.equal(typeof runUserCommand, "function");
});
