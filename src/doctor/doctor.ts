import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveBackend } from "../sandbox/index.js";
import { classifyCommand } from "../permissions/commandClassifier.js";
import { findPricing } from "../providers/pricing.js";
import type { Config } from "../config/config.js";
import type { ApprovalDecision } from "../permissions/policy.js";
import type { DoctorLevel, DoctorFinding, DoctorReport } from "./types.js";

// ── Injection types ──────────────────────────────────────────────────────────

export interface ExecFileLike {
  (cmd: string, args: string[], opts?: { cwd?: string; env?: Record<string, string | undefined> }): Promise<{ stdout: string; stderr: string }>;
}

export interface FsProbeLike {
  access(path: string): Promise<boolean>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean } | null>;
}

export interface DoctorInput {
  workspaceRoot: string;
  config: Config;
  env?: Record<string, string | undefined>;
  execFile?: ExecFileLike;
  fs?: FsProbeLike;
  home?: string;
  /** Override for sandbox backend resolution (default: real resolveBackend). */
  resolveBackend?: (mode: string, fallback?: string) => string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function finding(
  id: string,
  section: string,
  level: DoctorLevel,
  title: string,
  details?: string,
  fix?: string,
): DoctorFinding {
  return { id, section, level, title, details, fix };
}

function okFinding(id: string, section: string, title: string, details?: string): DoctorFinding {
  return finding(id, section, "ok", title, details);
}

function warnFinding(id: string, section: string, title: string, details?: string, fix?: string): DoctorFinding {
  return finding(id, section, "warn", title, details, fix);
}

function errFinding(id: string, section: string, title: string, details?: string, fix?: string): DoctorFinding {
  return finding(id, section, "error", title, details, fix);
}

function countCommands(hooks: { events?: Record<string, { command: string }[]> }): number {
  let total = 0;
  if (hooks.events) {
    for (const list of Object.values(hooks.events)) {
      total += (list as { command: string }[]).length;
    }
  }
  return total;
}

// ── Default real implementations ──────────────────────────────────────────────

const defaultExecFile: ExecFileLike = async (cmd, args, opts) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: opts.env as Record<string, string | undefined> } : {}),
      maxBuffer: 64 * 1024,
      timeout: 5_000,
    });
    return { stdout, stderr };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? (e as Error).message ?? "unknown error",
    };
  }
};

const defaultFs: FsProbeLike = {
  async access(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(p: string): Promise<string> {
    return fs.readFile(p, "utf8");
  },
  async readdir(p: string): Promise<string[]> {
    return fs.readdir(p);
  },
  async stat(p: string): Promise<{ isDirectory(): boolean } | null> {
    try {
      return await fs.stat(p);
    } catch {
      return null;
    }
  },
};

// ── Section collectors ────────────────────────────────────────────────────────

async function collectProvider(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const env = input.env ?? process.env;
  const findings: DoctorFinding[] = [];

  // Provider key: check env first, then config.apiKey
  const keySources: string[] = [];
  const providerUppercase = config.provider.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  const specificKeyVar = `DEEPCODER_${providerUppercase}_API_KEY`;
  const genericKeyVar = "DEEPCODER_API_KEY";

  if (env[specificKeyVar] && env[specificKeyVar]!.length > 0) {
    keySources.push(specificKeyVar);
  }
  if (env[genericKeyVar] && env[genericKeyVar]!.length > 0) {
    keySources.push(genericKeyVar);
  }
  if (config.apiKey && config.apiKey.length > 0) {
    keySources.push("config.apiKey");
  }

  if (keySources.length === 0) {
    findings.push(
      errFinding(
        "provider.key",
        "provider",
        `Missing API key for provider ${config.provider}.`,
        "No DEEPCODER_API_KEY, provider-specific env var, or config.apiKey is set.",
        `Export ${specificKeyVar}=<key> or ${genericKeyVar}=<key> or set apiKey in config.`,
      ),
    );
  } else {
    findings.push(
      okFinding(
        "provider.key",
        "provider",
        `API key found for provider ${config.provider} (${keySources[0]!}).`,
        "Key presence confirmed; value never printed.",
      ),
    );
  }

  // Model + baseUrl
  if (config.model) {
    findings.push(
      okFinding("provider.model", "provider", `Model configured: ${config.model}.`),
    );
  } else {
    findings.push(
      warnFinding(
        "provider.model",
        "provider",
        "No model configured.",
        "Using provider default, which may not be what you expect.",
        "Set model in config or via DEEPCODER_MODEL.",
      ),
    );
  }

  if (config.baseUrl) {
    findings.push(
      okFinding("provider.baseUrl", "provider", `Base URL configured: ${config.baseUrl}.`),
    );
  } else {
    findings.push(
      okFinding("provider.baseUrl", "provider", "No custom base URL — using provider default."),
    );
  }

  // Model router: warn if models config has no roles
  const routerConfig = config.models;
  if (routerConfig?.roles) {
    const roleNames = Object.keys(routerConfig.roles);
    if (roleNames.length === 0) {
      findings.push(
        warnFinding(
          "provider.router",
          "provider",
          "Model router configured but has no roles.",
          "Roles map task types to models — without them, routing is a no-op.",
          "Add roles to models.roles in .deepcoder/config.json.",
        ),
      );
    }
  }

  return findings;
}

async function collectWorkspace(input: DoctorInput): Promise<DoctorFinding[]> {
  const { workspaceRoot } = input;
  const realFs = input.fs ?? defaultFs;
  const execFile = input.execFile ?? defaultExecFile;
  const findings: DoctorFinding[] = [];

  // Workspace exists
  const stat = await realFs.stat(workspaceRoot);
  if (!stat) {
    findings.push(
      errFinding("workspace.exists", "workspace", "Workspace root does not exist.", workspaceRoot),
    );
    return findings;
  }
  if (!stat.isDirectory()) {
    findings.push(
      errFinding("workspace.exists", "workspace", "Workspace root is not a directory.", workspaceRoot),
    );
    return findings;
  }
  findings.push(okFinding("workspace.exists", "workspace", "Workspace exists and is a directory."));

  // Git repo detection
  const gitResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot });
  const isGitRepo = gitResult.stdout.trim().length > 0;
  if (isGitRepo) {
    findings.push(okFinding("workspace.git", "workspace", "Workspace is a git repository."));

    // Dirty tree
    const statusResult = await execFile("git", ["status", "--porcelain"], { cwd: workspaceRoot });
    const dirtyLines = statusResult.stdout.trim().split("\n").filter(Boolean);
    if (dirtyLines.length > 0) {
      findings.push(
        warnFinding(
          "workspace.dirty",
          "workspace",
          `Git tree is dirty (${dirtyLines.length} uncommitted change(s)).`,
          "Uncommitted changes may affect check results or workspace isolation.",
          "Commit or stash changes before running checks or delegation.",
        ),
      );
    }
  } else {
    findings.push(
      warnFinding(
        "workspace.git",
        "workspace",
        "Workspace is not a git repository.",
        "Many features (isolation, checkpoints, rollback) require git.",
        "Initialize a git repo with `git init`.",
      ),
    );
  }

  // Workspace trust
  const isTrusted = input.home
    ? await checkTrustViaFile(workspaceRoot, input.home, realFs, input.env ?? process.env)
    : false;
  if (!isTrusted) {
    findings.push(
      warnFinding(
        "workspace.trust",
        "workspace",
        "Workspace is not trusted.",
        "MCP servers and hooks configured in this workspace will not auto-run.",
        "Trust the workspace with DEEPCODER_TRUST_WORKSPACE=1 or add it to ~/.deepcoder/trusted-workspaces.",
      ),
    );
  } else {
    findings.push(
      okFinding("workspace.trust", "workspace", "Workspace is trusted."),
    );
  }

  return findings;
}

async function checkTrustViaFile(
  workspaceRoot: string,
  home: string,
  probe: FsProbeLike,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  // Check env first
  if (["1", "true", "yes"].includes((env.DEEPCODER_TRUST_WORKSPACE ?? "").toLowerCase())) {
    return true;
  }

  // Check trusted-workspaces file
  const trustedFile = path.join(home, ".deepcoder", "trusted-workspaces");
  try {
    const content = await probe.readFile(trustedFile);
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    // Simple relative comparison (in tests, we just check path equality)
    return lines.includes(workspaceRoot);
  } catch {
    return false;
  }
}

async function collectRuntime(input: DoctorInput): Promise<DoctorFinding[]> {
  const execFile = input.execFile ?? defaultExecFile;
  const findings: DoctorFinding[] = [];

  // Node version
  const nodeResult = await execFile("node", ["--version"]);
  if (nodeResult.stdout.trim()) {
    findings.push(
      okFinding("runtime.node", "runtime", `Node.js ${nodeResult.stdout.trim()}.`),
    );
  } else {
    findings.push(
      errFinding("runtime.node", "runtime", "Node.js not found.", "Node.js is required to run deepcoder.", "Install Node.js from https://nodejs.org."),
    );
  }

  // npm availability
  const npmResult = await execFile("npm", ["--version"]);
  if (npmResult.stdout.trim()) {
    findings.push(
      okFinding("runtime.npm", "runtime", `npm ${npmResult.stdout.trim()}.`),
    );
  } else {
    findings.push(
      okFinding("runtime.npm", "runtime", "npm not found — not required for all setups."),
    );
  }

  // pnpm availability (best-effort)
  const pnpmResult = await execFile("pnpm", ["--version"]);
  if (pnpmResult.stdout.trim()) {
    findings.push(
      okFinding("runtime.pnpm", "runtime", `pnpm ${pnpmResult.stdout.trim()}.`),
    );
  }

  return findings;
}

async function collectSandbox(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];

  try {
    const resolveFn = input.resolveBackend ?? resolveBackend;
    const backend = resolveFn(config.sandbox.mode, config.sandbox.fallback) as ReturnType<typeof resolveBackend>;
    findings.push(
      okFinding("sandbox.backend", "sandbox", `Resolved backend: ${backend}.`),
    );

    // Check if mode is "fast" or "bubblewrap" but resolved to "local" (degraded)
    if (
      (config.sandbox.mode === "fast" || config.sandbox.mode === "bubblewrap") &&
      backend === "local"
    ) {
      findings.push(
        warnFinding(
          "sandbox.degraded",
          "sandbox",
          `Sandbox mode "${config.sandbox.mode}" resolved to "local" because bwrap is not available.`,
          "Commands will run without isolation.",
          "Install bubblewrap or set sandbox.mode to 'local' or 'off' intentionally.",
        ),
      );
    }
  } catch (err) {
    findings.push(
      errFinding(
        "sandbox.backend",
        "sandbox",
        `Sandbox fail-closed: cannot resolve backend for mode "${config.sandbox.mode}".`,
        (err as Error).message,
        "Install the required backend or set sandbox.mode to 'fast', 'local', or 'off'.",
      ),
    );
  }

  return findings;
}

async function collectWorkspaceIsolation(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const ws = config.workspaceIsolation;

  findings.push(
    okFinding("isolation.mode", "workspace-isolation", `Workspace isolation mode: ${ws.mode}.`),
  );

  // If isolation mode requires git (patch/keep), check if workspace is a git repo
  if (ws.mode === "patch" || ws.mode === "keep") {
    const execFile = input.execFile ?? defaultExecFile;
    const gitResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: input.workspaceRoot });
    const isGitRepo = gitResult.stdout.trim().length > 0;
    if (!isGitRepo) {
      findings.push(
        warnFinding(
          "isolation.git",
          "workspace-isolation",
          `Workspace isolation mode "${ws.mode}" requires git, but workspace is not a git repository.`,
          "Isolation will fail.",
          "Initialize a git repo or set workspaceIsolation.mode to 'off'.",
        ),
      );
    } else {
      // Check dirty tree
      const statusResult = await execFile("git", ["status", "--porcelain"], { cwd: input.workspaceRoot });
      const dirtyLines = statusResult.stdout.trim().split("\n").filter(Boolean);
      if (dirtyLines.length > 0 && !ws.includeDirty) {
        findings.push(
          warnFinding(
            "isolation.dirty",
            "workspace-isolation",
            "Git tree is dirty and includeDirty is false — isolation may fail on dirty tree.",
            "Workspace isolation requires a clean git tree unless includeDirty is true.",
            "Commit or stash changes, or set workspaceIsolation.includeDirty=true.",
          ),
        );
      }
    }
  }

  return findings;
}

async function collectChecks(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const checkNames = Object.keys(config.checks);

  if (checkNames.length === 0) {
    // Warn if solve or delegation is configured
    if (config.solve || config.delegate?.autopilot?.enabled || config.delegate?.acceptanceFirst?.enabled) {
      findings.push(
        warnFinding(
          "checks.empty",
          "checks",
          "No checks configured, but solve/delegation features are enabled.",
          "Solve and delegation require at least one configured check.",
          "Add checks to .deepcoder/config.json (e.g., { \"checks\": { \"phase\": { \"command\": \"npm run test:phase\" } } }).",
        ),
      );
    } else {
      findings.push(
        okFinding("checks.empty", "checks", "No checks configured — solve/delegation not used."),
      );
    }
    return findings;
  }

  findings.push(
    okFinding("checks.count", "checks", `${checkNames.length} check(s) configured.`),
  );

  let deniedCount = 0;
  for (const name of checkNames.sort()) {
    const c = config.checks[name]!;
    const decision = classifyCommand(c.command) as ApprovalDecision;
    if (decision === "deny") {
      deniedCount++;
      findings.push(
        errFinding(
          `checks.denied.${name}`,
          "checks",
          `Check "${name}" command is denied by permission policy: ${c.command}.`,
          "This check will be blocked at runtime.",
          "Adjust the command or the permission policy.",
        ),
      );
    }
  }

  if (deniedCount === 0) {
    findings.push(
      okFinding("checks.policy", "checks", "All check commands are allowed by permission policy."),
    );
  }

  return findings;
}

async function collectMcp(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const servers = config.mcpServers;
  const serverNames = Object.keys(servers ?? {});

  if (serverNames.length === 0) {
    findings.push(
      okFinding("mcp.servers", "mcp", "No MCP servers configured."),
    );
    return findings;
  }

  const enabledServers = serverNames.filter((n) => {
    const s = servers![n]!;
    return s.enabled !== false;
  });

  findings.push(
    okFinding("mcp.servers", "mcp", `${enabledServers.length} MCP server(s) configured (${serverNames.length} total).`),
  );

  // Check execute-enabled
  if (config.mcpExecuteEnabled) {
    findings.push(
      okFinding("mcp.execute", "mcp", "MCP execute mode is enabled."),
    );
  } else {
    findings.push(
      okFinding("mcp.execute", "mcp", "MCP execute mode is disabled — read-only only."),
    );
  }

  // Validate server configs
  for (const name of enabledServers) {
    const s = servers![name]!;
    if (!s.command || s.command.trim().length === 0) {
      findings.push(
        errFinding(
          `mcp.server.${name}`,
          "mcp",
          `MCP server "${name}" has no command configured.`,
          "The command field is required for MCP server configuration.",
          `Add "command": "<executable>" to mcpServers.${name} in .deepcoder/config.json.`,
        ),
      );
    }
  }

  return findings;
}

async function collectHooks(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const hooks = config.hooks;

  if (!hooks || !hooks.enabled) {
    findings.push(
      okFinding("hooks.enabled", "hooks", "Hooks are disabled."),
    );
    return findings;
  }

  findings.push(
    okFinding("hooks.enabled", "hooks", "Hooks are enabled."),
  );

  const totalCommands = countCommands(hooks);
  if (totalCommands > 0) {
    findings.push(
      okFinding("hooks.commands", "hooks", `${totalCommands} hook command(s) configured.`),
    );
  }

  // Classify hook commands if possible
  let blockedCount = 0;
  if (hooks.events) {
    for (const [event, commands] of Object.entries(hooks.events)) {
      for (const hc of commands as { command: string }[]) {
        const decision = classifyCommand(hc.command) as ApprovalDecision;
        if (decision === "deny") {
          blockedCount++;
          findings.push(
            errFinding(
              `hooks.denied.${event}`,
              "hooks",
              `Hook command in "${event}" is denied by permission policy: ${hc.command}.`,
              "This hook will be blocked at runtime.",
              "Adjust the hook command or the permission policy.",
            ),
          );
        }
      }
    }
  }

  if (blockedCount === 0) {
    findings.push(
      okFinding("hooks.policy", "hooks", "All hook commands are allowed by permission policy."),
    );
  }

  // Warn if hooks enabled in untrusted workspace
  const env = input.env ?? process.env;
  const isTrusted =
    ["1", "true", "yes"].includes((env.DEEPCODER_TRUST_WORKSPACE ?? "").toLowerCase());
  if (!isTrusted) {
    findings.push(
      warnFinding(
        "hooks.untrusted",
        "hooks",
        "Hooks are enabled in an untrusted workspace.",
        "Hook commands run arbitrary code on session events — ensure you trust this workspace.",
        "Trust the workspace with DEEPCODER_TRUST_WORKSPACE=1 or add it to ~/.deepcoder/trusted-workspaces.",
      ),
    );
  }

  return findings;
}

async function collectPlugins(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const realFs = input.fs ?? defaultFs;
  const findings: DoctorFinding[] = [];
  const home = input.home ?? "";

  let plugins: { manifest: { name: string }; trustState: string }[] = [];
  let hadError = false;

  try {
    // Check if plugins directories exist at all
    if (home) {
      const homePluginDir = path.join(home, ".deepcoder", "plugins");
      const wsPluginDir = path.join(config.workspaceRoot, ".deepcoder", "plugins");
      const agentPluginDir = path.join(config.workspaceRoot, ".agents", "plugins");

      for (const dir of [homePluginDir, wsPluginDir, agentPluginDir]) {
        const exists = await realFs.access(dir);
        if (exists) {
          const entries = await realFs.readdir(dir);
          for (const entry of entries) {
            try {
              const pluginDir = path.join(dir, entry);
              const pluginStat = await realFs.stat(pluginDir);
              if (pluginStat && pluginStat.isDirectory()) {
                const manifestPath = path.join(pluginDir, "plugin.json");
                const manifestExists = await realFs.access(manifestPath);
                if (manifestExists) {
                  const raw = await realFs.readFile(manifestPath);
                  const parsed = JSON.parse(raw) as { name: string };
                  plugins.push({ manifest: { name: parsed.name || entry }, trustState: "untrusted" });
                } else {
                  // Missing manifest - report as malformed
                  hadError = true;
                  findings.push(
                    warnFinding(
                      `plugins.malformed.${entry}`,
                      "plugins",
                      `Plugin directory "${entry}" has no plugin.json manifest.`,
                      `Directory: ${pluginDir}`,
                      "Add a valid plugin.json to the plugin directory or remove the directory.",
                    ),
                  );
                }
              }
            } catch {
              hadError = true;
            }
          }
        }
      }
    }
  } catch (err) {
    hadError = true;
    findings.push(
      warnFinding(
        "plugins.discovery",
        "plugins",
        "Plugin discovery error.",
        (err as Error).message,
      ),
    );
  }

  if (hadError || plugins.length === 0) {
    if (plugins.length === 0 && !hadError) {
      findings.push(
        okFinding("plugins.count", "plugins", "No plugins discovered."),
      );
    } else if (plugins.length > 0) {
      findings.push(
        okFinding("plugins.count", "plugins", `${plugins.length} plugin(s) discovered.`),
      );
    }
  } else {
    findings.push(
      okFinding("plugins.count", "plugins", `${plugins.length} plugin(s) discovered.`),
    );
  }

  return findings;
}

async function collectWeb(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const web = config.web;

  if (!web.enabled) {
    findings.push(
      okFinding("web.enabled", "web", "Web access is disabled."),
    );
    return findings;
  }

  findings.push(
    okFinding("web.enabled", "web", "Web access is enabled."),
  );

  // Search provider
  if (web.searchProvider && web.searchProvider !== "none") {
    findings.push(
      okFinding("web.search", "web", `Search provider: ${web.searchProvider}.`),
    );
  } else {
    findings.push(
      warnFinding(
        "web.search",
        "web",
        "Web access enabled but searchProvider is 'none'.",
        "Web search will not work without a search provider.",
        "Set DEEPCODER_WEB_SEARCH_PROVIDER or configure web.searchProvider in config.",
      ),
    );
  }

  // Domain counts
  if (web.allowedDomains && web.allowedDomains.length > 0) {
    findings.push(
      okFinding("web.domains", "web", `${web.allowedDomains.length} allowed domain(s), ${(web.blockedDomains ?? []).length} blocked domain(s).`),
    );
  }

  return findings;
}

async function collectDelegation(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];
  const delegate = config.delegate;

  if (!delegate) {
    findings.push(
      okFinding("delegate.config", "delegation", "No delegation configuration found — delegation disabled."),
    );
    return findings;
  }

  // Quality gate
  const qg = delegate.qualityGate;
  if (qg?.enabled) {
    findings.push(
      okFinding("delegate.qualityGate", "delegation", `Quality gate enabled (mode: ${qg.mode}).`),
    );
  } else {
    findings.push(
      okFinding("delegate.qualityGate", "delegation", "Quality gate disabled."),
    );
  }

  // Acceptance-first
  const af = delegate.acceptanceFirst;
  if (af?.enabled) {
    findings.push(
      okFinding("delegate.acceptanceFirst", "delegation", "Acceptance-first (TDD) enabled."),
    );
  } else {
    findings.push(
      okFinding("delegate.acceptanceFirst", "delegation", "Acceptance-first (TDD) disabled."),
    );
  }

  // Worker runner prerequisites
  const execFile = input.execFile ?? defaultExecFile;
  const gitResult = await execFile("git", ["rev-parse", "--show-toplevel"], { cwd: input.workspaceRoot });
  const hasGit = gitResult.stdout.trim().length > 0;
  const hasChecks = Object.keys(config.checks).length > 0;

  if (!hasGit) {
    findings.push(
      warnFinding(
        "delegate.git",
        "delegation",
        "Delegation requires git for worker isolation, but workspace is not a git repository.",
        "Worker runs use isolated worktrees which require git.",
        "Initialize a git repo with `git init`.",
      ),
    );
  }

  if (config.delegate?.autopilot?.enabled) {
    if (!hasChecks) {
      findings.push(
        warnFinding(
          "delegate.checks",
          "delegation",
          "Autopilot is enabled but no checks are configured.",
          "Autopilot requires at least one check to verify worker results.",
          "Add checks to .deepcoder/config.json.",
        ),
      );
    }
  }

  return findings;
}

async function collectTelemetry(input: DoctorInput): Promise<DoctorFinding[]> {
  const { config } = input;
  const findings: DoctorFinding[] = [];

  if (config.telemetry?.costs) {
    findings.push(
      okFinding("telemetry.costs", "telemetry", "Cost tracking is enabled."),
    );

    // Check pricing known
    const pricing = findPricing(config.provider, config.model, config.telemetry.pricing);
    if (pricing) {
      findings.push(
        okFinding(
          "telemetry.pricing",
          "telemetry",
          `Pricing known for ${config.provider}/${config.model}.`,
          `Input: $${pricing.inputPerMillionUsd}/M tokens, Output: $${pricing.outputPerMillionUsd}/M tokens.`,
        ),
      );
    } else {
      findings.push(
        warnFinding(
          "telemetry.pricing",
          "telemetry",
          `Pricing unknown for ${config.provider}/${config.model}.`,
          "Cost estimates will show 'unknown'.",
          "Add pricing overrides to telemetry.pricing in config, or the model may be unrecognized.",
        ),
      );
    }
  } else {
    findings.push(
      okFinding("telemetry.costs", "telemetry", "Cost tracking is disabled."),
    );
  }

  return findings;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const collectors = [
    collectProvider,
    collectWorkspace,
    collectRuntime,
    collectSandbox,
    collectWorkspaceIsolation,
    collectChecks,
    collectMcp,
    collectHooks,
    collectPlugins,
    collectWeb,
    collectDelegation,
    collectTelemetry,
  ];

  const allFindings: DoctorFinding[] = [];

  for (const collector of collectors) {
    const findings = await collector(input);
    allFindings.push(...findings);
  }

  // Sort: errors first, then warnings, then ok; within same level, sort by section then id
  const severityOrder: Record<DoctorLevel, number> = { error: 0, warn: 1, ok: 2 };
  allFindings.sort((a, b) => {
    const levelDiff = severityOrder[a.level] - severityOrder[b.level];
    if (levelDiff !== 0) return levelDiff;
    const sectionDiff = a.section.localeCompare(b.section);
    if (sectionDiff !== 0) return sectionDiff;
    return a.id.localeCompare(b.id);
  });

  const summary = { ok: 0, warn: 0, error: 0 };
  for (const f of allFindings) {
    summary[f.level]++;
  }

  return {
    ok: summary.error === 0,
    summary,
    findings: allFindings,
  };
}

// ── Formatter ─────────────────────────────────────────────────────────────────

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  const total = report.summary.ok + report.summary.warn + report.summary.error;
  const summaryParts: string[] = [];
  if (report.summary.error > 0) summaryParts.push(`${report.summary.error} error(s)`);
  if (report.summary.warn > 0) summaryParts.push(`${report.summary.warn} warning(s)`);
  if (report.summary.ok > 0) summaryParts.push(`${report.summary.ok} ok`);
  const summaryLine = `Doctor: ${summaryParts.join(" · ")} (${total} total)`;
  lines.push(summaryLine);
  lines.push("");

  for (const f of report.findings) {
    const prefix = f.level === "error" ? "ERR" : f.level === "warn" ? "WARN" : "OK ";
    const section = f.section.padEnd(20);
    lines.push(`${prefix} ${section} ${f.title}`);
    if (f.details) {
      lines.push(`     ${f.details}`);
    }
    if (f.fix) {
      lines.push(`     Fix: ${f.fix}`);
    }
  }

  return lines.join("\n");
}
