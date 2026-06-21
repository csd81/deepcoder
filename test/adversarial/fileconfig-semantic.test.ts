import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadFileConfig } from "../../src/config/fileConfig.js";

test("loadFileConfig parses semanticSearch from .deepcoder/config.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-fc-sem-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(
    path.join(root, ".deepcoder", "config.json"),
    JSON.stringify({
      semanticSearch: {
        enabled: true,
        model: "my-model",
        topK: 7,
      },
    }),
    "utf8",
  );
  const cfg = loadFileConfig(root);
  assert.ok(cfg.semanticSearch, "semanticSearch block should be present");
  assert.equal(cfg.semanticSearch!.enabled, true);
  assert.equal(cfg.semanticSearch!.model, "my-model");
  assert.equal(cfg.semanticSearch!.topK, 7);
});

test("loadFileConfig omits semanticSearch when not in config.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "adv-fc-sem2-"));
  await mkdir(path.join(root, ".deepcoder"), { recursive: true });
  await writeFile(
    path.join(root, ".deepcoder", "config.json"),
    JSON.stringify({}),
    "utf8",
  );
  const cfg = loadFileConfig(root);
  assert.equal(cfg.semanticSearch, undefined, "semanticSearch should be absent");
});
