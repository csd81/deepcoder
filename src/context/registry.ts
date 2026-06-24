import { createHash } from "node:crypto";
import type { AgentMessage } from "../providers/types.js";
import type { ApprovalMode } from "../config/config.js";
import {
  renderApprovalModeLine,
  renderProjectInstructions,
  renderProjectMemory,
  renderSkillsCatalog,
} from "../agent/systemPrompt.js";

/**
 * Cache-Optimized Context Architecture (Context Registry).
 *
 * The baseline system prompt (`messages[0]`) is the immutable anchor of a
 * **context epoch**: it is built once at session start and NEVER mutated in
 * place, so the provider's automatic prefix cache stays valid across turns.
 * When a dynamic fact changes mid-conversation (approval mode, project
 * instructions, memory, skills), we do NOT rewrite `messages[0]`; instead we
 * append a single `[context-update]` system message at the tail. That keeps the
 * whole prefix cached while still telling the model the current state. A new
 * epoch begins only on session creation, resume, or compaction.
 *
 * This module owns: the snapshot/diff/render logic and the modular sources. It
 * deliberately does NOT import the REPL/session layer (no `systemMessage`) so it
 * stays free of cycles — rebuilding `messages[0]` for a new epoch is the
 * caller's job.
 */

/** The dynamic facts tracked per epoch. All are trusted, project-owned text. */
export interface ContextInputs {
  instructions: string;
  memory: string;
  skills: string;
  mode: ApprovalMode;
}

/**
 * A point-in-time view of the dynamic context. `epochId` identifies the epoch
 * (content-addressed from the baseline inputs) and is STABLE across
 * reconciliations within the epoch; `sources` holds the latest known serialized
 * value per source and is updated as `[context-update]`s are emitted.
 */
export interface ContextSnapshot {
  epochId: string;
  sources: Record<string, string>;
}

/** A modular, namespaced dynamic fact. */
export interface ContextSource {
  key: keyof ContextInputs & string;
  /** Short header shown above the block in a `[context-update]`. */
  label: string;
  /** Stable string used for hashing/diffing this source. */
  serialize(inputs: ContextInputs): string;
  /** The prompt block for this value; "" when empty (e.g. no memory file). */
  render(value: string): string;
}

export const CONTEXT_UPDATE_PREFIX = "[context-update]";

/** True for a mid-conversation context-update system message (stripped on epoch reset). */
export function isContextUpdateMessage(m: AgentMessage): boolean {
  return m.role === "system" && m.content.startsWith(CONTEXT_UPDATE_PREFIX);
}

/** Deterministic, content-addressed epoch id (no Date/random — resume-safe). */
function epochIdFor(sources: Record<string, string>): string {
  const canonical = JSON.stringify(Object.keys(sources).sort().map((k) => [k, sources[k]]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export class ContextRegistry {
  private sources: ContextSource[] = [];

  register(source: ContextSource): this {
    this.sources.push(source);
    return this;
  }

  keys(): string[] {
    return this.sources.map((s) => s.key);
  }

  /**
   * Build a snapshot from the current inputs. At an epoch boundary (create /
   * resume / compaction) pass no `epochId` to mint a fresh one; during
   * reconciliation pass the existing `epochId` to keep the epoch identity stable
   * while recording the new source values.
   */
  snapshot(inputs: ContextInputs, epochId?: string): ContextSnapshot {
    const sources: Record<string, string> = {};
    for (const s of this.sources) sources[s.key] = s.serialize(inputs);
    return { epochId: epochId ?? epochIdFor(sources), sources };
  }

  /** Keys whose serialized value differs between two snapshots. */
  diff(prev: ContextSnapshot, next: ContextSnapshot): string[] {
    return this.sources
      .map((s) => s.key)
      .filter((k) => (prev.sources[k] ?? "") !== (next.sources[k] ?? ""));
  }

  /**
   * Render a single unified `[context-update]` block for the changed keys. The
   * content is descriptive only — the permission model reads `session.mode`
   * (code), never this text, so a forged update can never escalate privilege.
   */
  renderUpdate(next: ContextSnapshot, changedKeys: string[]): string {
    const parts: string[] = [
      `${CONTEXT_UPDATE_PREFIX} Project context changed since the session baseline. ` +
        `The following supersede the corresponding baseline section:`,
    ];
    for (const src of this.sources) {
      if (!changedKeys.includes(src.key)) continue;
      const value = next.sources[src.key] ?? "";
      const rendered = src.render(value).trim();
      parts.push("", `### ${src.label}`, rendered || "(now empty)");
    }
    return parts.join("\n");
  }

  /** Join every non-empty source block (the dynamic portion of the baseline). */
  renderBaseline(snap: ContextSnapshot): string {
    return this.sources
      .map((s) => s.render(snap.sources[s.key] ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
  }
}

const INSTRUCTIONS_SOURCE: ContextSource = {
  key: "instructions",
  label: "Project instructions",
  serialize: (i) => i.instructions ?? "",
  render: (v) => renderProjectInstructions(v),
};

const MEMORY_SOURCE: ContextSource = {
  key: "memory",
  label: "Project memory",
  serialize: (i) => i.memory ?? "",
  render: (v) => renderProjectMemory(v),
};

const SKILLS_SOURCE: ContextSource = {
  key: "skills",
  label: "Available skills",
  serialize: (i) => i.skills ?? "",
  render: (v) => renderSkillsCatalog(v),
};

const MODE_SOURCE: ContextSource = {
  key: "mode",
  label: "Approval mode",
  serialize: (i) => i.mode,
  // mode is never empty; render the one-line policy statement.
  render: (v) => renderApprovalModeLine(v as ApprovalMode),
};

/** The default registry: the four trusted, project-owned dynamic sources. */
export function defaultContextRegistry(): ContextRegistry {
  return new ContextRegistry()
    .register(INSTRUCTIONS_SOURCE)
    .register(MEMORY_SOURCE)
    .register(SKILLS_SOURCE)
    .register(MODE_SOURCE);
}

/** Process-wide singleton — the sources are stateless, so one instance suffices. */
export const contextRegistry: ContextRegistry = defaultContextRegistry();
