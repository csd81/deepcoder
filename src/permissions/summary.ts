/**
 * Phase 10P — `/permissions` unified permission summary core.
 *
 * Pure module — no terminal I/O, no filesystem, no network, no live model.
 * All inputs are injected explicitly so callers can fake/provide them.
 *
 * Exports:
 *   - PermissionSummary & associated input types
 *   - buildPermissionSummary   (async, pure-compute)
 *   - formatPermissionSummary  (sync, bounded string output)
 *   - explainCommandPermission (sync, compute explanation for one command)
 *   - formatCommandPermissionExplanation (sync, bounded string output)
 */

import type { ApprovalMode } from "../config/config.js";
import type { SandboxMode, SandboxFallback, SandboxConfig } from "../sandbox/types.js";
import type { WorkspaceIsolationConfig } from "../workspaceIsolation/types.js";
import type { HooksConfig } from "../hooks/types.js";
import type { WebConfig } from "../config/webConfig.js";
import type { CheckConfig } from "../config/fileConfig.js";
import type { Plugin } from "../plugins/types.js";
import { resolvePluginTrust, type PluginTrustStore } from "../plugins/trust.js";
import type { ApprovalDecision } from "./policy.js";
import type { ResolvedBackend } from "../sandbox/index.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PermissionSummary {
  approvalMode: ApprovalMode;
  /** Phase 10S — workspace containment (fail-closed, workspace-locked) status. */
  containment: { enabled: boolean };
  sandbox: {
    mode: SandboxMode;
    backend: string;
    backendOk: boolean;
    network: "on" | "off";
    fallback: string;
  };
  workspaceIsolation: {
    mode: string;
    backend?: string;
  };
  mcp: {
    servers: number;
    executeEnabled: boolean;
    executeTools: number;
    readonlyTools: number;
  };
  hooks: {
    enabled: boolean;
    configured: number;
  };
  web: {
    enabled: boolean;
    searchProvider: string;
  };
  plugins: {
    discovered: number;
    trusted: number;
    untrusted: number;
  };
  checks: {
    total: number;
    allow: number;
    ask: number;
    deny: number;
  };
}

export interface PermissionSummaryInput {
  approvalMode: ApprovalMode;
  containmentEnabled: boolean;
  sandboxConfig: SandboxConfig;
  workspaceIsolationConfig: WorkspaceIsolationConfig;
  hooksConfig: HooksConfig;
  webConfig: WebConfig;
  mcpExecuteEnabled: boolean;
  mcpServersCount: number;
  mcpExecuteToolsCount: number;
  mcpReadonlyToolsCount: number;
  checksConfig: Record<string, CheckConfig>;
  plugins: Plugin[];
  pluginTrustStore: PluginTrustStore;
  /** Classifier function — typically `classifyCommand`. */
  classifyCommand: (cmd: string) => ApprovalDecision;
  /** Sandbox backend resolver — typically `resolveBackend`. */
  resolveBackend: (mode: SandboxMode, fallback?: SandboxFallback) => ResolvedBackend;
}

export interface ExplainCommandInput {
  command: string;
  approvalMode: ApprovalMode;
  sandboxConfig: SandboxConfig;
  /** Classifier function — typically `classifyCommand`. */
  classifyCommand: (cmd: string) => ApprovalDecision;
  /** Sandbox backend resolver — typically `resolveBackend`. */
  resolveBackend: (mode: SandboxMode, fallback?: SandboxFallback) => ResolvedBackend;
}

export interface CommandPermissionExplanation {
  /** The raw command string (bounded / redacted). */
  command: string;
  /** Classifier's raw decision for this command. */
  classifierDecision: ApprovalDecision;
  /** Current session approval mode. */
  approvalMode: ApprovalMode;
  /** Whether this command would trigger a user prompt (true when classifier says "ask" or mode says "ask"). */
  requiresApproval: boolean;
  sandbox: {
    mode: SandboxMode;
    backend: string;
    network: "on" | "off";
    /** True when the sandbox resolution throws (fail-closed, will refuse to run). */
    failClosed: boolean;
  };
}

// ---------------------------------------------------------------------------
// Command redaction
// ---------------------------------------------------------------------------

/** Maximum raw command length shown in explanations. */
const MAX_COMMAND_LENGTH = 200;

/** Patterns that look like secrets/tokens/keys — redact if matched. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9]{20,}/g,       // OpenAI-style keys
  /ghp_[a-zA-Z0-9]{36,}/g,      // GitHub PATs
  /gho_[a-zA-Z0-9]{36,}/g,
  /ghu_[a-zA-Z0-9]{36,}/g,
  /ghs_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9]{22,}/g,
  /AKIA[0-9A-Z]{16}/g,          // AWS access key
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /xox[baprs]-[a-zA-Z0-9-]{24,}/g, // Slack tokens
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, // JWT
];

/**
 * Redact secrets and bound the length of a command string for display.
 * Never reveals full secrets in output.
 */
function redactCommand(command: string): string {
  let redacted = command;
  for (const re of SECRET_PATTERNS) {
    redacted = redacted.replace(re, "***REDACTED***");
  }
  if (redacted.length > MAX_COMMAND_LENGTH) {
    redacted = redacted.slice(0, MAX_COMMAND_LENGTH) + "...";
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// buildPermissionSummary — compute the full permission snapshot
// ---------------------------------------------------------------------------

/**
 * Build a complete PermissionSummary from injected inputs.
 * Pure computation — no I/O, no side effects.
 */
export async function buildPermissionSummary(
  input: PermissionSummaryInput,
): Promise<PermissionSummary> {
  // --- Sandbox backend resolution ---
  let backend: string;
  let backendOk: boolean;
  try {
    backend = input.resolveBackend(input.sandboxConfig.mode, input.sandboxConfig.fallback);
    backendOk = true;
  } catch {
    backend = "unknown";
    backendOk = false;
  }

  // --- Plugin trust counts ---
  // Use the trust store (not the plugin's trustState, which is always "untrusted")
  // to determine actual trust status.
  let trusted = 0;
  let untrusted = 0;
  for (const p of input.plugins) {
    const resolved = resolvePluginTrust(p, input.pluginTrustStore);
    if (resolved.state === "trusted") trusted++;
    else untrusted++;
  }

  // --- Check counts via classifier ---
  const checkCommands = Object.values(input.checksConfig)
    .filter((c) => c.command)
    .map((c) => c.command);
  let checkAllow = 0;
  let checkAsk = 0;
  let checkDeny = 0;
  for (const cmd of checkCommands) {
    const decision = input.classifyCommand(cmd);
    if (decision === "allow") checkAllow++;
    else if (decision === "deny") checkDeny++;
    else checkAsk++;
  }

  // --- Hook count ---
  const hookConfigured = Object.values(input.hooksConfig.events).reduce(
    (sum, arr) => sum + (arr?.length ?? 0),
    0,
  );

  return {
    approvalMode: input.approvalMode,
    containment: { enabled: input.containmentEnabled },
    sandbox: {
      mode: input.sandboxConfig.mode,
      backend,
      backendOk,
      network: input.sandboxConfig.network,
      fallback: input.sandboxConfig.fallback,
    },
    workspaceIsolation: {
      mode: input.workspaceIsolationConfig.mode,
      backend: input.workspaceIsolationConfig.backend,
    },
    mcp: {
      servers: input.mcpServersCount,
      executeEnabled: input.mcpExecuteEnabled,
      executeTools: input.mcpExecuteToolsCount,
      readonlyTools: input.mcpReadonlyToolsCount,
    },
    hooks: {
      enabled: input.hooksConfig.enabled,
      configured: hookConfigured,
    },
    web: {
      enabled: input.webConfig.enabled,
      searchProvider: input.webConfig.searchProvider,
    },
    plugins: {
      discovered: input.plugins.length,
      trusted,
      untrusted,
    },
    checks: {
      total: checkCommands.length,
      allow: checkAllow,
      ask: checkAsk,
      deny: checkDeny,
    },
  };
}

// ---------------------------------------------------------------------------
// formatPermissionSummary — human-readable display
// ---------------------------------------------------------------------------

/**
 * Render a PermissionSummary as a bounded, deterministic string.
 * No secrets, no env values, no API keys.
 */
export function formatPermissionSummary(summary: PermissionSummary): string {
  const lines: string[] = ["Permissions"];

  lines.push(`  approval mode: ${summary.approvalMode}`);
  if (summary.containment.enabled) {
    lines.push(`  containment: ON (workspace-locked, fail-closed)`);
  }

  const sb = summary.sandbox;
  const backendStatus = sb.backendOk ? sb.backend : `${sb.backend} (unavailable)`;
  lines.push(`  sandbox: ${sb.mode} -> ${backendStatus} · network ${sb.network} · fallback ${sb.fallback}`);

  const wi = summary.workspaceIsolation;
  if (wi.backend) {
    lines.push(`  workspace isolation: ${wi.mode} (${wi.backend})`);
  } else {
    lines.push(`  workspace isolation: ${wi.mode}`);
  }

  const mcp = summary.mcp;
  const mcpExecStatus = mcp.executeEnabled ? "enabled" : "disabled";
  lines.push(`  MCP: ${mcp.servers} server(s) · readonly tools enabled · execute tools ${mcpExecStatus}`);

  const hooks = summary.hooks;
  lines.push(`  hooks: ${hooks.enabled ? "enabled" : "disabled"} · ${hooks.configured} configured`);

  const web = summary.web;
  lines.push(`  web: ${web.enabled ? "enabled" : "disabled"} · search: ${web.searchProvider}`);

  const plugins = summary.plugins;
  lines.push(`  plugins: ${plugins.discovered} discovered · ${plugins.trusted} trusted · ${plugins.untrusted} untrusted`);

  const checks = summary.checks;
  lines.push(`  checks: ${checks.total} configured · ${checks.allow} allow · ${checks.ask} ask · ${checks.deny} denied`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// explainCommandPermission — one-command policy explanation
// ---------------------------------------------------------------------------

/**
 * Compute a policy explanation for a single command without executing it.
 * Pure computation — no I/O, no side effects.
 */
export function explainCommandPermission(
  input: ExplainCommandInput,
): CommandPermissionExplanation {
  const classifierDecision = input.classifyCommand(input.command);

  // Sandbox resolution — catch fail-closed errors.
  let sandboxBackend: string;
  let sandboxFailClosed = false;
  try {
    sandboxBackend = input.resolveBackend(
      input.sandboxConfig.mode,
      input.sandboxConfig.fallback,
    );
  } catch {
    sandboxBackend = "unknown";
    sandboxFailClosed = true;
  }

  // Determine if approval is needed.
  // Approval is needed when: classifier says "ask", OR mode is "readonly" (all denied),
  // OR mode is "ask" and classifier says "ask" (explicit prompt).
  // Actually the logic from policy.ts:
  // - readonly mode → deny
  // - auto mode → classifier decision
  // - ask mode → classifier decision (but ask stays ask)
  // So requiresApproval = (classifierDecision === "ask" && approvalMode !== "auto")
  //                    OR (approvalMode === "readonly")
  const requiresApproval =
    classifierDecision === "deny"
      ? false // denied by classifier, not asked
      : input.approvalMode === "readonly"
        ? true // readonly mode would deny everything
        : classifierDecision === "ask";

  return {
    command: redactCommand(input.command),
    classifierDecision,
    approvalMode: input.approvalMode,
    requiresApproval,
    sandbox: {
      mode: input.sandboxConfig.mode,
      backend: sandboxBackend,
      network: input.sandboxConfig.network,
      failClosed: sandboxFailClosed,
    },
  };
}

// ---------------------------------------------------------------------------
// formatCommandPermissionExplanation — human-readable command explanation
// ---------------------------------------------------------------------------

/**
 * Render a CommandPermissionExplanation as a bounded, deterministic string.
 * No secrets, no command execution, no API keys.
 */
export function formatCommandPermissionExplanation(
  x: CommandPermissionExplanation,
): string {
  const lines: string[] = [];

  lines.push(`command: ${x.command}`);
  lines.push(`policy: ${x.classifierDecision}`);
  lines.push(`approval mode: ${x.approvalMode}`);

  if (x.requiresApproval) {
    lines.push(`requires approval: yes`);
  } else {
    lines.push(`requires approval: no`);
  }

  const sb = x.sandbox;
  if (sb.failClosed) {
    lines.push(`sandbox: ${sb.mode} -> FAIL-CLOSED (backend unavailable) · network ${sb.network}`);
    lines.push(`  ⚠ Sandbox resolution failed — this command would be refused`);
  } else {
    lines.push(`sandbox: ${sb.mode} -> ${sb.backend} · network ${sb.network}`);
  }

  return lines.join("\n");
}
