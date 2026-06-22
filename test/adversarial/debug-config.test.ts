/**
 * Phase 10Q — /debug-config provenance collector (pure module tests).
 *
 * RED ANCHOR: imports from src/config/debugConfig.ts which does not exist yet.
 *
 * Pure collector tests, covering all 12 plan bullets plus formatter checks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDebugConfig,
  formatDebugConfig,
  formatDebugConfigWhy,
  type DebugConfigReport,
  type ConfigSource,
} from "../../src/config/debugConfig.js";
import type { Config } from "../../src/config/config.js";
import type { FileConfig } from "../../src/config/fileConfig.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal Config with all fields used by debugConfig. */
function makeConfig(overrides: Partial<Config> & { provider?: string }): Config {
  const base: Config = {
    provider: "deepseek",
    apiKey: "sk-test123",
    baseUrl: "",
    model: "deepseek-chat",
    temperature: 0,
    reasoningEffort: "medium",
    semanticSearch: { enabled: false, provider: "ollama", model: "nomic-embed-text", baseUrl: "http://localhost:11434", dimensions: null, hybridLexicalWeight: 0.35, topK: 12 },
    web: { enabled: false, searchProvider: "none", fetchEnabled: true, allowedDomains: [], blockedDomains: [], maxResults: 5, maxFetchBytes: 200000, maxReturnedChars: 12000, timeoutMs: 15000, redirects: 3, quarantine: true },
    maxTurns: 40,
    approvalMode: "ask",
    contextBudgetTokens: 120000,
    compactAt: 0.8,
    checkpoints: "off",
    workspaceRoot: "/tmp/test-ws",
    mcpServers: {},
    checks: {},
    mcpExecuteEnabled: false,
    interactiveShell: false,
    sandbox: { mode: "fast", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" },
    workspaceIsolation: { mode: "off", backend: "auto", keepOnSuccess: false, keepOnFailure: true, includeDirty: false, exclude: [], provision: [], setupCommands: [] },
    hooks: { enabled: false, events: {} },
    diagnostics: { enabled: false, mode: "advisory", maxPerTurn: 2, timeoutMs: 120000, rules: [] },
    context: { instructionGraph: false, instructionImports: true, instructionImportMaxDepth: 4, instructionImportMaxBytes: 65536, preflight: false, preflightMaxBytes: 6000, explorerMaxTurns: 8 },
    skills: { enabled: true, trustWorkspaceSkills: false, catalogMaxChars: 4000, activationMaxBytes: 65536, disabled: [] },
    dependencyHealing: { enabled: false, network: "off", maxAttempts: 1, allowPackageScripts: false, managers: ["npm", "pnpm", "yarn", "pip"], preferFrozenLockfile: true, timeoutMs: 300000 },
    delegate: { qualityGate: { enabled: false, mode: "mandatory", blockOnReviewerError: true, minimumBlockingSeverity: "high", maxPatchBytes: 80000, maxContextBytes: 24000 }, acceptanceFirst: { enabled: false }, autopilot: { enabled: false, maxRounds: 3, maxWorkers: 5, maxConcurrency: 2, acceptanceFirst: true, autoApply: false, stopOnConflict: true, stopOnQualityWarning: false } },
    testTargeting: { enabled: false, mode: "off", fallbackCheck: "phase", maxTargets: 8, minConfidence: "medium", runFullAfterTargetedPass: false, languageCommands: {}, pathRules: [] },
    telemetry: { statusline: true, costs: true },
  };
  return { ...base, ...overrides } as Config;
}

/** Minimal FileConfig builder. */
function makeFile(overrides?: Partial<FileConfig>): FileConfig {
  return { ...overrides };
}

/** A loadFileConfig stub returning a fixed FileConfig. */
function stubLoadFile(file: FileConfig) {
  return () => file;
}

/** A isWorkspaceTrusted stub returning fixed boolean. */
function stubTrusted(trusted: boolean) {
  return () => trusted;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("[10Q-1] provider from env beats default", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ provider: "anthropic", model: "claude-3-5-sonnet-latest" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_PROVIDER: "anthropic" },
  });

  const prov = rpt.entries.find((e) => e.key === "provider");
  assert.ok(prov, "provider entry exists");
  assert.equal(prov.value, "anthropic");
  assert.equal(prov.source, "env");
  assert.equal(prov.sourceRef, "DEEPCODER_PROVIDER");
  // default candidate should be present but not winning
  const defaultCand = prov.candidates.find((c) => c.source === "default");
  assert.ok(defaultCand);
  assert.equal(defaultCand.wins, false);
  const envCand = prov.candidates.find((c) => c.source === "env");
  assert.ok(envCand);
  assert.equal(envCand.wins, true);
});

test("[10Q-2] file sandbox.mode beats default", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ sandbox: { mode: "bubblewrap", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" } }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({ sandbox: { mode: "bubblewrap" } })),
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "sandbox.mode");
  assert.ok(entry, "sandbox.mode entry exists");
  assert.equal(entry.value, "bubblewrap");
  assert.equal(entry.source, "file");
  const fileCand = entry.candidates.find((c) => c.source === "file");
  assert.ok(fileCand);
  assert.equal(fileCand.wins, true);
  const defaultCand = entry.candidates.find((c) => c.source === "default");
  assert.ok(defaultCand);
  assert.equal(defaultCand.wins, false);
});

test("[10Q-3] env sandbox mode beats file", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ sandbox: { mode: "off", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" } }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_SANDBOX: "off" },
    loadFileConfig: stubLoadFile(makeFile({ sandbox: { mode: "docker" } })),
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "sandbox.mode");
  assert.ok(entry);
  assert.equal(entry.value, "off");
  assert.equal(entry.source, "env");
  const envCand = entry.candidates.find((c) => c.source === "env");
  assert.ok(envCand);
  assert.equal(envCand.wins, true);
  const fileCand = entry.candidates.find((c) => c.source === "file");
  assert.ok(fileCand);
  assert.equal(fileCand.wins, false);
});

test("[10Q-4] CLI/session override is shown as winning when supplied", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ sandbox: { mode: "local", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" } }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    cliOverrides: { sandbox: { mode: "local" } },
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "sandbox.mode");
  assert.ok(entry);
  assert.equal(entry.value, "local");
  assert.equal(entry.source, "cli");
  const cliCand = entry.candidates.find((c) => c.source === "cli");
  assert.ok(cliCand);
  assert.equal(cliCand.wins, true);

  // Session override wins over CLI
  const rpt2 = buildDebugConfig({
    config: makeConfig({ sandbox: { mode: "off", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "ask" } }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    cliOverrides: { sandbox: { mode: "local" } },
    sessionOverrides: { sandbox: { mode: "off" } },
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry2 = rpt2.entries.find((e) => e.key === "sandbox.mode");
  assert.ok(entry2);
  assert.equal(entry2.value, "off");
  assert.equal(entry2.source, "session");
  const sessionCand = entry2.candidates.find((c) => c.source === "session");
  assert.ok(sessionCand);
  assert.equal(sessionCand.wins, true);
  const cliCand2 = entry2.candidates.find((c) => c.source === "cli");
  assert.ok(cliCand2);
  assert.equal(cliCand2.wins, false);
});

test("[10Q-5] api key is shown only as <set> or <unset>, never value/length/hash", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ apiKey: "sk-supersecret-value-never-shown" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_API_KEY: "sk-supersecret-value-never-shown" },
  });

  const entry = rpt.entries.find((e) => e.key === "apiKey");
  assert.ok(entry);
  assert.equal(entry.redacted, true);
  assert.equal(entry.value, "<set>");
  // Verify candidates also redacted
  for (const cand of entry.candidates) {
    if (cand.present && cand.source === "env") {
      assert.match(String(cand.value ?? ""), /<set>/);
    }
  }
  // Value must NOT contain the actual key, its length, or any substring
  const reportStr = JSON.stringify(rpt);
  assert.ok(!reportStr.includes("sk-supersecret"), "actual key value not in output");
  assert.ok(!reportStr.includes("supersecret"), "key substring not in output");

  // Unset key
  const rpt2 = buildDebugConfig({
    config: makeConfig({ apiKey: "" }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    isWorkspaceTrusted: stubTrusted(true),
  });
  const entry2 = rpt2.entries.find((e) => e.key === "apiKey");
  assert.ok(entry2);
  assert.equal(entry2.value, "<unset>");
});

test("[10Q-6] provider-specific key source is shown without leaking value", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ provider: "openai-compatible", apiKey: "sk-abc" }),
    workspaceRoot: "/tmp/test-ws",
    env: {
      DEEPCODER_PROVIDER: "openai-compatible",
      OPENAI_API_KEY: "sk-abc",
    },
  });

  const entry = rpt.entries.find((e) => e.key === "apiKey");
  assert.ok(entry);
  assert.equal(entry.redacted, true);
  assert.equal(entry.value, "<set>");
  // The provider-specific env should be in the candidates
  const openaiCand = entry.candidates.find((c) => c.sourceRef === "OPENAI_API_KEY");
  assert.ok(openaiCand, "OPENAI_API_KEY candidate present");
  assert.equal(openaiCand.present, true);
  // key value still not leaked
  const reportStr = JSON.stringify(rpt);
  assert.ok(!reportStr.includes("sk-abc"), "provider-specific key not leaked");
});

test("[10Q-7] trust gate reports MCP disabled when workspace untrusted", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ mcpServers: {} }),
    workspaceRoot: "/tmp/untrusted-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({
      mcpServers: { myServer: { command: "node", args: ["server.js"] } },
    })),
    isWorkspaceTrusted: stubTrusted(false),
  });

  const entry = rpt.entries.find((e) => e.key === "mcpServers");
  assert.ok(entry);
  assert.equal(entry.value, 0);
  assert.equal(entry.source, "trust-gate");
  assert.ok(entry.notes, "trust-gate notes present");
  assert.ok(entry.notes![0].includes("not trusted"), "notes mention untrusted");
  // Warning should be present
  assert.ok(rpt.warnings.some((w) => w.includes("MCP")), "warning mentions MCP");
});

test("[10Q-8] trust gate reports hooks disabled when workspace untrusted", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ hooks: { enabled: false, events: {} } }),
    workspaceRoot: "/tmp/untrusted-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({
      hooks: { enabled: true, events: { PreToolUse: [{ name: "test", command: "echo" }] } },
    })),
    isWorkspaceTrusted: stubTrusted(false),
  });

  const entry = rpt.entries.find((e) => e.key === "hooks.enabled");
  assert.ok(entry);
  assert.equal(entry.value, false);
  assert.equal(entry.source, "trust-gate");
  assert.ok(entry.notes, "trust-gate notes present");
  assert.ok(rpt.warnings.some((w) => w.includes("hooks")), "warning mentions hooks");
});

test("[10Q-9] web enabled env var is traced", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({
      web: { enabled: true, searchProvider: "tavily", fetchEnabled: true, allowedDomains: [], blockedDomains: [], maxResults: 5, maxFetchBytes: 200000, maxReturnedChars: 12000, timeoutMs: 15000, redirects: 3, quarantine: true },
    }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_WEB: "1", DEEPCODER_WEB_SEARCH_PROVIDER: "tavily" },
  });

  const webEnabled = rpt.entries.find((e) => e.key === "web.enabled");
  assert.ok(webEnabled);
  assert.equal(webEnabled.value, true);
  assert.equal(webEnabled.source, "env");
  assert.equal(webEnabled.sourceRef, "DEEPCODER_WEB");

  const webProvider = rpt.entries.find((e) => e.key === "web.searchProvider");
  assert.ok(webProvider);
  assert.equal(webProvider.value, "tavily");
  assert.equal(webProvider.source, "env");
  assert.equal(webProvider.sourceRef, "DEEPCODER_WEB_SEARCH_PROVIDER");
});

test("[10Q-10] delegate acceptance-first env var is traced", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({
      delegate: {
        qualityGate: { enabled: false, mode: "mandatory", blockOnReviewerError: true, minimumBlockingSeverity: "high", maxPatchBytes: 80000, maxContextBytes: 24000 },
        acceptanceFirst: { enabled: true },
        autopilot: { enabled: false, maxRounds: 3, maxWorkers: 5, maxConcurrency: 2, acceptanceFirst: true, autoApply: false, stopOnConflict: true, stopOnQualityWarning: false },
      },
    }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_DELEGATE_ACCEPTANCE_FIRST: "1" },
  });

  const entry = rpt.entries.find((e) => e.key === "delegate.acceptanceFirst.enabled");
  assert.ok(entry);
  assert.equal(entry.value, true);
  assert.equal(entry.source, "env");
  assert.equal(entry.sourceRef, "DEEPCODER_DELEGATE_ACCEPTANCE_FIRST");
});

test("[10Q-11] unknown/unsupported fields are omitted, not thrown", () => {
  // buildDebugConfig should not throw even with unusual config
  const rpt = buildDebugConfig({
    config: makeConfig({ provider: "ollama", apiKey: "" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_PROVIDER: "ollama" },
    loadFileConfig: stubLoadFile(makeFile({})),
    isWorkspaceTrusted: stubTrusted(true),
  });
  assert.ok(Array.isArray(rpt.entries));
  assert.ok(Array.isArray(rpt.warnings));
  // No unexpected key should appear
  const keys = rpt.entries.map((e) => e.key);
  assert.ok(!keys.includes("nonexistent"), "no phantom keys");
});

test("[10Q-12] formatDebugConfig is deterministic and bounded", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ provider: "deepseek" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_PROVIDER: "deepseek" },
  });

  // Run twice — same output
  const a = formatDebugConfig(rpt);
  const b = formatDebugConfig(rpt);
  assert.equal(a, b, "deterministic output");

  // Section filter works
  const sandboxOut = formatDebugConfig(rpt, { section: "sandbox" });
  assert.ok(sandboxOut.includes("sandbox.mode"), "section filter sandbox includes sandbox keys");
  assert.ok(!sandboxOut.includes("provider"), "section filter sandbox excludes provider");

  // Unknown section
  const unknownOut = formatDebugConfig(rpt, { section: "foobar" });
  assert.ok(unknownOut.includes("Unknown config section"), "unknown section produces error message");

  // formatDebugConfigWhy for known key
  const why = formatDebugConfigWhy(rpt, "provider");
  assert.ok(why.includes("provider"), "why output includes key name");
  assert.ok(why.includes("winner:"), "why output includes winner");
  assert.ok(why.includes("precedence:"), "why output includes precedence");

  // formatDebugConfigWhy for unknown key
  const whyMissing = formatDebugConfigWhy(rpt, "nonexistent.key");
  assert.ok(whyMissing.includes("Unknown config key"), "unknown key produces error message");

  // Bounded: output should be non-empty but not huge
  assert.ok(a.length > 0 && a.length < 10000, "summary bounded");
  assert.ok(sandboxOut.length > 0 && sandboxOut.length < 5000, "section output bounded");
  assert.ok(why.length > 0 && why.length < 3000, "why output bounded");
});

test("[10Q-defaults] all entries have consistent types", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({}),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({})),
    isWorkspaceTrusted: stubTrusted(true),
  });

  for (const entry of rpt.entries) {
    assert.ok(typeof entry.key === "string", `key is string: ${entry.key}`);
    assert.ok(typeof entry.redacted === "boolean", `redacted is boolean: ${entry.key}`);
    assert.ok(["default", "file", "env", "cli", "session", "trust-gate", "normalized"].includes(entry.source),
      `source is valid: ${entry.key} => ${entry.source}`);
    assert.ok(typeof entry.sourceRef === "string", `sourceRef is string: ${entry.key}`);
    assert.ok(Array.isArray(entry.candidates), `candidates is array: ${entry.key}`);
    assert.ok(entry.candidates.length > 0, `at least one candidate: ${entry.key}`);
    for (const cand of entry.candidates) {
      assert.ok(typeof cand.source === "string", `cand.source is string`);
      assert.ok(typeof cand.present === "boolean", `cand.present is boolean: ${entry.key}`);
      assert.ok(typeof cand.wins === "boolean", `cand.wins is boolean: ${entry.key}`);
    }
  }
});

test("[10Q-secret-set] secret patterns are redacted (<set>/<unset> only)", () => {
  // Build a report where we have various configs that touch secret patterns
  const rpt = buildDebugConfig({
    config: makeConfig({ apiKey: "sk-real-val" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_API_KEY: "sk-real-val" },
  });

  const apiEntry = rpt.entries.find((e) => e.key === "apiKey");
  assert.ok(apiEntry);
  assert.equal(apiEntry.redacted, true);
  assert.equal(apiEntry.value, "<set>");

  // None of the secret-matching patterns should leak
  const asStr = JSON.stringify(rpt);
  assert.ok(!asStr.includes("sk-real-val"), "secret value not leaked in JSON");
  assert.ok(!asStr.includes("real-val"), "secret substring not leaked");
});

test("[10Q-diagnostic-env] diagnostics.enabled traced from env", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ diagnostics: { enabled: true, mode: "advisory", maxPerTurn: 2, timeoutMs: 120000, rules: [] } }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPCODER_DIAGNOSTICS: "1" },
  });

  const entry = rpt.entries.find((e) => e.key === "diagnostics.enabled");
  assert.ok(entry);
  assert.equal(entry.value, true);
  assert.equal(entry.source, "env");
});

test("[10Q-model-env] DEEPCODER_MODEL and provider-specific MODEL are traced", () => {
  // Provider-specific model
  const rpt = buildDebugConfig({
    config: makeConfig({ provider: "deepseek", model: "deepseek-chat" }),
    workspaceRoot: "/tmp/test-ws",
    env: { DEEPSEEK_MODEL: "deepseek-chat" },
  });

  const entry = rpt.entries.find((e) => e.key === "model");
  assert.ok(entry);
  assert.equal(entry.value, "deepseek-chat");
  assert.equal(entry.source, "env");
  // The DEEPSEEK_MODEL candidate should be present
  const dsCand = entry.candidates.find((c) => c.sourceRef === "DEEPSEEK_MODEL");
  assert.ok(dsCand, "provider-specific model candidate exists");
  assert.equal(dsCand.present, true);
});

test("[10Q-interactiveShell] default-off is traced", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ interactiveShell: false }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
  });

  // interactiveShell is NOT in the keys list per plan, so it should not appear
  const entry = rpt.entries.find((e) => e.key === "interactiveShell");
  assert.equal(entry, undefined, "interactiveShell not in debug keys per plan scope");
});

test("[10Q-sandbox-fallback] traces file fallback", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ sandbox: { mode: "fast", network: "on", workspaceWrite: true, extraMounts: [], timeoutMs: 120000, fallback: "fail" } }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({ sandbox: { fallback: "fail" } })),
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "sandbox.fallback");
  assert.ok(entry);
  assert.equal(entry.value, "fail");
  assert.equal(entry.source, "file");
});

test("[10Q-trust-gate-noop] when workspace IS trusted, MCP/hooks show file source", () => {
  const rpt = buildDebugConfig({
    config: makeConfig({ mcpServers: { myServer: { command: "node", args: ["s.js"] } } }),
    workspaceRoot: "/tmp/trusted-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({
      mcpServers: { myServer: { command: "node", args: ["s.js"] } },
    })),
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "mcpServers");
  assert.ok(entry);
  assert.equal(entry.value, 1, "MCP count is 1 when trusted");
  assert.equal(entry.source, "file");
  assert.equal(entry.notes, undefined, "no trust-gate notes when trusted");

  // No trust-gate warning
  assert.ok(!rpt.warnings.some((w) => w.includes("MCP")), "no MCP warning when trusted");
});

test("[10Q-workspaceIsolation] traces env/file/default chain", () => {
  // File beats default
  const rpt = buildDebugConfig({
    config: makeConfig({
      workspaceIsolation: {
        mode: "patch", backend: "git-worktree", keepOnSuccess: false, keepOnFailure: true,
        includeDirty: false, exclude: ["node_modules"], provision: [], setupCommands: [],
      },
    }),
    workspaceRoot: "/tmp/test-ws",
    env: {},
    loadFileConfig: stubLoadFile(makeFile({ workspaceIsolation: { mode: "patch" } })),
    isWorkspaceTrusted: stubTrusted(true),
  });

  const entry = rpt.entries.find((e) => e.key === "workspaceIsolation.mode");
  assert.ok(entry);
  assert.equal(entry.value, "patch");
  assert.equal(entry.source, "file");
});
