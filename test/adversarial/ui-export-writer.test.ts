/**
 * Phase 10A.12 — Adversarial tests for the export writer.
 *
 * Covers:
 * - safeExportFilename: sanitisation, timestamp format, optional id.
 * - writeExport: creates directory, writes file, returns relative path,
 *   rejects traversal, only writes inside workspace boundary.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  safeExportFilename,
  writeExport,
} from "../../src/ui/exportWriter.js";

// ── safeExportFilename ────────────────────────────────────────────────────────

test("[export-filename] generates correct pattern with timestamp and prefix", () => {
  const now = new Date("2026-06-22T10:30:00.000Z");
  const name = safeExportFilename("tool", now);
  assert.match(name, /^2026-06-22T10-30-00-000Z-tool\.md$/);
});

test("[export-filename] includes optional id segment", () => {
  const now = new Date("2026-06-22T10:30:00.000Z");
  const name = safeExportFilename("tool", now, "b42");
  assert.match(name, /^2026-06-22T10-30-00-000Z-tool-b42\.md$/);
});

test("[export-filename] sanitises unsafe characters in prefix", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const name = safeExportFilename("../evil/path!", now);
  assert.doesNotMatch(name, /\//);
  assert.doesNotMatch(name, /!/);
  // Should contain only [a-zA-Z0-9._-] and end in .md
  assert.match(name, /^[a-zA-Z0-9._-]+\.md$/);
});

test("[export-filename] sanitises unsafe characters in id", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const name = safeExportFilename("block", now, "../traverse");
  assert.doesNotMatch(name, /\//);
  assert.match(name, /^[a-zA-Z0-9._-]+\.md$/);
});

test("[export-filename] handles empty prefix gracefully (fallback)", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  const name = safeExportFilename("!!!", now, "b1");
  assert.match(name, /^[a-zA-Z0-9._-]+\.md$/);
  assert.match(name, /export/);
});

test("[export-filename] colons in timestamp are replaced with dashes", () => {
  const now = new Date("2026-06-22T10:30:00.000Z");
  const name = safeExportFilename("test", now);
  assert.doesNotMatch(name, /:/);
});

// ── writeExport ───────────────────────────────────────────────────────────────

test("[export-write] creates .deepcoder/exports dir and writes a file", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    const filename = safeExportFilename("tool", new Date(), "b1");
    const relative = await writeExport(tmp, filename, "# Hello");

    // Returns relative path
    assert.match(relative, /^\.deepcoder\/exports\//);

    // File was written
    const fullPath = join(tmp, ".deepcoder", "exports", filename);
    assert.equal(existsSync(fullPath), true);
    assert.equal(readFileSync(fullPath, "utf8"), "# Hello");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("[export-write] creates intermediate directories if missing", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    const filename = "2026-01-01T00-00-00-000Z-test.md";
    const relative = await writeExport(tmp, filename, "content");
    assert.match(relative, /^\.deepcoder\/exports\//);
    assert.equal(readFileSync(join(tmp, ".deepcoder", "exports", filename), "utf8"), "content");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("[export-write] returns relative path for notices", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    const filename = "2026-01-01T00-00-00-000Z-test.md";
    const relative = await writeExport(tmp, filename, "data");
    assert.equal(relative, ".deepcoder/exports/2026-01-01T00-00-00-000Z-test.md");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("[export-write] rejects filename with path separators", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    await assert.rejects(
      () => writeExport(tmp, "../escape.md", "content"),
      { message: /Invalid filename/ },
    );
    // No directory should have been created
    assert.equal(existsSync(join(tmp, ".deepcoder")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("[export-write] rejects filename with backslash path separators", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "export-test-"));
  try {
    await assert.rejects(
      () => writeExport(tmp, "..\\escape.md", "content"),
      { message: /Invalid filename/ },
    );
    assert.equal(existsSync(join(tmp, ".deepcoder")), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
