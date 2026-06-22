import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTestFramework,
  detectPkgManager,
  detectLinter,
  detectLanguage,
  buildStarterMd,
  type ProjectProfile,
} from "../src/cli/initProject.js";

// Red-seed anchor (do NOT weaken). Pure detection + deterministic render — no model.

test("detectTestFramework picks by priority, null on none", () => {
  assert.equal(detectTestFramework({ vitest: "^1.0.0" }), "vitest");
  assert.equal(detectTestFramework({ jest: "^29", mocha: "^10" }), "jest");
  assert.equal(detectTestFramework({}), null);
});

test("detectPkgManager from lockfiles", () => {
  assert.equal(detectPkgManager(["pnpm-lock.yaml"]), "pnpm");
  assert.equal(detectPkgManager([]), null);
});

test("detectLinter and detectLanguage", () => {
  assert.equal(detectLinter({ oxlint: "^0.1.0" }, []), "oxlint");
  assert.equal(detectLanguage(["src/index.ts", "src/util.js"]), "ts");
});

const full: ProjectProfile = {
  hasPackageJson: true,
  scripts: { build: "tsc", test: "node --test" },
  hasTsconfig: true,
  tsStrict: true,
  hasReadme: true,
  hasGitignore: true,
  hasDockerfile: false,
  testFramework: "node:test",
  linter: "eslint",
  formatter: "prettier",
  pkgManager: "npm",
  lang: "ts",
  srcDirs: ["src"],
  topFiles: ["package.json", "tsconfig.json"],
  fileCount: 42,
};

test("buildStarterMd renders markdown with the project's commands", () => {
  const md = buildStarterMd(full);
  assert.match(md, /^#/m, "is markdown with a heading");
  assert.ok(md.includes("tsc") || md.includes("build"), "surfaces detected scripts");
});

test("buildStarterMd on a minimal profile falls back gracefully", () => {
  const minimal: ProjectProfile = {
    ...full, hasPackageJson: false, scripts: {}, testFramework: null, linter: null,
    formatter: null, pkgManager: null, lang: "other", srcDirs: [], topFiles: [], fileCount: 0,
  };
  const md = buildStarterMd(minimal);
  assert.match(md, /No commands detected/i);
});
