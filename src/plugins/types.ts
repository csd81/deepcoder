export interface PluginManifest {
  schemaVersion: 1; // ONLY 1 is valid
  name: string;
  version: string;
  description: string;
  capabilities: string[]; // e.g. ["skills","checks"]
  skills?: { path: string }[];
  checks?: Record<string, { command: string; timeoutMs?: number }>;
  // unknown extra fields are allowed but produce a warning naming the field
  [key: string]: unknown;
}

export type PluginSource = "user" | "workspace";

export type PluginTrustState = "untrusted" | "trusted";

export interface Plugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  trustState: PluginTrustState; // ALWAYS "untrusted" from discovery (trust is granted elsewhere)
  warnings: string[];
}

export type LoadResult =
  | { ok: true; plugin: Plugin }
  | { ok: false; error: { kind: "invalid_manifest" | "not_found" | "read_error"; message: string } };
