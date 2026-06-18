import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** A fixture secret value used across safety tests. */
export const FIXTURE_SECRET = "sk-FIXTURE-SECRET-DONOTLEAK-0001";

/** Assert no fixture secret and no generic key-shaped token appears in `text`. */
export function assertNoSecrets(text: string, msg = "output leaked a secret"): void {
  assert.ok(!text.includes(FIXTURE_SECRET), `${msg}: fixture secret present`);
  assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(text), `${msg}: key-shaped token present`);
}

/**
 * Build a temp workspace containing an in-workspace symlink (`link`) that points
 * at a file OUTSIDE the workspace holding the fixture secret. Returns the
 * workspace root and the relative symlink name — for testing that a read surface
 * refuses to follow it.
 */
export async function symlinkEscapeWorkspace(linkName = "link.txt"): Promise<{ root: string; link: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "safety-ws-"));
  const outside = await mkdtemp(path.join(tmpdir(), "safety-out-"));
  await writeFile(path.join(outside, "secret.txt"), FIXTURE_SECRET, "utf8");
  await symlink(path.join(outside, "secret.txt"), path.join(root, linkName));
  return { root, link: linkName };
}

/** A temp workspace with an in-workspace `.env` holding the fixture secret. */
export async function workspaceWithEnv(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "safety-env-"));
  await writeFile(path.join(root, ".env"), `DEEPSEEK_API_KEY=${FIXTURE_SECRET}\n`, "utf8");
  return root;
}
