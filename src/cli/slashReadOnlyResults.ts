/**
 * Phase 10A.14 — Pure-ish result producers for read-only slash commands.
 *
 * These functions extract structured SlashResult data from a Session without
 * performing terminal I/O, model calls, or mutations. Some producers are async
 * (plugin discovery requires filesystem access), but none write to stdout/stderr
 * or the terminal.
 */

import { type Session } from "./repl.js";
import type { SlashResult } from "./slashResult.js";
import { estimateCost } from "../providers/pricing.js";
import { estimateMessages } from "../context/tokenBudget.js";
import { renderTodos } from "../tools/todoWrite.js";
import { summarizeWebTrace } from "../web/trace.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { discoverPlugins } from "../plugins/discovery.js";
import { resolvePluginTrust } from "../plugins/trust.js";
import type { PluginTrustStore } from "../plugins/trust.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

// ── Usage ───────────────────────────────────────────────────────────────────

export function usageResult(session: Session): SlashResult {
  const u = session.tokenUsage;
  const { config } = session;
  const est = estimateCost(u, {
    provider: config.provider,
    model: config.model,
    pricing: config.telemetry.pricing,
  });

  const rows: string[][] = [
    ["total", String(u.totalTokens)],
    ["prompt", String(u.promptTokens)],
    ["completion", String(u.completionTokens)],
  ];

  if (est.pricingKnown && config.telemetry.costs !== false) {
    rows.push(["est. cost", `~$${est.totalUsd.toFixed(4)}`]);
    rows.push(["rate", est.rateLabel]);
  } else {
    rows.push(["est. cost", "unknown (pricing unknown)"]);
  }

  return {
    kind: "table",
    title: "Usage",
    headers: ["metric", "value"],
    rows,
  };
}

// ── Cost ────────────────────────────────────────────────────────────────────

export function costResult(session: Session): SlashResult {
  const u = session.tokenUsage;
  const { config } = session;
  const est = estimateCost(u, {
    provider: config.provider,
    model: config.model,
    pricing: config.telemetry.pricing,
  });

  if (!est.pricingKnown) {
    return messageResult(
      "Cost",
      `Pricing unknown for ${config.provider}/${config.model} — showing tokens only (total ${u.totalTokens}).`,
      "warn",
    );
  }

  const rows: string[][] = [
    ["total", `~$${est.totalUsd.toFixed(4)}`],
    ["input", `~$${est.inputUsd.toFixed(4)}`],
    ["output", `~$${est.outputUsd.toFixed(4)}`],
    ["rate", est.rateLabel],
    ["tokens", String(u.totalTokens)],
  ];

  return {
    kind: "table",
    title: "Estimated Cost",
    headers: ["item", "value"],
    rows,
  };
}

// ── Telemetry ───────────────────────────────────────────────────────────────

export function telemetryResult(session: Session): SlashResult {
  const { config } = session;
  const t = session.telemetry;
  const u = session.tokenUsage;
  const est = estimateCost(u, {
    provider: config.provider,
    model: config.model,
    pricing: config.telemetry.pricing,
  });

  const rows: string[][] = [
    ["tokens", String(u.totalTokens)],
    ["model calls", String(t?.modelCalls ?? 0)],
    ["tool calls", String(t?.toolCalls ?? 0)],
    ["check runs", String(t?.checkRuns ?? 0)],
    ["warnings", String(t?.warnings.length ?? 0)],
  ];

  if (est.pricingKnown) {
    rows.push(["est. cost", `~$${est.totalUsd.toFixed(4)}`]);
  }

  return {
    kind: "table",
    title: "Telemetry",
    headers: ["metric", "value"],
    rows,
  };
}

// ── Context ─────────────────────────────────────────────────────────────────

export function contextResult(session: Session): SlashResult {
  const used = estimateMessages(session.messages);
  const budget = session.config.contextBudgetTokens;
  const pct = Math.round((used / budget) * 100);
  const compactPct = Math.round(session.config.compactAt * 100);

  return {
    kind: "message",
    title: "Context",
    body: `~${used} / ${budget} tokens (${pct}%), compacts at ${compactPct}%`,
  };
}

// ── Web ─────────────────────────────────────────────────────────────────────

export function webResult(session: Session): SlashResult {
  const w = session.config.web;
  const enabledLabel = w.enabled ? "enabled" : "disabled";
  const allowed = w.allowedDomains.length > 0 ? w.allowedDomains.join(", ") : "(any non-blocked)";
  const blocked = String(w.blockedDomains.length);
  const trace = summarizeWebTrace(session.webTrace ?? []);
  const traceLines = trace.split("\n").map((l) => `  ${l}`).join("\n");

  return {
    kind: "message",
    title: `Web access (${enabledLabel})`,
    body: [
      `provider: ${w.searchProvider} · allowed: ${allowed} · blocked: ${blocked}`,
      `trace:`,
      traceLines,
    ].join("\n"),
  };
}

// ── Todos ───────────────────────────────────────────────────────────────────

export function todosResult(session: Session): SlashResult {
  const rendered = renderTodos(session.todos);
  return messageResult("Todos", rendered);
}

// ── Plugins (async — needs filesystem access) ──────────────────────────────

export async function pluginsResult(session: Session, _arg: string): Promise<SlashResult> {
  const root = session.config.workspaceRoot;
  const storePath = path.join(root, ".deepcoder", "plugin-trust.json");
  let store: PluginTrustStore;
  try {
    store = JSON.parse(await fs.readFile(storePath, "utf8")) as PluginTrustStore;
  } catch {
    store = { plugins: {} };
  }

  const plugins = await discoverPlugins(root, os.homedir());

  if (plugins.length === 0) {
    return messageResult(
      "Plugins",
      "No plugins discovered (.deepcoder/plugins, .agents/plugins, ~/.deepcoder/plugins).",
      "info",
    );
  }

  const rows: string[][] = [];
  for (const p of plugins) {
    const t = resolvePluginTrust(p, store);
    const mark = t.enabled ? "●" : "○";
    rows.push([mark, p.manifest.name, `[${p.source}] ${t.state}`, p.manifest.description]);
  }

  return {
    kind: "table",
    title: `Plugins (${plugins.length})`,
    headers: ["", "name", "trust", "description"],
    rows,
  };
}

// ── Checks ──────────────────────────────────────────────────────────────────

export function checksResult(session: Session): SlashResult {
  const names = Object.keys(session.config.checks);
  if (names.length === 0) {
    return messageResult(
      "Checks",
      'No checks configured. Add to .deepcoder/config.json, e.g.:\n  { "checks": { "unit": { "command": "npm run test:unit" } } }',
      "info",
    );
  }

  const rows: string[][] = [];
  for (const n of names.sort()) {
    const c = session.config.checks[n]!;
    const gate = classifyCommand(c.command) === "deny"
      ? "[blocked by policy]"
      : "";
    rows.push([n, c.command, gate]);
  }

  return {
    kind: "table",
    title: "Checks",
    headers: ["name", "command", ""],
    rows,
  };
}

// ── Internal helper ─────────────────────────────────────────────────────────

function messageResult(
  title: string,
  body: string,
  severity?: "info" | "warn" | "error",
): SlashResult {
  return { kind: "message", title, body, severity };
}
