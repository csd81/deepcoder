import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldChunkFile, chunkFile, inferLanguage } from "../../src/semantic/chunker.js";

test("1. Sensitive files are never chunked", () => {
  const sensitivePaths = [
    ".env",
    ".env.local",
    ".deepcoder/config.json",
    "id_rsa",
    "id_ed25519.pub",
    "credentials.json",
    ".npmrc",
    ".aws/credentials"
  ];

  for (const p of sensitivePaths) {
    assert.equal(shouldChunkFile(p, "SOME_SECRET=123").ok, false, `should reject sensitive path: ${p}`);
    const chunks = chunkFile(p, "SOME_SECRET=123");
    assert.deepEqual(chunks, [], `should return empty chunks for sensitive path: ${p}`);
  }
});

test("2. Generated/ignored files are never chunked", () => {
  const ignoredPaths = [
    "node_modules/lodash/index.js",
    "dist/bundle.js",
    "build/index.js",
    "coverage/lcov.info",
    ".next/server/pages/index.js",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "app.min.js",
    "app.js.map"
  ];

  for (const p of ignoredPaths) {
    assert.equal(shouldChunkFile(p, "console.log(1);").ok, false, `should reject ignored path: ${p}`);
    const chunks = chunkFile(p, "console.log(1);");
    assert.deepEqual(chunks, [], `should return empty chunks for ignored path: ${p}`);
  }
});

test("3. Binary content is skipped", () => {
  const binaryContent = "hello\0world";
  const res = shouldChunkFile("app.ts", binaryContent);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "binary");

  const chunks = chunkFile("app.ts", binaryContent);
  assert.deepEqual(chunks, []);
});

test("4. Oversized file with NO symbols is skipped; WITH symbols it still chunks", () => {
  const largeContent = "a\n".repeat(100000); // ~200KB
  const opts = { maxFileBytes: 10000 }; // 10KB limit

  // With NO symbols
  const resNoSymbols = shouldChunkFile("app.ts", largeContent, opts);
  assert.equal(resNoSymbols.ok, false);
  assert.equal(resNoSymbols.reason, "too large");

  const chunksNoSymbols = chunkFile("app.ts", largeContent, opts);
  assert.deepEqual(chunksNoSymbols, []);

  // WITH symbols
  const optsWithSymbols = {
    maxFileBytes: 10000,
    symbols: [
      { name: "foo", startLine: 1, endLine: 10 },
      { name: "bar", startLine: 11, endLine: 20 }
    ]
  };
  const resWithSymbols = shouldChunkFile("app.ts", largeContent, optsWithSymbols);
  assert.equal(resWithSymbols.ok, true);

  const chunksWithSymbols = chunkFile("app.ts", largeContent, optsWithSymbols);
  assert.ok(chunksWithSymbols.length > 0);
  for (const chunk of chunksWithSymbols) {
    assert.equal(chunk.kind, "symbol");
  }
});

test("5. Chunks are bounded: every returned chunk's text byte-length <= maxChunkBytes", () => {
  const content = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10";
  const maxChunkBytes = 15;
  const chunks = chunkFile("app.ts", content, { maxChunkBytes });

  assert.ok(chunks.length > 0);
  const lines = content.split("\n");
  for (const chunk of chunks) {
    const chunkText = lines.slice(chunk.startLine - 1, chunk.endLine).join("\n");
    const byteLength = Buffer.byteLength(chunkText, "utf8");
    assert.ok(byteLength <= maxChunkBytes, `Chunk text "${chunkText}" has byte length ${byteLength} which exceeds ${maxChunkBytes}`);
  }
});

test("6. Line ranges are valid: 1 <= startLine <= endLine <= number of lines, for every chunk", () => {
  const content = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj";
  const chunks = chunkFile("app.ts", content, { maxChunkBytes: 5 });

  assert.ok(chunks.length > 0);
  const totalLines = content.split("\n").length;
  for (const chunk of chunks) {
    assert.ok(chunk.startLine >= 1, "startLine >= 1");
    assert.ok(chunk.endLine >= chunk.startLine, "endLine >= startLine");
    assert.ok(chunk.endLine <= totalLines, `endLine (${chunk.endLine}) <= totalLines (${totalLines})`);
  }
});

test("7. A normal .ts source file yields >= 1 chunk with language 'typescript'; a .md file yields 'section' chunks", () => {
  const tsContent = "export function foo() { return 42; }";
  const tsChunks = chunkFile("src/foo.ts", tsContent);
  assert.ok(tsChunks.length >= 1);
  assert.equal(tsChunks[0].language, "typescript");
  assert.equal(tsChunks[0].kind, "file");

  const mdContent = "# Heading 1\nSome text\n## Heading 2\nMore text";
  const mdChunks = chunkFile("docs/readme.md", mdContent);
  assert.ok(mdChunks.length >= 1);
  for (const chunk of mdChunks) {
    assert.equal(chunk.language, "markdown");
    assert.equal(chunk.kind, "section");
  }
});

test("8. Determinism: chunkFile called twice on the same input returns identical ids and textHashes", () => {
  const content = "const x = 1;\nconst y = 2;\nconst z = 3;";
  const chunks1 = chunkFile("app.ts", content);
  const chunks2 = chunkFile("app.ts", content);

  assert.deepEqual(chunks1, chunks2);
});

test("9. (secret safety) Even though chunk text is source code, a .env-style file is refused entirely", () => {
  const envContent = "PORT=8080\nDATABASE_URL=postgres://localhost\nSECRET_KEY=supersecret";
  const chunks = chunkFile(".env", envContent);
  assert.deepEqual(chunks, []);

  const shouldChunk = shouldChunkFile(".env", envContent);
  assert.equal(shouldChunk.ok, false);
});

test("10. inferLanguage maps extensions correctly", () => {
  assert.equal(inferLanguage("a.ts"), "typescript");
  assert.equal(inferLanguage("a.tsx"), "typescript");
  assert.equal(inferLanguage("a.js"), "javascript");
  assert.equal(inferLanguage("a.mjs"), "javascript");
  assert.equal(inferLanguage("a.py"), "python");
  assert.equal(inferLanguage("a.md"), "markdown");
  assert.equal(inferLanguage("a.json"), "json");
  assert.equal(inferLanguage("a.txt"), "text");
  assert.equal(inferLanguage("a"), "text");
});
