import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "../workspace/paths.js";

export async function saveManagedOutput(workspaceRoot: string, content: string): Promise<string> {
  const id = randomUUID();
  const dir = path.join(workspaceRoot, ".deepcoder", "outputs");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `output-${id}.log`), content, "utf8");
  return id;
}

export async function readManagedOutput(
  workspaceRoot: string,
  outputId: string,
  opts?: { startLine?: number; endLine?: number },
): Promise<string> {
  // Validate outputId: must be a plain UUID (no path separators, no dots for traversal).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(outputId)) {
    throw new Error(`Invalid output ID "${outputId}".`);
  }
  const relPath = `.deepcoder/outputs/output-${outputId}.log`;
  let absPath: string;
  try {
    absPath = resolveInWorkspace(workspaceRoot, relPath);
  } catch {
    throw new Error(`Invalid output ID "${outputId}": path escapes workspace.`);
  }
  // Double-check the resolved path is still within the outputs dir.
  const outputsDir = path.resolve(workspaceRoot, ".deepcoder", "outputs");
  if (!absPath.startsWith(outputsDir + path.sep) && absPath !== outputsDir) {
    throw new Error(`Invalid output ID "${outputId}": path escapes outputs directory.`);
  }
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    throw new Error(`Output "${outputId}" not found.`);
  }
  if (opts?.startLine !== undefined || opts?.endLine !== undefined) {
    const lines = content.split("\n");
    // A trailing newline produces a phantom empty final element; drop it so line
    // counts/slices match the visible lines (and a default endLine = last line).
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(total, opts.endLine ?? total);
    if (start > total || end < start) {
      return "";
    }
    return lines.slice(start - 1, end).join("\n");
  }
  return content;
}
