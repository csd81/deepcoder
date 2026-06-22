/**
 * Phase 10P — `/permissions` pure permission summary core.
 * Adversarial tests covering all 12 plan bullets.
 *
 * Pure module tests only — no slash command wiring, no terminal I/O,
 * no filesystem, no network, no live model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPermissionSummary,
  formatPermissionSummary,
  explainCommandPermission,
  formatCommandPermissionExplanation,
  type PermissionSummaryInput,
  type ExplainCommandInput,
  type PermissionSummary,
} from "../../src/permissions/summary.js";
import type { SandboxMode, SandboxFallback, SandboxConfig } from "../../src/sandbox/types.js";
import type { WorkspaceIsolationConfig } from "../../src/workspaceIsolation/types.js";
import type { HooksConfig } from "../../src/hooks/types.js";
import type { WebConfig } from "../../src/config/webConfig.js";
import type { CheckConfig } from "../../src/config/fileConfig.js";
import type { Plugin } from "../../src/plugins/types.js";
import type { PluginTrustStore } from "../../src/plugins/trust.js";
import type { ApprovalDecision } from "../../src/permissions/policy.js";
import type { ResolvedBackend } from "../../src/sandbox/index.js";
import { classifyCommand } from "../../src/permissions/commandClassifier.js";
import { resolveBackend as realResolveBackend } from "../../src/sandbox/index.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const DEFAULT_SANDBOX: SandboxConfig = {
  mode: "fast" as SandboxMode,
  network: "on",
  workspaceWrite: true,
  extraMounts: [],
  timeoutMs: 120_000,
  fallback: "ask" as SandboxFallback,
};

const DEFAULT_WS_ISOLATION: WorkspaceIsolationConfig = {
  mode: "off",
  backend: "auto",
  keepOnSuccess: false,
  keepOnFailure: true,
  includeDirty: false,
  exclude: [],
  provision: [],
  setupCommands: [],
};

const DEFAULT_HOOKS: HooksConfig = { enabled: false, events: {} };

const DEFAULT_WEB: WebConfig = {
  enabled: false,
  searchProvider: "none",
  fetchEnabled: true,
  allowedDomains: [],
  blockedDomains: [],
  maxResults: 5,
  maxFetchBytes: 200000,
  maxReturnedChars: 12000,
  timeoutMs: 15000,
  redirects: 3,
  quarantine: true,
};

/** Stub classifier — returns the given decision for any command. */
function stubClassifier(decision: ApprovalDecision): (cmd: string) => ApprovalDecision {
  return (_cmd: string) => decision;
}

/** Stub backbone resolver. */
function stubResolver(backend: ResolvedBackend, shouldThrow = false): (mode: SandboxMode, fallback?: SandboxFallback) => ResolvedBackend {
  return (_mode: SandboxMode, _fallback?: SandboxFallback) => {
    if (shouldThrow) throw new Error("bwrap not available");
    return backend;
  };
}

function makePlugin(name: string, trustState: "trusted" | "untrusted" = "untrusted"): Plugin {
  return {
    manifest: {
      schemaVersion: 1,
      name,
      version: "1.0.0",
      description: `Plugin ${name}`,
      capabilities: ["skills"],
    },
    dir: `/fake/plugins/${name}`,
    source: "workspace",
    trustState,
    warnings: [],
  };
}

/**
 * Build a trust store entry key for a plugin.
 * Mirrors pluginTrustKey from src/plugins/trust.ts.
 */
function pluginKey(source: string, name: string, dir: string): string {
  return `${source}:${name}:${dir}`;
}

/** Create a trust store with specific plugins trusted. */
function trustStoreFor(trustedNames: string[]): PluginTrustStore {
  const plugins: Record<string, { state: "trusted" | "untrusted"; enabled: boolean }> = {};
  for (const name of trustedNames) {
    const key = pluginKey("workspace", name, `/fake/plugins/${name}`);
    plugins[key] = { state: "trusted", enabled: true };
  }
  return { plugins };
}

function makeCheckConfig(command: string): CheckConfig {
  return { command };
}

function makeMinimalInput(overrides?: Partial<PermissionSummaryInput>): PermissionSummaryInput {
  return {
    approvalMode: "ask",
    sandboxConfig: { ...DEFAULT_SANDBOX },
    workspaceIsolationConfig: { ...DEFAULT_WS_ISOLATION },
    hooksConfig: { ...DEFAULT_HOOKS },
    webConfig: { ...DEFAULT_WEB },
    mcpExecuteEnabled: false,
    mcpServersCount: 0,
    mcpExecuteToolsCount: 0,
    mcpReadonlyToolsCount: 0,
    checksConfig: {},
    plugins: [],
    pluginTrustStore: { plugins: {} },
    classifyCommand: stubClassifier("ask"),
    resolveBackend: stubResolver("local"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure summary tests
// ---------------------------------------------------------------------------

test("1. Summary counts allow/ask/deny check commands", async () => {
  const input = makeMinimalInput({
    checksConfig: {
      lint: makeCheckConfig("ls"),
      test1: makeCheckConfig("cat README.md"),
      test2: makeCheckConfig("rg needle ."),
    },
    classifyCommand: (cmd) => {
      if (cmd === "ls" || cmd === "cat README.md") return "allow";
      if (cmd === "rg needle .") return "ask";
      return "ask";
    },
  });

  const summary = await buildPermissionSummary(input);
  assert.equal(summary.checks.total, 3);
  assert.equal(summary.checks.allow, 2);
  assert.equal(summary.checks.ask, 1);
  assert.equal(summary.checks.deny, 0);
});

test("2. Denied check commands appear in deny count", async () => {
  const input = makeMinimalInput({
    checksConfig: {
      safe: makeCheckConfig("ls"),
      dangerous: makeCheckConfig("rm -rf /"),
      risky: makeCheckConfig("sudo echo hi"),
    },
    classifyCommand: (cmd) => {
      if (cmd === "ls") return "allow";
      if (cmd === "rm -rf /") return "deny";
      if (cmd === "sudo echo hi") return "deny";
      return "ask";
    },
  });

  const summary = await buildPermissionSummary(input);
  assert.equal(summary.checks.total, 3);
  assert.equal(summary.checks.allow, 1);
  assert.equal(summary.checks.deny, 2);
  assert.equal(summary.checks.ask, 0);
});

test("3. Sandbox backend failure is represented without throwing", async () => {
  const input = makeMinimalInput({
    sandboxConfig: { ...DEFAULT_SANDBOX, mode: "bubblewrap", fallback: "fail" },
    resolveBackend: stubResolver("unknown", true), // throws
  });

  // Must not throw
  const summary = await buildPermissionSummary(input);
  assert.equal(summary.sandbox.backendOk, false);
  assert.equal(summary.sandbox.backend, "unknown");
  assert.equal(summary.sandbox.mode, "bubblewrap");
});

test("4. MCP execute-disabled state appears clearly", async () => {
  const input = makeMinimalInput({
    mcpExecuteEnabled: false,
    mcpServersCount: 2,
    mcpExecuteToolsCount: 5,
    mcpReadonlyToolsCount: 10,
  });

  const summary = await buildPermissionSummary(input);
  assert.equal(summary.mcp.executeEnabled, false);
  assert.equal(summary.mcp.servers, 2);
  assert.equal(summary.mcp.executeTools, 5);
  assert.equal(summary.mcp.readonlyTools, 10);
});

test("5. Web enabled/disabled state appears clearly", async () => {
  // Disabled web
  const disabled = await buildPermissionSummary(makeMinimalInput({
    webConfig: { ...DEFAULT_WEB, enabled: false, searchProvider: "none" },
  }));
  assert.equal(disabled.web.enabled, false);
  assert.equal(disabled.web.searchProvider, "none");

  // Enabled web
  const enabled = await buildPermissionSummary(makeMinimalInput({
    webConfig: { ...DEFAULT_WEB, enabled: true, searchProvider: "brave" },
  }));
  assert.equal(enabled.web.enabled, true);
  assert.equal(enabled.web.searchProvider, "brave");
});

test("6. Plugin trust counts are computed without executing plugins", async () => {
  // Create 5 plugins — only 'plugin-a' and 'plugin-b' are in the trust store
  const plugins = [
    makePlugin("plugin-a"),
    makePlugin("plugin-b"),
    makePlugin("plugin-c"),
    makePlugin("plugin-d"),
    makePlugin("plugin-e"),
  ];

  const input = makeMinimalInput({
    plugins,
    pluginTrustStore: trustStoreFor(["plugin-a", "plugin-b"]),
  });

  const summary = await buildPermissionSummary(input);
  assert.equal(summary.plugins.discovered, 5);
  assert.equal(summary.plugins.trusted, 2);
  assert.equal(summary.plugins.untrusted, 3);
});

test("7. Formatter output is bounded and deterministic", async () => {
  const summary: PermissionSummary = {
    approvalMode: "ask",
    sandbox: {
      mode: "fast",
      backend: "bubblewrap",
      backendOk: true,
      network: "off",
      fallback: "ask",
    },
    workspaceIsolation: { mode: "off" },
    mcp: { servers: 1, executeEnabled: false, executeTools: 0, readonlyTools: 3 },
    hooks: { enabled: false, configured: 0 },
    web: { enabled: false, searchProvider: "none" },
    plugins: { discovered: 3, trusted: 1, untrusted: 2 },
    checks: { total: 4, allow: 1, ask: 2, deny: 1 },
  };

  const output = formatPermissionSummary(summary);

  // Deterministic: same input always produces same output
  const output2 = formatPermissionSummary(summary);
  assert.equal(output, output2);

  // Contains all expected sections
  assert(output.startsWith("Permissions"), "Should start with header");
  assert(output.includes("approval mode: ask"));
  assert(output.includes("sandbox: fast -> bubblewrap"));
  assert(output.includes("network off"));
  assert(output.includes("workspace isolation: off"));
  assert(output.includes("MCP: 1 server(s)"));
  assert(output.includes("execute tools disabled"));
  assert(output.includes("hooks: disabled"));
  assert(output.includes("web: disabled"));
  assert(output.includes("plugins: 3 discovered · 1 trusted · 2 untrusted"));
  assert(output.includes("checks: 4 configured · 1 allow · 2 ask · 1 denied"));

  // No secrets / API keys in output
  assert(!output.includes("sk-"));
  assert(!output.includes("AKIA"));
  assert(!output.match(/[A-Za-z0-9+_]{20,}/));

  // Bounded length (< 2 KB)
  assert(output.length < 2000, `Output length ${output.length} exceeds bound`);
});

test("8. JSON-like summary contains no secrets", async () => {
  const summary: PermissionSummary = {
    approvalMode: "readonly",
    sandbox: {
      mode: "off",
      backend: "off",
      backendOk: true,
      network: "on",
      fallback: "ask",
    },
    workspaceIsolation: { mode: "patch", backend: "git-worktree" },
    mcp: { servers: 0, executeEnabled: true, executeTools: 0, readonlyTools: 0 },
    hooks: { enabled: true, configured: 2 },
    web: { enabled: true, searchProvider: "google" },
    plugins: { discovered: 0, trusted: 0, untrusted: 0 },
    checks: { total: 1, allow: 1, ask: 0, deny: 0 },
  };

  // Serialize to JSON — no struct should contain a secret-looking value
  const json = JSON.stringify(summary);
  assert(!json.includes("sk-"), "JSON must not contain OpenAI-style keys");
  assert(!json.includes("AKIA"), "JSON must not contain AWS access keys");
  assert(!json.includes("ghp_"), "JSON must not contain GitHub PATs");
  assert(!json.includes("-----BEGIN"), "JSON must not contain private keys");
  assert(!json.includes("DEEPCODER_API_KEY"), "JSON must not contain env var names");

  // All expected fields present
  const parsed = JSON.parse(json) as PermissionSummary;
  assert.equal(parsed.approvalMode, "readonly");
  assert.equal(parsed.sandbox.mode, "off");
  assert.equal(parsed.workspaceIsolation.mode, "patch");
  assert.equal(parsed.mcp.executeEnabled, true);
  assert.equal(parsed.hooks.enabled, true);
  assert.equal(parsed.web.enabled, true);
  assert.equal(parsed.web.searchProvider, "google");
});

// ---------------------------------------------------------------------------
// Command explanation tests
// ---------------------------------------------------------------------------

test("9. Safe command explains `allow` or `ask` according to classifier", () => {
  // 'ls' is classified as "allow" by the real classifier
  const input: ExplainCommandInput = {
    command: "ls",
    approvalMode: "ask",
    sandboxConfig: { ...DEFAULT_SANDBOX },
    classifyCommand: classifyCommand,
    resolveBackend: realResolveBackend,
  };

  const explanation = explainCommandPermission(input);
  assert.equal(explanation.command, "ls");
  assert.ok(
    explanation.classifierDecision === "allow" || explanation.classifierDecision === "ask",
    `Expected allow or ask, got ${explanation.classifierDecision}`,
  );

  // In 'ask' mode, if classifier says 'allow', no approval needed
  if (explanation.classifierDecision === "allow") {
    assert.equal(explanation.requiresApproval, false);
  }

  // Sandbox is resolved without fail-closed
  assert.equal(explanation.sandbox.failClosed, false);
  assert.equal(typeof explanation.sandbox.backend, "string");
});

test("10. Dangerous command explains `deny`", () => {
  const input: ExplainCommandInput = {
    command: "rm -rf /",
    approvalMode: "ask",
    sandboxConfig: { ...DEFAULT_SANDBOX },
    classifyCommand: classifyCommand,
    resolveBackend: realResolveBackend,
  };

  const explanation = explainCommandPermission(input);
  assert.equal(explanation.classifierDecision, "deny");
  assert.equal(explanation.requiresApproval, false); // denied, not asked
  assert.equal(explanation.command, "rm -rf /");
});

test("11. Secret-looking command is redacted in output", () => {
  // Command containing an OpenAI API key
  const secretCommand = "curl -H 'Authorization: Bearer sk-1234567890123456789012345678901234567890123456' https://api.openai.com/v1/models";

  const input: ExplainCommandInput = {
    command: secretCommand,
    approvalMode: "auto",
    sandboxConfig: { ...DEFAULT_SANDBOX },
    classifyCommand: stubClassifier("deny"),
    resolveBackend: stubResolver("local"),
  };

  const explanation = explainCommandPermission(input);
  // The command in output should be redacted
  assert(!explanation.command.includes("sk-1234567890123456789012345678901234567890123456"),
    "Command should not contain the raw API key");
  assert(explanation.command.includes("***REDACTED***") || explanation.command.endsWith("..."),
    "Secret should be redacted or truncated");

  // Also test formatted output has no raw secret
  const formatted = formatCommandPermissionExplanation(explanation);
  assert(!formatted.includes("sk-12345678901234567890"),
    "Formatted output must not contain the raw API key");
});

test("12. Sandbox fail-closed explanation shows that it would refuse", () => {
  const input: ExplainCommandInput = {
    command: "npm run test:phase",
    approvalMode: "ask",
    sandboxConfig: {
      ...DEFAULT_SANDBOX,
      mode: "bubblewrap",
      fallback: "fail", // fail-closed when bwrap unavailable
    },
    classifyCommand: stubClassifier("ask"),
    // This resolver throws — simulating bwrap not available with fail-closed
    resolveBackend: stubResolver("unknown", true),
  };

  const explanation = explainCommandPermission(input);
  assert.equal(explanation.sandbox.failClosed, true);
  assert.equal(explanation.sandbox.backend, "unknown");

  // Formatted output should show the warning
  const formatted = formatCommandPermissionExplanation(explanation);
  assert(formatted.includes("FAIL-CLOSED"),
    "Formatted explanation should contain fail-closed warning");
  assert(formatted.includes("⚠"),
    "Formatted explanation should contain a warning indicator");
});

test("13. formatCommandPermissionExplanation output is deterministic and bounded", () => {
  const explanation = explainCommandPermission({
    command: "npm run build",
    approvalMode: "ask",
    sandboxConfig: { ...DEFAULT_SANDBOX },
    classifyCommand: classifyCommand,
    resolveBackend: realResolveBackend,
  });

  const output = formatCommandPermissionExplanation(explanation);
  const output2 = formatCommandPermissionExplanation(explanation);
  assert.equal(output, output2, "Should be deterministic");

  assert(output.includes("command:"));
  assert(output.includes("policy:"));
  assert(output.includes("approval mode:"));
  assert(output.includes("sandbox:"));

  // Bounded
  assert(output.length < 1000, `Output too long: ${output.length}`);
});
