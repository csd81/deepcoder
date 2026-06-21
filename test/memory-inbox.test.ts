/**
 * Phase 8B (auto-memory) — the inbox: stage candidate learnings for human
 * approval. Candidates live in inbox.json and are NEVER recalled into the
 * prompt (loadStartupMemory reads only MEMORY.md) until explicitly accepted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  proposeMemory,
  loadInbox,
  acceptMemory,
  rejectMemory,
  loadStartupMemory,
  remember,
} from "../src/memory/store.js";
import { handleSlashCommand } from "../src/cli/slashCommands.js";
import type { Session } from "../src/cli/repl.js";

process.env.DEEPCODER_API_KEY ??= "sk-FIXTURE-DONOTLEAK";

async function ws(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "mem-inbox-"));
}

test("proposeMemory stages a candidate that is NOT recalled into the prompt", async () => {
  const root = await ws();
  try {
    const res = await proposeMemory(root, "The test command is `npm run test:phase`.", "solve");
    assert.equal(res.ok, true);
    assert.ok(res.id);
    const inbox = await loadInbox(root);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.source, "solve");
    // Critical safety property: a staged candidate never reaches startup memory.
    const recalled = await loadStartupMemory(root);
    assert.ok(!recalled.includes("npm run test:phase"), "inbox must not be recalled before acceptance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposeMemory dedupes by content and refuses secrets", async () => {
  const root = await ws();
  try {
    await proposeMemory(root, "duplicate fact");
    const dup = await proposeMemory(root, "duplicate fact");
    assert.equal(dup.ok, false);
    assert.match(dup.reason ?? "", /already|stag/i);
    const secret = await proposeMemory(root, "api key sk-ABCDEFGHIJKLMNOP1234567890");
    assert.equal(secret.ok, false);
    assert.match(secret.reason ?? "", /secret/i);
    assert.equal((await loadInbox(root)).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("proposeMemory skips a fact already in MEMORY.md", async () => {
  const root = await ws();
  try {
    await remember(root, "already known fact");
    const res = await proposeMemory(root, "already known fact");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /remember|known|exist/i);
    assert.equal((await loadInbox(root)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("acceptMemory promotes a candidate into MEMORY.md and clears it from the inbox", async () => {
  const root = await ws();
  try {
    const { id } = await proposeMemory(root, "accept me into memory");
    const res = await acceptMemory(root, id!);
    assert.equal(res.ok, true);
    assert.equal((await loadInbox(root)).length, 0, "accepted item leaves the inbox");
    const recalled = await loadStartupMemory(root);
    assert.ok(recalled.includes("accept me into memory"), "accepted item is now recalled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("/memory accept <n> promotes the nth inbox candidate by 1-based index", async () => {
  const root = await ws();
  try {
    await proposeMemory(root, "fact one", "solve");
    await proposeMemory(root, "fact two", "solve");
    const session = { config: { workspaceRoot: root } } as unknown as Session;
    await handleSlashCommand("/memory accept 2", session, async () => {});
    const inbox = await loadInbox(root);
    assert.equal(inbox.length, 1, "the accepted item left the inbox");
    assert.equal(inbox[0]!.text, "fact one", "index 2 (fact two) was the one accepted");
    assert.ok((await loadStartupMemory(root)).includes("fact two"), "fact two is now in MEMORY.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejectMemory drops a candidate without writing it to MEMORY.md", async () => {
  const root = await ws();
  try {
    const { id } = await proposeMemory(root, "reject me");
    assert.equal(await rejectMemory(root, id!), true);
    assert.equal((await loadInbox(root)).length, 0);
    const recalled = await loadStartupMemory(root);
    assert.ok(!recalled.includes("reject me"), "rejected item is never remembered");
    assert.equal(await rejectMemory(root, "nope"), false, "rejecting an unknown id returns false");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
