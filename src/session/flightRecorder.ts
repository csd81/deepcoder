/**
 * Per-turn Flight Recorder.
 *
 * Snapshots the EXACT `ChatRequest` sent to the model on each call — including
 * the ephemeral context (todos, JIT path-local instructions, delegation hint)
 * that `withEphemeralContext()` injects but never persists to the session
 * transcript. Without this, a resumed/reconstructed session cannot reproduce
 * what the model actually saw, so "why did it do that on call N?" is unanswerable
 * from the transcript alone.
 *
 * Storage lives under `.deepcoder/flight/<sessionId>/` — already unreadable by
 * tools/grep via the sensitive-path guard (`workspace/sensitive.ts`), so the
 * agent can never read its own flight logs (no self-injection loop) and they
 * never leak into git.
 *
 * Content is content-addressed: each message body / tool-calls JSON / tools
 * schema is redacted, hashed (sha256), and written once to a blob store. A
 * per-call manifest references blobs by hash. This keeps disk LINEAR — every
 * turn re-sends the whole history, so naive full-copies-per-call would be
 * quadratic. Secrets are ALWAYS redacted before hashing (there is no mode that
 * writes raw keys to disk).
 */

import { promises as fs } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { assertSafeId, resolveRealPathInWorkspace } from "../workspace/paths.js";
import { redactSecrets } from "../workspace/redact.js";
import type { AgentMessage, ChatRequest, ToolSchema } from "../providers/types.js";

/** Default cap on retained call manifests per session (oldest evicted). */
export const DEFAULT_MAX_FLIGHT_CALLS = 200;

const MANIFEST_VERSION = 1;

/** One message entry in a call manifest — content stored by hash, not inline. */
interface FlightMessageRef {
  role: AgentMessage["role"];
  name?: string;
  toolCallId?: string;
  /** sha256 of the redacted `content` string. */
  contentHash: string;
  /** byte length of the redacted content (for quick inspection). */
  len: number;
  /** sha256 of the redacted JSON of `toolCalls`, when present. */
  toolCallsHash?: string;
}

/** Persisted per-call manifest. */
export interface FlightManifest {
  version: number;
  callIndex: number;
  model: string;
  /** ISO timestamp of the call. */
  timestamp: string;
  /** sha256 of the redacted JSON of the tool-schema array. */
  toolsHash: string;
  messages: FlightMessageRef[];
}

function flightDir(workspaceRoot: string, sessionId: string): string {
  return path.join(workspaceRoot, ".deepcoder", "flight", sessionId);
}

function blobsDir(workspaceRoot: string, sessionId: string): string {
  return path.join(flightDir(workspaceRoot, sessionId), "blobs");
}

function manifestName(callIndex: number): string {
  return `call_${String(callIndex).padStart(4, "0")}.json`;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, data, "utf8");
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Confine a flight path to `.deepcoder/flight/<sid>/` (defeats symlink-swap and
 * lexical escape), mirroring the managed-outputs guard.
 */
function confine(workspaceRoot: string, sessionId: string, abs: string): string {
  const base = path.resolve(flightDir(workspaceRoot, sessionId));
  const rel = path.relative(workspaceRoot, abs);
  const real = resolveRealPathInWorkspace(workspaceRoot, rel);
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error("flight path escapes the session flight directory");
  }
  return real;
}

/**
 * Records each model call to disk. One instance per active session; `recordCall`
 * is invoked from `getResponse()` via the `AgentDeps.onModelCall` seam and is
 * awaited sequentially (the agent loop is single-flight per session), so no
 * intra-session write races.
 */
export class FlightRecorder {
  private callIndex = 0;
  private readonly maxCalls: number;
  private readonly log?: (msg: string) => void;

  constructor(
    private readonly workspaceRoot: string,
    private readonly sessionId: string,
    opts?: { maxCalls?: number; log?: (msg: string) => void },
  ) {
    assertSafeId(sessionId);
    this.maxCalls = opts?.maxCalls ?? DEFAULT_MAX_FLIGHT_CALLS;
    this.log = opts?.log;
  }

  /** Snapshot one compiled `ChatRequest`. Returns the call index written. */
  async recordCall(req: ChatRequest): Promise<number> {
    const idx = this.callIndex++;
    const blobs = blobsDir(this.workspaceRoot, this.sessionId);
    await fs.mkdir(blobs, { recursive: true });

    const writeBlob = async (raw: string): Promise<string> => {
      const redacted = redactSecrets(raw);
      const hash = sha256(redacted);
      const file = confine(this.workspaceRoot, this.sessionId, path.join(blobs, hash));
      // Skip if already present — identical content across calls dedups to one blob.
      try {
        await fs.access(file);
      } catch {
        await atomicWrite(file, redacted);
      }
      return hash;
    };

    const toolsHash = await writeBlob(JSON.stringify(req.tools ?? []));
    const messages: FlightMessageRef[] = [];
    for (const m of req.messages) {
      const redactedContent = redactSecrets(m.content ?? "");
      const contentHash = await writeBlob(m.content ?? "");
      const ref: FlightMessageRef = { role: m.role, contentHash, len: redactedContent.length };
      if (m.name) ref.name = m.name;
      if (m.toolCallId) ref.toolCallId = m.toolCallId;
      if (m.toolCalls?.length) ref.toolCallsHash = await writeBlob(JSON.stringify(m.toolCalls));
      messages.push(ref);
    }

    const manifest: FlightManifest = {
      version: MANIFEST_VERSION,
      callIndex: idx,
      model: req.model,
      timestamp: new Date().toISOString(),
      toolsHash,
      messages,
    };
    const file = confine(
      this.workspaceRoot,
      this.sessionId,
      path.join(flightDir(this.workspaceRoot, this.sessionId), manifestName(idx)),
    );
    await atomicWrite(file, JSON.stringify(manifest, null, 2));

    await this.evict();
    return idx;
  }

  /** Drop oldest manifests beyond `maxCalls`, then GC unreferenced blobs. */
  private async evict(): Promise<void> {
    const dir = flightDir(this.workspaceRoot, this.sessionId);
    const indices = (await listCallIndices(dir)).sort((a, b) => a - b);
    if (indices.length <= this.maxCalls) return;
    const drop = indices.slice(0, indices.length - this.maxCalls);
    for (const i of drop) {
      await fs.rm(path.join(dir, manifestName(i)), { force: true }).catch(() => {});
    }
    this.log?.(`flight recorder: evicted ${drop.length} oldest call(s) (cap ${this.maxCalls}).`);
    await gcBlobs(this.workspaceRoot, this.sessionId);
  }
}

/** List the numeric call indices present in a flight directory. */
async function listCallIndices(dir: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const e of entries) {
    const m = /^call_(\d+)\.json$/.exec(e);
    if (m) out.push(Number(m[1]));
  }
  return out;
}

/** Remove blobs not referenced by any remaining manifest. */
async function gcBlobs(workspaceRoot: string, sessionId: string): Promise<void> {
  const dir = flightDir(workspaceRoot, sessionId);
  const indices = await listCallIndices(dir);
  const referenced = new Set<string>();
  for (const i of indices) {
    const man = await readManifest(workspaceRoot, sessionId, i).catch(() => null);
    if (!man) continue;
    referenced.add(man.toolsHash);
    for (const msg of man.messages) {
      referenced.add(msg.contentHash);
      if (msg.toolCallsHash) referenced.add(msg.toolCallsHash);
    }
  }
  const blobs = blobsDir(workspaceRoot, sessionId);
  let names: string[];
  try {
    names = await fs.readdir(blobs);
  } catch {
    return;
  }
  for (const name of names) {
    if (!referenced.has(name)) await fs.rm(path.join(blobs, name), { force: true }).catch(() => {});
  }
}

async function readBlob(workspaceRoot: string, sessionId: string, hash: string): Promise<string> {
  assertSafeId(hash); // hex sha256 — also rejects path separators / traversal
  const file = confine(workspaceRoot, sessionId, path.join(blobsDir(workspaceRoot, sessionId), hash));
  return fs.readFile(file, "utf8");
}

async function readManifest(
  workspaceRoot: string,
  sessionId: string,
  callIndex: number,
): Promise<FlightManifest> {
  assertSafeId(sessionId);
  const file = confine(
    workspaceRoot,
    sessionId,
    path.join(flightDir(workspaceRoot, sessionId), manifestName(callIndex)),
  );
  return JSON.parse(await fs.readFile(file, "utf8")) as FlightManifest;
}

/** Sorted list of recorded call indices for a session (for `flight list`). */
export async function listFlightCalls(workspaceRoot: string, sessionId: string): Promise<number[]> {
  assertSafeId(sessionId);
  return (await listCallIndices(flightDir(workspaceRoot, sessionId))).sort((a, b) => a - b);
}

/**
 * Reconstitute the exact (redacted) `ChatRequest` that was sent on `callIndex`.
 * Used by `flight replay` and by tests — NOT from the session transcript, which
 * omits the ephemeral injections this recorder exists to capture.
 */
export async function reconstituteCall(
  workspaceRoot: string,
  sessionId: string,
  callIndex: number,
): Promise<ChatRequest> {
  const man = await readManifest(workspaceRoot, sessionId, callIndex);
  const tools = JSON.parse(await readBlob(workspaceRoot, sessionId, man.toolsHash)) as ToolSchema[];
  const messages: AgentMessage[] = [];
  for (const ref of man.messages) {
    const content = await readBlob(workspaceRoot, sessionId, ref.contentHash);
    const msg: AgentMessage = { role: ref.role, content };
    if (ref.name) msg.name = ref.name;
    if (ref.toolCallId) msg.toolCallId = ref.toolCallId;
    if (ref.toolCallsHash) {
      msg.toolCalls = JSON.parse(await readBlob(workspaceRoot, sessionId, ref.toolCallsHash));
    }
    messages.push(msg);
  }
  return { messages, tools, model: man.model };
}
