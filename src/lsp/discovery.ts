/**
 * LSP server discovery (pure + a filesystem probe for workspace-local binaries).
 *
 * Maps a file to its language id and resolves which server command to launch,
 * with config overrides winning over built-in defaults. No process spawning here
 * (that's manager.ts) — this stays cheap and easy to test.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { LspConfig, LspServerSpec } from "./types.js";

/** Extension → LSP language id. TS server also drives JS files. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".pyi": "python",
};

/** The language id for a file, or null when no LSP server is mapped to it. */
export function languageForFile(absFile: string): string | null {
  return EXT_TO_LANGUAGE[path.extname(absFile).toLowerCase()] ?? null;
}

/** Built-in server commands (overridable via config.servers). */
const DEFAULT_SERVERS: Record<string, { command: string; args: string[] }> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] },
  python: { command: "pyright-langserver", args: ["--stdio"] },
};

/**
 * Resolve the launch spec for a language: a `config.servers[language]` override
 * wins, else the built-in default. Prefers a workspace-local
 * `node_modules/.bin/<command>` when present, else relies on PATH. Returns null
 * when no command is known for the language.
 */
export function resolveServerSpec(
  language: string,
  workspaceRoot: string,
  config: LspConfig,
): LspServerSpec | null {
  const base = config.servers?.[language] ?? DEFAULT_SERVERS[language];
  if (!base) return null;
  const local = path.join(workspaceRoot, "node_modules", ".bin", base.command);
  const command = existsSync(local) ? local : base.command;
  return { language, command, args: [...base.args] };
}
