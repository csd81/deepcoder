/**
 * Adversarial: the corpus loader reads files from disk on the prompt-building path,
 * so it must (1) confine reads to the corpus dir — no path traversal or absolute
 * paths, (2) never throw on bad/missing input, and (3) never leak provenance markers
 * into surfaced prompt text. A loader that escapes its dir or throws would turn a
 * reference corpus into an injection / crash surface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCorpusPrompt } from "../../src/prompts/corpus.js";

test("path traversal and absolute paths are rejected (return empty, never read outside)", () => {
  for (const evil of [
    "../../../etc/passwd",
    "../package.json",
    "/etc/passwd",
    "..%2f..%2fetc%2fpasswd",
    "foo/../bar.md",
    "system-prompt-doing-tasks-security.md/../../package.json",
  ]) {
    assert.equal(loadCorpusPrompt(evil), "", `must reject ${evil}`);
  }
});

test("invalid names with disallowed characters return empty rather than throwing", () => {
  for (const bad of ["", "UPPER.md", "has space.md", "weird;name.md", "no-extension", "tab\t.md"]) {
    assert.doesNotThrow(() => loadCorpusPrompt(bad));
    assert.equal(loadCorpusPrompt(bad), "");
  }
});

test("a syntactically valid but missing file returns empty (no throw)", () => {
  assert.doesNotThrow(() => loadCorpusPrompt("definitely-not-a-real-corpus-file.md"));
  assert.equal(loadCorpusPrompt("definitely-not-a-real-corpus-file.md"), "");
});

test("surfaced content never carries the adapted-from provenance comment", () => {
  const body = loadCorpusPrompt("system-prompt-doing-tasks-software-engineering-focus.md");
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /<!--/);
  assert.doesNotMatch(body, /adapted-from/);
});
