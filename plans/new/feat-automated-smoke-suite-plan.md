# Feature — Automated smoke-test suite

## Context

Deepcoder has unit tests, adversarial tests, and an eval bench. But no automated **smoke tests** that exercise the real agent loop against a battery of prompts and check for crashes, hangs, or error regressions. Crashes are discovered manually during development. A daily smoke suite would catch regressions the morning after they're introduced.

The faux provider (`test/helpers/fauxProvider.ts`) already exists — tests use it to run the agent loop without real API keys. The smoke suite would reuse it.

## Model

- A smoke test runs deepcoder one-shot against N prompts using the faux provider, with a timeout.
- Each prompt is an actual user scenario: file read, search, edit, permissions, error recovery.
- Results: pass (clean exit within timeout), fail (nonzero exit, crash, hang).
- Runs via `npm run smoke` — no API key needed, no network.
- Runs in CI (GitHub Actions cron) daily on `master`.

## Design

### 1. Smoke list (`scripts/smoke-prompts.json`)

```json
[
  { "name": "list-files", "prompt": "list all TypeScript files under src", "mode": "readonly" },
  { "name": "read-file", "prompt": "read src/cli/main.ts and summarize what it does", "mode": "readonly" },
  { "name": "grep-search", "prompt": "find all places where process.env is accessed", "mode": "readonly" },
  { "name": "permission-ask", "prompt": "run ls in the workspace" },
  { "name": "edit-dry-run", "prompt": "explain what would change if I renamed displayPath to formatPath" },
  { "name": "error-recovery", "prompt": "read a non-existent file and tell me what happened", "mode": "readonly" },
  { "name": "tool-refusal", "prompt": "run sudo rm -rf /" },
  { "name": "slash-help", "prompt": "/help" },
  { "name": "slash-doctor", "prompt": "/doctor" },
  { "name": "empty-prompt", "prompt": "", "mode": "readonly" }
]
```

Expandable — add real crashes as they're discovered.

### 2. Runner (`scripts/smoke.ts`)

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";

const exec = promisify(execFile);

interface SmokeCase {
  name: string;
  prompt: string;
  mode?: string;
  timeout?: number;
}

interface SmokeResult {
  name: string;
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  error?: string;
  signal?: string;
}

async function runCase(c: SmokeCase): Promise<SmokeResult> {
  const start = Date.now();
  const args = ["--mode", c.mode ?? "auto"];

  if (c.prompt) args.push(c.prompt);

  try {
    await exec("node", [
      "--import", "tsx",
      "src/cli/main.ts",
      ...args,
    ], {
      cwd: process.cwd(),
      timeout: c.timeout ?? 30_000,
      env: { ...process.env, DEEPCODER_PROVIDER: "faux" },
    });
    return { name: c.name, passed: true, exitCode: 0, durationMs: Date.now() - start };
  } catch (err: any) {
    return {
      name: c.name,
      passed: false,
      exitCode: err.code ?? err.status ?? null,
      durationMs: Date.now() - start,
      error: err.stderr?.slice(0, 500) ?? err.message,
      signal: err.signal,
    };
  }
}

async function main() {
  const cases: SmokeCase[] = JSON.parse(await readFile("scripts/smoke-prompts.json", "utf8"));
  let passed = 0, failed = 0;

  for (const c of cases) {
    process.stdout.write(`  ${c.name} … `);
    const result = await runCase(c);
    if (result.passed) { passed++; process.stdout.write("✓\n"); }
    else { failed++; process.stdout.write(`✗ (exit ${result.exitCode}${result.signal ? ` ${result.signal}` : ""})\n`); }
  }

  console.log(`\n${passed + failed} cases: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
```

### 3. Faux provider env

Add the faux provider to the provider factory (`src/providers/factory.ts`):

```ts
case "faux":
  return new (await import("../../test/helpers/fauxProvider.js")).FauxProvider();
```

Or simpler: set `DEEPCODER_PROVIDER=faux` in the smoke runner's env and add the case. The faux provider already exists in `test/helpers/fauxProvider.ts`.

### 4. npm script (`package.json`)

```json
"smoke": "node scripts/smoke.ts"
```

### 5. CI (`.github/workflows/smoke.yml`)

```yaml
name: Daily smoke
on:
  schedule:
    - cron: "0 6 * * *"   # daily 6 AM
  workflow_dispatch:       # manual trigger

jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20" }
      - run: npm ci --ignore-scripts
      - run: npm run smoke
```

### 6. Extensions (future)

- **Crash regression**: when a real crash is found, add its prompt to the suite.
- **Timing regression**: track duration per case, alert on 2x+ slowdown.
- **Adversarial fuzz**: generate random inputs (long paths, unicode, binary) via a script that mutates the prompt list.

## Files

- **New:** `scripts/smoke.ts`, `scripts/smoke-prompts.json`, `.github/workflows/smoke.yml`.
- **Edit:** `src/providers/factory.ts` (add `"faux"` case), `package.json` (add `smoke` script).

## Tests

- The smoke suite IS the test — run it and confirm all cases pass.
- Add a known-broken prompt to verify the runner reports failure correctly.

## Verification

1. `npm run typecheck` clean.
2. `npm run smoke` → all cases pass, exits 0.
3. Temporarily break deepcoder (e.g., add a syntax error in main.ts) → `npm run smoke` → exits 1 with failures.
4. CI: trigger `workflow_dispatch` on the GitHub repo → smoke runs and reports.

## Safety

- Uses the faux provider — zero API cost, zero network, no secrets.
- Hard 30s timeout per case — no hanging processes.
- Runs in CI only on schedule or manual trigger — never blocks PRs.
