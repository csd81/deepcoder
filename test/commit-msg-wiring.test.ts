import { test } from "node:test";
import assert from "node:assert/strict";
import { isGitCommand } from "../src/cli/gitSlashCommands.js";
import { SLASH_CATALOG, filterSlashCommands } from "../src/cli/slashCatalog.js";

test("/commit-msg is routed to the git dispatcher", () => {
  assert.ok(isGitCommand("commit-msg"), "handleGit must claim commit-msg");
});

test("/commit-msg appears in the slash catalog under git", () => {
  const entry = SLASH_CATALOG.find((c) => c.name === "commit-msg");
  assert.ok(entry, "commit-msg must be in the catalog");
  assert.equal(entry!.category, "git");
});

test("/commit-msg is discoverable via prefix completion (commit → commit, commit-msg)", () => {
  const names = filterSlashCommands(SLASH_CATALOG, "commit").map((c) => c.name);
  assert.ok(names.includes("commit"));
  assert.ok(names.includes("commit-msg"));
});

test("/document is registered in the catalog", () => {
  const entry = SLASH_CATALOG.find((c) => c.name === "document");
  assert.ok(entry, "document must be in the catalog");
  assert.equal(entry!.category, "context");
});
