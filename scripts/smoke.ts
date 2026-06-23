#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);

export interface SmokeCase {
  name: string;
  prompt: string;
  mode?: string;
  timeout?: number;
}

export interface SmokeResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  signal?: string;
}

export type Executor = (c: SmokeCase, timeout: number) => Promise<{ exitCode: number | null; signal?: string; stderr?: string }>;

/**
 * Default executor: runs deepcoder CLI as a subprocess with the faux provider.
 * No API key needed, no network.
 */
export async function defaultExecutor(c: SmokeCase, timeout: number): Promise<{ exitCode: number | null; signal?: string; stderr?: string }> {
  const args = ["--import", "tsx", "src/cli/main.ts", "--mode", c.mode ?? "auto"];
  if (c.prompt) args.push(c.prompt);
  try {
    await exec("node", args, {
      timeout,
      env: { ...process.env, DEEPCODER_PROVIDER: "faux" },
    });
    return { exitCode: 0 };
  } catch (err: any) {
    return {
      exitCode: err.code ?? err.status ?? null,
      signal: err.signal,
      stderr: err.stderr,
    };
  }
}

/**
 * Run a single smoke case with the given executor.
 * Returns a SmokeResult summarising pass/fail.
 */
export async function runCase(
  c: SmokeCase,
  execute: Executor = defaultExecutor,
): Promise<SmokeResult> {
  const start = Date.now();
  const timeout = c.timeout ?? 30_000;
  try {
    const r = await execute(c, timeout);
    const durationMs = Date.now() - start;
    if (r.exitCode === 0) {
      return { name: c.name, passed: true, exitCode: 0, durationMs };
    }
    return {
      name: c.name,
      passed: false,
      exitCode: r.exitCode,
      durationMs,
      error: r.stderr?.slice(0, 4000),
      signal: r.signal,
    };
  } catch (err: any) {
    return {
      name: c.name,
      passed: false,
      exitCode: null,
      durationMs: Date.now() - start,
      error: err.message,
      signal: err.signal,
    };
  }
}

/**
 * Render one result as a console line. On failure, the captured stderr is
 * printed (indented) beneath the status — without this, a CI crash shows only
 * "✗ (exit 1)" with no clue why, which is undiagnosable from the logs.
 */
export function formatResultLine(r: SmokeResult): string {
  if (r.passed) return `  ${r.name} … ✓`;
  let line = `  ${r.name} … ✗ (exit ${r.exitCode}${r.signal ? ` ${r.signal}` : ""})`;
  const detail = r.error?.trim();
  if (detail) {
    line += "\n" + detail.split("\n").map((l) => `      ${l}`).join("\n");
  }
  return line;
}

async function main() {
  const cases: SmokeCase[] = JSON.parse(
    await readFile(new URL("smoke-prompts.json", import.meta.url), "utf8"),
  );
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    const result = await runCase(c);
    if (result.passed) passed++;
    else failed++;
    console.log(formatResultLine(result));
  }

  console.log(`\n${passed + failed} cases: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Run only when invoked directly (`npm run smoke`). Importing this module (e.g.
// from test/smoke.test.ts) must NOT execute the battery or call process.exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
