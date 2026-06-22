/**
 * Tests for format-on-edit: shouldFormat, formatFile, and config parsing.
 *
 * TDD: these tests should fail on baseline (no implementation) and pass once the
 * feature is wired in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shouldFormat, formatFile } from "../src/tools/formatOnEdit.js";
import { loadFileConfig } from "../src/config/fileConfig.js";
import { loadConfig } from "../src/config/config.js";

// ─── shouldFormat ──────────────────────────────────────────────────────────

test("shouldFormat matches **/*.ts glob", () => {
  const result = shouldFormat("src/foo.ts", { command: "prettier", match: ["**/*.ts"] });
  assert.equal(result, true);
});

test("shouldFormat rejects non-matching glob", () => {
  const result = shouldFormat("src/foo.js", { command: "prettier", match: ["**/*.ts"] });
  assert.equal(result, false);
});

test("shouldFormat defaults to **/* when no match configured", () => {
  const result = shouldFormat("src/foo.ts", { command: "prettier" });
  assert.equal(result, true);
});

test("shouldFormat defaults to **/* for any file when no match configured", () => {
  const result = shouldFormat("Makefile", { command: "prettier" });
  assert.equal(result, true);
});

test("shouldFormat returns false for empty patterns list", () => {
  // An empty match array means no file is matched.
  const result = shouldFormat("src/foo.ts", { command: "prettier", match: [] });
  assert.equal(result, false);
});

// ─── formatFile (classifier gate) ───────────────────────────────────────────

test("formatFile denies a dangerous command via classifier", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deepcoder-format-deny-"));
  try {
    const result = await formatFile("evil.txt", {
      command: "rm -rf /", // known-deny command
    }, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    assert.equal(result.formatted, false);
    assert.ok(result.error?.includes("denied"), `expected denial, got: ${result.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── formatFile (exit codes) ───────────────────────────────────────────────

test("formatFile with exit 0 returns formatted: true", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deepcoder-format-ok-"));
  try {
    await writeFile(path.join(dir, "test.txt"), "hello", "utf8");
    const result = await formatFile("test.txt", {
      command: "true", // always exits 0
    }, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    assert.equal(result.formatted, true);
    assert.equal(result.error, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formatFile with exit 1 returns formatted: false + error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deepcoder-format-fail-"));
  try {
    await writeFile(path.join(dir, "test.txt"), "hello", "utf8");
    const result = await formatFile("test.txt", {
      command: "false", // always exits 1
    }, {
      workspaceRoot: dir,
      signal: new AbortController().signal,
    });
    assert.equal(result.formatted, false);
    assert.ok(result.error?.includes("exit 1"), `expected exit 1, got: ${result.error}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── Config parsing ────────────────────────────────────────────────────────

test("config parsing: valid format config is loaded", () => {
  // Write a temporary .deepcoder/config.json with format config and load it.
  const dir = testDir();
  writeFileSync(
    path.join(dir, ".deepcoder", "config.json"),
    JSON.stringify({ format: { command: "prettier --write", match: ["**/*.ts"] } }),
    "utf8",
  );
  const cfg = loadFileConfig(dir);
  assert.ok(cfg.format !== undefined, "format config should be present");
  assert.equal(cfg.format!.command, "prettier --write");
  assert.deepEqual(cfg.format!.match, ["**/*.ts"]);
});

test("config parsing: absent format key produces format: null in final config", () => {
  // No format key in the file.
  const dir = testDirNoConfig();
  const cfg = loadFileConfig(dir);
  assert.equal(cfg.format, undefined);
  // loadConfig should resolve it to null.
  const full = loadConfig({ workspaceRoot: dir });
  assert.equal(full.format, null);
});

test("config parsing: empty command is rejected by zod", () => {
  const dir = testDir();
  writeFileSync(
    path.join(dir, ".deepcoder", "config.json"),
    JSON.stringify({ format: { command: "" } }),
    "utf8",
  );
  const cfg = loadFileConfig(dir);
  // Empty command should be warned about and format should remain undefined.
  assert.equal(cfg.format, undefined);
});

test("config parsing: format with only command works (defaults applied)", () => {
  const dir = testDir();
  writeFileSync(
    path.join(dir, ".deepcoder", "config.json"),
    JSON.stringify({ format: { command: "prettier --write" } }),
    "utf8",
  );
  const cfg = loadFileConfig(dir);
  assert.ok(cfg.format !== undefined);
  assert.equal(cfg.format!.command, "prettier --write");
  assert.equal(cfg.format!.match, undefined); // defaults applied at runtime
});

// ─── Helpers ───────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from "node:fs";

let tmpCounter = 0;

function testDir(): string {
  const dir = path.join(tmpdir(), `deepcoder-format-config-${++tmpCounter}-${Date.now()}`);
  mkdirSync(path.join(dir, ".deepcoder"), { recursive: true });
  return dir;
}

function testDirNoConfig(): string {
  const dir = path.join(tmpdir(), `deepcoder-format-no-config-${++tmpCounter}-${Date.now()}`);
  mkdirSync(path.join(dir, ".deepcoder"), { recursive: true });
  // No config.json written.
  return dir;
}
