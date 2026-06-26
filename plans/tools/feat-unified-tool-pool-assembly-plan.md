# feat: Unified tool-pool assembly pipeline

## Problem

deepcoder's tool surface is assembled in several places:

- `defaultRegistry()` registers native tools in `src/tools/registry.ts`.
- `buildSession()` conditionally registers semantic, web, PTY, LSP, and MCP
  tools in `src/runtime/sessionFactory.ts`.
- `McpManager.registerInto()` mutates an existing registry.
- Subagents use `restrictedRegistry()` for native-only restricted tool sets.
- Skills/plugins can contribute related capabilities through separate paths.

This works today, but future work needs a single assembly chokepoint:

- deferred tool schemas need to hide/expose schemas consistently,
- declarative deny/ask/allow rules need pre-filtering before the model sees
  forbidden tools,
- plugin-contributed tools/MCP/LSP/hooks need predictable precedence,
- subagents need the same filtering logic with smaller capability sets,
- duplicate names and MCP/plugin namespace collisions need one policy.

Claude Code's reported `assembleToolPool()` centralizes base tool enumeration,
mode filtering, deny pre-filtering, MCP integration, deduplication, and deferred
tool handling. DeepCoder should grow an equivalent, adapted to its deterministic
permission and containment model.

## Goal

Create a single tool-pool assembly pipeline that builds the model-visible and
runtime-executable tool registry from all sources.

The first version should preserve current behavior when no new filters are
enabled, then become the shared integration point for:

- native tools,
- optional built-ins,
- MCP tools,
- plugin-contributed tools or tool providers,
- mode/context filtering,
- deny-rule prefiltering,
- deduplication,
- deferred schema exposure.

## Non-goals

- Do not change tool execution semantics.
- Do not weaken `checkPermission()`.
- Do not enable execute-kind MCP tools by default.
- Do not require plugins to contribute executable tools in phase 1.
- Do not remove `ToolRegistry` immediately; wrap and evolve it.

## Design

Add:

```ts
// src/tools/assembly.ts
export interface ToolAssemblyInput {
  config: Config;
  mode: ApprovalMode;
  workspaceRoot: string;
  mcp?: McpManager;
  lsp?: LspRuntime;
  pluginContributions?: PluginToolContribution[];
  subagent?: {
    allowedTools: string[];
    readonly: boolean;
  };
  deferred?: {
    enabled: boolean;
    exposed: Set<string>;
  };
}

export interface ToolAssemblyResult {
  registry: ToolRegistry;
  catalog: ToolCatalogEntry[];
  hidden: ToolHiddenRecord[];
  warnings: string[];
}

export async function assembleToolPool(input: ToolAssemblyInput): Promise<ToolAssemblyResult>
```

`ToolRegistry` remains the execution lookup and schema producer, but tool
construction moves into `assembleToolPool()`.

## Pipeline stages

### 1. Base native enumeration

Move the native list out of `registry.ts` into an exported source:

```ts
export function nativeToolDefinitions(): Tool[]
```

All current native tools remain included unless filtered later:

- file/search/edit/bash/todo/context/repo tools,
- `activate_skill`,
- `apply_patch`,
- `delegate`,
- worktree tools,
- `read_managed_output`.

### 2. Optional built-in tools

Add optional tool providers:

- semantic search,
- web tools,
- PTY interactive shell,
- LSP tools,
- future browser/computer tools.

Each provider returns:

```ts
interface ToolContribution {
  tool: Tool;
  source: "native" | "semantic" | "web" | "pty" | "lsp" | "mcp" | "plugin";
  priority: number;
  defaultDeferred?: boolean;
  enabled: boolean;
  reason?: string;
}
```

Disabled optional tools produce `hidden` records for `/tools` diagnostics, not
silent disappearance.

### 3. Plugin contributions

Phase 1:

- plugins may contribute skills/checks/config as today,
- assembly receives plugin metadata only for diagnostics.

Phase 2:

- trusted plugins may contribute tool providers or MCP server definitions,
- untrusted workspace plugins cannot add executable tools until trusted,
- plugin tool names are namespaced or conflict-checked.

### 4. MCP integration

`McpManager.tools()` returns MCP `ToolContribution[]` instead of directly
registering into the registry.

Rules:

- sanitize and de-collide MCP names,
- preserve server mode as read-only vs execute,
- mark MCP tools deferred by default once deferred schemas are enabled,
- execute-kind MCP remains denied by `checkPermission()` unless explicitly
  enabled.

### 5. Mode/context filtering

Apply filters before model exposure:

- `readonly` sessions can hide obvious mutate/execute tools if configured,
  while still relying on `checkPermission()` as the final gate.
- subagents apply `allowedTools` and native-only/read-only constraints.
- headless/special modes can hide interactive-only tools.
- disabled config families hide their tools.

Filtering should produce `hidden` diagnostics:

```ts
{ name, source, reason: "disabled_by_config" | "subagent_restricted" | ... }
```

### 6. Declarative deny pre-filtering

Once declarative permission rules exist, assembly should pre-filter blanket-denied
tools before the model sees them.

Examples:

- deny all `run_bash`,
- deny all tools from `mcp__github`,
- deny all web tools.

Important: pre-filtering is an optimization and UX improvement only. Runtime
`checkPermission()` still enforces policy.

### 7. Deduplication and precedence

One deterministic policy:

1. native built-ins win over everything else,
2. trusted plugin tools win over MCP tools only if explicitly configured,
3. MCP conflicts are suffixed deterministically,
4. untrusted/disabled contributions are hidden with warnings.

Do not allow a plugin/MCP tool to shadow a native safety-critical tool like
`run_bash`, `read_file`, `edit_file`, `write_file`, `apply_patch`, or
`delegate`.

### 8. Deferred exposure

Integrate with `plans/new/feat-deferred-tool-schemas-plan.md`:

- registry contains all executable tools,
- provider schema list includes only always-on + exposed tools,
- catalog lists deferred tools,
- unexposed deferred tools cannot execute if somehow called.

The assembly result should include both:

```ts
registry.schemas({ exposed })
catalog
```

## Integration points

Replace current session setup:

```ts
const registry = defaultRegistry();
if (config.semanticSearch.enabled) ...
for (const t of createWebTools(...)) registry.register(t);
for (const t of createPtyTools(...)) registry.register(t);
if (config.lsp.enabled) ...
const mcp = await initMcp(config, registry);
```

with:

```ts
const mcp = await initMcp(config);
const assembled = await assembleToolPool({ config, mode, workspaceRoot, mcp, lsp });
const registry = assembled.registry;
```

Subagents:

```ts
assembleToolPool({
  config,
  mode: "readonly",
  subagent: { allowedTools: profile.allowedTools, readonly: true },
})
```

This replaces ad hoc `restrictedRegistry()` over time.

## Diagnostics

Add or extend `/tools` output:

- visible tools,
- deferred tools,
- hidden tools with reasons,
- source family counts,
- conflicts/dedup decisions,
- MCP server/tool status.

This is important because central assembly otherwise makes tool disappearance
hard to debug.

## Safety invariants

1. Runtime permission policy remains the final authority.
2. Hidden/pre-filtered tools cannot be called by normal provider schema exposure.
3. If a hidden tool is somehow called, execution is blocked before `tool.build()`
   or returns a synthetic error.
4. Native safety-critical tools cannot be shadowed.
5. MCP execute tools remain denied by default.
6. Subagent registries cannot accidentally include mutating/executing tools unless
   explicitly allowed and still policy-gated.
7. Feature flag off preserves current tool list and schema behavior.
8. Assembly is deterministic for the same config/MCP/plugin inputs.

## Tests

Unit:

- Assembly with default config matches current `defaultRegistry()` plus existing
  optional registrations.
- Optional disabled tools appear in `hidden` diagnostics.
- Native tools win conflicts.
- MCP duplicate names de-collide deterministically.
- Subagent assembly restricts to allowed native read-only tools.
- Deferred schema mode hides deferred schemas but keeps catalog entries.
- Blanket deny prefilter hides matching tools once rules exist.

Adversarial:

- MCP/plugin tries to shadow `run_bash`; native tool remains.
- Untrusted plugin cannot add executable tool.
- Hidden tool call cannot execute.
- Deferred unexposed tool call cannot execute.
- Deny prefilter cannot be bypassed by MCP server-prefix naming tricks.
- Assembly diagnostics do not leak secrets from config/env.

Integration:

- Session startup builds registry through `assembleToolPool()`.
- MCP reload rebuilds the registry without stale wrappers.
- Subagent run uses assembled restricted registry and remains read-only.
- `/tools` explains visible/deferred/hidden tool counts.

Gate:

- `npm run test:phase` green.

## Phasing

1. **No-op assembly wrapper:** implement `assembleToolPool()` that reproduces
   current native tool list.
2. **Move optional built-ins:** semantic/web/PTY/LSP registration moves into
   assembly.
3. **MCP contribution mode:** `McpManager` returns contributions; assembly
   registers them.
4. **Diagnostics:** add visible/hidden/source counts.
5. **Subagent assembly:** replace `restrictedRegistry()` usage or make it call
   assembly internally.
6. **Deferred schema integration:** wire catalog/exposed state.
7. **Deny prefilter integration:** after declarative permission rules land.
8. **Plugin tool contributions:** trusted plugin tool providers.

## Effort / risk

Medium-large, medium risk. This touches session startup and every tool surface,
but it can be landed safely as a no-op wrapper first, then move one tool family
at a time. The primary risk is accidentally changing the tool list; tests should
snapshot visible tool names before and after each migration phase.

## Status

**Phases 1–4 IMPLEMENTED** (native enumeration + optional built-ins + MCP through one
chokepoint, dedup/precedence safety, diagnostics). Phases 5–8 (subagent assembly,
deferred-schema integration, deny prefilter, plugin tool contributions) remain proposed.

Implementation notes:
- New `src/tools/assembly.ts` — `assembleToolPool(input): ToolAssemblyResult`
  (`{registry, catalog, hidden, warnings}`). Deterministic **earlier-wins** dedup
  (native is first) + a `RESERVED_NATIVE_NAMES` set so a non-native source can NEVER
  take a safety-critical native name (`read_file`/`write_file`/`edit_file`/`run_bash`/
  `apply_patch`/`delegate`/`delete_file`/`rename_file`) regardless of order. Optional
  `subagent.allowedTools` and `hideKinds` filters; every dropped tool yields a `hidden`
  record (reason) — no silent disappearance. `nativeToolDefinitions()` exported from
  `registry.ts`.
- `buildSession` now gathers contributions in precedence order (native → semantic → web
  → pty → lsp → mcp) and builds the registry through `assembleToolPool`. The optional
  factories return `[]` when their flag is off exactly as before, so **the visible tool
  list/order is byte-identical for every real config** (proven by a `defaultRegistry`
  parity test + the session-factory/MCP suites). `initMcp` is now connect-only; MCP
  tools join as contributions via `mcp.tools()` (dedup-protected) — the `/mcp` reload
  path still uses `registerInto` directly (prefix-safe).
- **Deviation from the plan (intentional, lower-risk):** `assembleToolPool` is a pure
  function over *pre-gathered* contributions rather than fetching MCP/LSP itself —
  `buildSession` keeps owning the config/LSP/MCP lifecycle. Same chokepoint, smaller
  blast radius.
- Tests: `test/tool-assembly.test.ts` (7 unit — defaultRegistry parity, catalog/source,
  earlier-wins collision, reserved-name refusal, subagent restriction, hideKinds, order)
  + `test/adversarial/tool-assembly.test.ts` (6 — MCP/plugin can't shadow any
  safety-critical native, hidden tool absent from `names()`/`schemas()`, reserved name
  refused with no native present, subagent excludes mutate/execute, determinism,
  diagnostics shape).

Deferred: subagent `restrictedRegistry` still in use (assembly already supports
`subagent` input — Phase 5 will route it through); deferred-schema exposure
(`registry.schemas({exposed})` + catalog) lands with `feat-deferred-tool-schemas`; deny
prefilter waits on declarative permission rules; a `/tools` diagnostics command (the
catalog/hidden/warnings data already exists) and plugin tool providers remain.
