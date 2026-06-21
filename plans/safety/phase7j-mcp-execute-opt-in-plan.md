# Phase 7J — MCP Execute Opt-In

Status: shipped retroactively by `eb4e4bc feat: make mcpExecuteEnabled opt-in via DEEPCODER_MCP_EXECUTE (was hardwired off)`.

## Context

MCP support existed, but execution was effectively hardwired off. That fail-closed default was safe, but it made the configuration field inert and prevented trusted local setups from enabling MCP execution intentionally.

The correct shape is the same as other high-risk features in Deepcoder: default disabled, explicit opt-in, test-guarded configuration parsing.

## Goal

Add an explicit MCP execution switch that:

- defaults to disabled,
- can be enabled only through an explicit environment variable/config path,
- keeps untrusted workspaces fail-closed,
- does not silently enable MCP execution because MCP servers are configured.

## Design

Configuration:

- `mcpExecuteEnabled` remains false by default.
- `DEEPCODER_MCP_EXECUTE=1` / truthy config enables execution.
- Non-truthy or absent values keep execution disabled.

Security rules:

- The presence of MCP servers does not imply execution permission.
- Workspace trust checks still apply independently.
- The opt-in controls execution capability, not discovery of MCP configuration.
- Tests must prove default-deny.

## Verification

Required tests:

- default config disables MCP execution,
- env opt-in enables MCP execution,
- falsey env/config values do not enable it,
- unrelated config fields do not affect the gate.

Shipped verification:

- `test/mcp-execute-config.test.ts`
- Full phase gate in the shipping commit.

## Follow-Ups

- Add `/mcp status` detail showing whether execution is disabled by trust, config, or both.
- Surface MCP execution state in the TUI status bar.
- Consider per-server allowlists once execution is used more broadly.
