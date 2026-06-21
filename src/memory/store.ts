// Inspectable local memory (Phase 8B) — plain-markdown, local-first, reviewable.
// `.deepcoder/memory/MEMORY.md` is a concise startup index injected into the
// system prompt; topic files are read on demand. Memory is NOT policy: it never
// bypasses permissions/hooks/checks. This is the 8B core slice (store + manual
// remember/forget + startup load); auto-memory + inbox are deferred.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { redactSecrets } from "../workspace/redact.js";

const DEFAULT_STARTUP_MAX_BYTES = 25_600;

function memoryDir(root: string): string {
  return path.join(root, ".deepcoder", "memory");
}
function indexFile(root: string): string {
  return path.join(memoryDir(root), "MEMORY.md");
}

/** Read the startup memory index (bounded). Returns "" when none exists. */
export async function loadStartupMemory(root: string, maxBytes: number = DEFAULT_STARTUP_MAX_BYTES): Promise<string> {
  try {
    const text = await readFile(indexFile(root), "utf8");
    return text.length > maxBytes ? text.slice(0, maxBytes) + "\n…(memory truncated)" : text;
  } catch {
    return "";
  }
}

/** Topic files under the memory dir (excluding the MEMORY.md index), sorted. */
export async function listTopics(root: string): Promise<string[]> {
  try {
    return (await readdir(memoryDir(root)))
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
      .sort();
  } catch {
    return [];
  }
}

export interface RememberResult {
  ok: boolean;
  reason?: string;
  file?: string;
}

/**
 * Append a dated bullet to MEMORY.md (or a topic file). Refuses content that
 * looks like a secret (redaction would change it) rather than storing it.
 */
export async function remember(root: string, fact: string, opts: { topic?: string } = {}): Promise<RememberResult> {
  const text = fact.trim();
  if (!text) return { ok: false, reason: "empty fact" };
  if (redactSecrets(text) !== text) return { ok: false, reason: "looks like a secret; not stored" };

  const isTopic = !!opts.topic;
  const file = isTopic ? path.join(memoryDir(root), sanitizeTopic(opts.topic!)) : indexFile(root);
  await mkdir(memoryDir(root), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    /* new file */
  }
  const header = existing ? "" : isTopic ? `# ${opts.topic}\n\n` : "# Deepcoder Memory\n\n";
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  const bullet = `- (${new Date().toISOString().slice(0, 10)}) ${text}\n`;
  await writeFile(file, existing + sep + header + bullet, "utf8");
  return { ok: true, file };
}

export interface MemoryMatch {
  file: string;
  text: string;
}

/**
 * Find memory bullet lines matching `pattern` (case-insensitive substring) and,
 * when `apply`, rewrite the files dropping those lines. Returns the matched
 * lines (for preview). Pattern that's an invalid regex is treated as a literal.
 */
export async function forget(
  root: string,
  pattern: string,
  opts: { apply: boolean },
): Promise<MemoryMatch[]> {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return [];
  const files = [indexFile(root), ...(await listTopics(root)).map((t) => path.join(memoryDir(root), t))];
  const matches: MemoryMatch[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      if (line.toLowerCase().includes(needle) && line.trim().startsWith("-")) {
        matches.push({ file, text: line });
      } else {
        kept.push(line);
      }
    }
    if (opts.apply && kept.length !== lines.length) {
      await writeFile(file, kept.join("\n"), "utf8");
    }
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/*  Auto-memory inbox (Phase 8B)                                       */
/* ------------------------------------------------------------------ */
//
// Candidate learnings are STAGED in `.deepcoder/memory/inbox.json` and are NEVER
// recalled into the prompt (loadStartupMemory reads only MEMORY.md). They enter
// memory only when a human accepts them — so auto-capture can never silently
// poison the agent's context.

const INBOX_FILE = "inbox.json";
function inboxFile(root: string): string {
  return path.join(memoryDir(root), INBOX_FILE);
}

export interface InboxItem {
  /** Stable content hash — also the dedup key. */
  id: string;
  text: string;
  /** Where the candidate came from (e.g. "solve"). */
  source: string;
  proposedAt: string;
}

/** Load staged candidates (never injected into the prompt). [] when none. */
export async function loadInbox(root: string): Promise<InboxItem[]> {
  try {
    const arr = JSON.parse(await readFile(inboxFile(root), "utf8")) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (x): x is InboxItem =>
        !!x && typeof (x as InboxItem).id === "string" && typeof (x as InboxItem).text === "string",
    );
  } catch {
    return [];
  }
}

async function writeInbox(root: string, items: InboxItem[]): Promise<void> {
  await mkdir(memoryDir(root), { recursive: true });
  await writeFile(inboxFile(root), JSON.stringify(items, null, 2), "utf8");
}

export interface ProposeResult {
  ok: boolean;
  reason?: string;
  id?: string;
}

/**
 * Stage a candidate learning for human review. Refuses secrets, dedupes by
 * content (same text → same id), and skips facts already in MEMORY.md. The
 * candidate is NOT recalled until accepted.
 */
export async function proposeMemory(root: string, fact: string, source = "auto"): Promise<ProposeResult> {
  const text = fact.trim();
  if (!text) return { ok: false, reason: "empty fact" };
  if (redactSecrets(text) !== text) return { ok: false, reason: "looks like a secret; not staged" };

  const id = createHash("sha256").update(text).digest("hex").slice(0, 8);
  const items = await loadInbox(root);
  if (items.some((i) => i.id === id)) return { ok: false, reason: "already staged" };
  // Don't re-propose something already accepted into the index.
  const mem = await loadStartupMemory(root, 1_000_000);
  if (mem.includes(text)) return { ok: false, reason: "already remembered" };

  items.push({ id, text, source, proposedAt: new Date().toISOString() });
  await writeInbox(root, items);
  return { ok: true, id };
}

/** Promote a staged candidate into MEMORY.md and remove it from the inbox. */
export async function acceptMemory(root: string, id: string): Promise<RememberResult> {
  const items = await loadInbox(root);
  const item = items.find((i) => i.id === id);
  if (!item) return { ok: false, reason: "no such inbox item" };
  const res = await remember(root, item.text);
  if (res.ok) await writeInbox(root, items.filter((i) => i.id !== id));
  return res;
}

/** Drop a staged candidate without remembering it. False if the id is unknown. */
export async function rejectMemory(root: string, id: string): Promise<boolean> {
  const items = await loadInbox(root);
  if (!items.some((i) => i.id === id)) return false;
  await writeInbox(root, items.filter((i) => i.id !== id));
  return true;
}

function sanitizeTopic(topic: string): string {
  const base = topic.replace(/\.md$/i, "").replace(/[^\w-]/g, "-").replace(/^-+|-+$/g, "") || "notes";
  return `${base}.md`;
}
