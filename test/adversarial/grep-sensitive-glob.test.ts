import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grepTool } from "../../src/tools/grep.js";
import type { ToolContext } from "../../src/tools/types.js";

function ctx(root: string): ToolContext {
  return { workspaceRoot: root, signal: new AbortController().signal, readTracker: new Set(), todos: [] };
}

// A user/model-supplied glob must NOT be able to re-include a sensitive file
// (e.g. .env) that the sensitive excludes are meant to keep out of the search.
// ripgrep applies "last glob wins", so a glob pushed after the `!`-excludes
// could otherwise resurrect the secret.
test("grep: a user glob cannot re-include .env past the sensitive excludes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grep-leak-"));
  try {
    await writeFile(path.join(root, ".env"), "API_KEY=SUPER_SECRET_VALUE_xyz\n", "utf8");
    await writeFile(path.join(root, "app.js"), "const k = process.env.API_KEY;\n", "utf8");

    for (const glob of [".env", "*.env", "**/.env", ".*"]) {
      const res = await grepTool
        .build({ pattern: "SUPER_SECRET_VALUE_xyz", path: ".", glob })
        .execute(ctx(root));
      assert.doesNotMatch(
        res.output,
        /SUPER_SECRET_VALUE_xyz/,
        `glob "${glob}" leaked .env contents into grep output`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
