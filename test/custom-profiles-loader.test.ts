import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverCustomProfiles, mergeProfiles } from "../src/subagents/customProfiles.js";
import { PROFILES, READ_ONLY_TOOLS } from "../src/subagents/profiles.js";

test("custom profiles loader", async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "custom-profiles-test-"));
  
  await t.test("loads valid profile and sanitizes appropriately", async () => {
    const dir = path.join(tmp, ".agents", "agents");
    await fs.mkdir(dir, { recursive: true });
    
    await fs.writeFile(path.join(dir, "security-auditor.md"), `---
name: security-auditor
description: finds security bugs
role: review
maxTurns: 15
contextBudgetTokens: 50000
webOptIn: true
allowedTools:
  - read_file
  - run_bash
  - grep
  - edit_file
---

Some guidance here
`);

    const profiles = await discoverCustomProfiles(tmp, tmp);
    const p = profiles["security-auditor"];
    assert.ok(p);
    assert.equal(p.purpose, "finds security bugs");
    assert.equal(p.role, "review");
    assert.equal(p.maxTurns, 15);
    assert.equal(p.contextBudgetTokens, 50000);
    assert.equal(p.webOptIn, true);
    assert.equal(p.outputGuidance, "Some guidance here");
    
    // Check read-only invariant (run_bash and edit_file should be stripped)
    assert.deepEqual(p.allowedTools, ["read_file", "grep"]);
  });

  await t.test("strips delegate to prevent recursion", async () => {
    const dir = path.join(tmp, ".agents", "agents");
    await fs.writeFile(path.join(dir, "no-delegate.md"), `---
name: no-delegate
description: some desc
allowedTools:
  - delegate
  - read_file
---
`);

    const profiles = await discoverCustomProfiles(tmp, tmp);
    assert.ok(profiles["no-delegate"]);
    assert.deepEqual(profiles["no-delegate"].allowedTools, ["read_file"]);
  });

  await t.test("skips if no description", async () => {
    const dir = path.join(tmp, ".agents", "agents");
    await fs.writeFile(path.join(dir, "no-desc.md"), `---
name: no-desc
---
`);
    const profiles = await discoverCustomProfiles(tmp, tmp);
    assert.equal(profiles["no-desc"], undefined);
  });

  await t.test("does not shadow built-ins", async () => {
    const dir = path.join(tmp, ".agents", "agents");
    await fs.writeFile(path.join(dir, "reviewer.md"), `---
name: reviewer
description: fake reviewer
---
`);
    const profiles = await discoverCustomProfiles(tmp, tmp);
    // it will be loaded by discover...
    assert.ok(profiles["reviewer"]);
    
    // ...but mergeProfiles should drop it
    const merged = mergeProfiles(PROFILES, profiles);
    assert.notEqual(merged["reviewer"].purpose, "fake reviewer");
    assert.equal(merged["reviewer"].purpose, PROFILES["reviewer"].purpose);
  });
  
  await t.test("workspace precedence", async () => {
    const homeDir = path.join(tmp, "home");
    const wsDir = path.join(tmp, "ws");
    await fs.mkdir(path.join(homeDir, ".agents", "agents"), { recursive: true });
    await fs.mkdir(path.join(wsDir, ".agents", "agents"), { recursive: true });
    
    await fs.writeFile(path.join(homeDir, ".agents", "agents", "foo.md"), `---
name: precedence-test
description: home
---
`);
    await fs.writeFile(path.join(wsDir, ".agents", "agents", "foo.md"), `---
name: precedence-test
description: workspace
---
`);

    const profiles = await discoverCustomProfiles(wsDir, homeDir);
    assert.equal(profiles["precedence-test"].purpose, "workspace");
  });
});
