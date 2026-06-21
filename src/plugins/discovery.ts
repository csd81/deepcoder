import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Plugin, PluginManifest, PluginSource, LoadResult } from "./types.js";

const KNOWN_MANIFEST_KEYS = new Set([
  "schemaVersion",
  "name",
  "version",
  "description",
  "capabilities",
  "skills",
  "checks",
]);

/**
 * Load a single plugin from its directory by reading <dir>/plugin.json,
 * validating the manifest, and returning a LoadResult.
 */
export async function loadPlugin(
  dir: string,
  opts: { workspaceRoot: string; home: string },
): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, "plugin.json"), "utf-8");
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        ok: false,
        error: { kind: "not_found", message: `No plugin.json found in ${dir}` },
      };
    }
    return {
      ok: false,
      error: { kind: "read_error", message: `Failed to read plugin.json in ${dir}: ${e.message}` },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: `plugin.json in ${dir} is not valid JSON` },
    };
  }

  // Validate schemaVersion must be exactly 1
  if (parsed.schemaVersion !== 1) {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: `schemaVersion must be 1, got ${JSON.stringify(parsed.schemaVersion)}` },
    };
  }

  // Validate name is a non-empty string
  if (typeof parsed.name !== "string" || parsed.name.length === 0) {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: "name must be a non-empty string" },
    };
  }

  // Validate version is a non-empty string
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: "version must be a non-empty string" },
    };
  }

  // Validate description is a non-empty string
  if (typeof parsed.description !== "string" || parsed.description.length === 0) {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: "description must be a non-empty string" },
    };
  }

  // Validate capabilities is an array
  if (!Array.isArray(parsed.capabilities)) {
    return {
      ok: false,
      error: { kind: "invalid_manifest", message: "capabilities must be an array" },
    };
  }

  const manifest: PluginManifest = parsed as PluginManifest;

  // Determine source: "workspace" if dir is under workspaceRoot, else "user" if under home.
  // When under BOTH (workspaceRoot === home), prefer "workspace".
  let source: PluginSource = "user";
  const relToWs = path.relative(opts.workspaceRoot, dir);
  if (!relToWs.startsWith("..") && !path.isAbsolute(relToWs)) {
    source = "workspace";
  } else {
    const relToHome = path.relative(opts.home, dir);
    if (!relToHome.startsWith("..") && !path.isAbsolute(relToHome)) {
      source = "user";
    }
  }

  // Collect warnings for unknown fields
  const warnings: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      warnings.push(`Unknown manifest field "${key}"`);
    }
  }

  const plugin: Plugin = {
    manifest,
    dir,
    source,
    trustState: "untrusted",
    warnings,
  };

  return { ok: true, plugin };
}

/**
 * Security gate for plugin-referenced paths (skills, checks, etc.).
 * Resolves a relative path against pluginDir, rejecting absolute paths
 * and any path that escapes outside the plugin directory.
 * Operates purely on path normalization — does NOT access the filesystem.
 */
export async function assertPluginRelativePath(
  pluginDir: string,
  rel: string,
): Promise<string> {
  // Reject absolute paths
  if (path.isAbsolute(rel)) {
    throw new Error(`Path must be relative, got absolute path "${rel}"`);
  }

  // Resolve against pluginDir and check it stays inside
  const resolved = path.resolve(pluginDir, rel);
  const normalizedPluginDir = path.normalize(pluginDir) + path.sep;

  if (!resolved.startsWith(normalizedPluginDir)) {
    throw new Error(
      `Path "${rel}" resolves outside plugin directory "${pluginDir}"`,
    );
  }

  return resolved;
}

/**
 * Discover plugins from the three standard root directories:
 * - <home>/.deepcoder/plugins/*       -> source "user"
 * - <workspaceRoot>/.deepcoder/plugins/*  -> source "workspace"
 * - <workspaceRoot>/.agents/plugins/*     -> source "workspace" (alias root)
 *
 * Missing root dirs are silently skipped. Invalid manifests are skipped.
 * Shadowed duplicates (same name from different sources) are all kept.
 */
export async function discoverPlugins(
  workspaceRoot: string,
  home: string,
): Promise<Plugin[]> {
  const rootDirs: { dir: string; source: PluginSource }[] = [
    { dir: path.join(home, ".deepcoder", "plugins"), source: "user" },
    { dir: path.join(workspaceRoot, ".deepcoder", "plugins"), source: "workspace" },
    { dir: path.join(workspaceRoot, ".agents", "plugins"), source: "workspace" },
  ];

  const plugins: Plugin[] = [];

  for (const { dir: rootDir, source } of rootDirs) {
    let entries: string[];
    try {
      entries = await readdir(rootDir, { withFileTypes: false });
    } catch {
      // Missing or unreadable root dir is simply skipped
      continue;
    }

    for (const entry of entries) {
      const pluginDir = path.join(rootDir, entry);
      const result = await loadPlugin(pluginDir, { workspaceRoot, home });

      if (!result.ok) {
        // Invalid manifests are skipped (not thrown)
        continue;
      }

      // Override source to match the root dir we're scanning
      result.plugin.source = source;
      plugins.push(result.plugin);
    }
  }

  return plugins;
}
