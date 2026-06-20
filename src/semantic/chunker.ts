import { isSensitivePath } from "../workspace/sensitive.js";
import { ChunkOptions, SemanticChunk } from "./types.js";
import { createHash } from "node:crypto";
import path from "node:path";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".mjs") return "javascript";
  if (ext === ".py") return "python";
  if (ext === ".md") return "markdown";
  if (ext === ".json") return "json";
  return "text";
}

export function shouldChunkFile(
  filePath: string,
  content: string,
  opts?: ChunkOptions
): { ok: boolean; reason?: string } {
  // 1. Sensitive paths
  if (isSensitivePath(filePath)) {
    return { ok: false, reason: "sensitive" };
  }

  // 2. Generated/ignored paths
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const isIgnoredDir = segments.some(seg => 
    seg === "node_modules" || 
    seg === "dist" || 
    seg === "build" || 
    seg === "coverage" || 
    seg === ".next"
  );
  const filename = segments[segments.length - 1] || "";
  const isLockfile = filename === "package-lock.json" || filename === "pnpm-lock.yaml" || filename === "yarn.lock";
  const isMinJsOrMap = filename.endsWith(".min.js") || filename.endsWith(".map");

  if (isIgnoredDir || isLockfile || isMinJsOrMap) {
    return { ok: false, reason: "ignored" };
  }

  // 3. Binary content
  if (content.includes("\0")) {
    return { ok: false, reason: "binary" };
  }

  // 4. Oversized
  const maxFileBytes = opts?.maxFileBytes ?? 262144;
  const hasSymbols = opts?.symbols && opts.symbols.length > 0;
  if (Buffer.byteLength(content, "utf8") > maxFileBytes && !hasSymbols) {
    return { ok: false, reason: "too large" };
  }

  return { ok: true };
}

function safeByteSlice(str: string, maxBytes: number): { chunk: string; rest: string } {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) {
    return { chunk: str, rest: "" };
  }
  let sliceLen = maxBytes;
  while (sliceLen > 0 && (buf[sliceLen] & 0xC0) === 0x80) {
    sliceLen--;
  }
  const chunk = buf.subarray(0, sliceLen).toString("utf8");
  const rest = buf.subarray(sliceLen).toString("utf8");
  return { chunk, rest };
}

function splitSingleLine(line: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = line;
  while (Buffer.byteLength(remaining, "utf8") > maxBytes) {
    const { chunk, rest } = safeByteSlice(remaining, maxBytes);
    if (chunk.length === 0) {
      const firstChar = remaining.charAt(0);
      chunks.push(firstChar);
      remaining = remaining.slice(1);
    } else {
      chunks.push(chunk);
      remaining = rest;
    }
  }
  if (remaining.length > 0 || chunks.length === 0) {
    chunks.push(remaining);
  }
  return chunks;
}

interface LineRangeChunk {
  startLine: number;
  endLine: number;
  text: string;
}

function splitLineRange(
  startLine: number,
  endLine: number,
  lines: string[],
  maxChunkBytes: number
): LineRangeChunk[] {
  const result: LineRangeChunk[] = [];
  let currentStart = startLine;

  while (currentStart <= endLine) {
    let currentEnd = currentStart;
    let bestText = "";
    let bestEnd = currentStart;

    while (currentEnd <= endLine) {
      const slice = lines.slice(currentStart - 1, currentEnd);
      const text = slice.join("\n");
      const bytes = Buffer.byteLength(text, "utf8");

      if (bytes <= maxChunkBytes) {
        bestText = text;
        bestEnd = currentEnd;
        currentEnd++;
      } else {
        break;
      }
    }

    if (bestEnd >= currentStart && bestText !== "") {
      result.push({
        startLine: currentStart,
        endLine: bestEnd,
        text: bestText,
      });
      currentStart = bestEnd + 1;
    } else {
      const singleLineText = lines[currentStart - 1];
      const subChunks = splitSingleLine(singleLineText, maxChunkBytes);
      for (const subText of subChunks) {
        result.push({
          startLine: currentStart,
          endLine: currentStart,
          text: subText,
        });
      }
      currentStart++;
    }
  }

  return result;
}

export function chunkFile(
  filePath: string,
  content: string,
  opts?: ChunkOptions
): SemanticChunk[] {
  try {
    const check = shouldChunkFile(filePath, content, opts);
    if (!check.ok) {
      return [];
    }

    if (content === "") {
      return [];
    }

    const maxChunkBytes = opts?.maxChunkBytes ?? 4000;
    const lines = content.split("\n");
    const totalLines = lines.length;
    const language = inferLanguage(filePath);

    // 1. Prefer provided symbols boundaries
    if (opts?.symbols && opts.symbols.length > 0) {
      const chunks: SemanticChunk[] = [];
      for (const sym of opts.symbols) {
        const start = Math.max(1, Math.min(sym.startLine, totalLines));
        const end = Math.max(start, Math.min(sym.endLine, totalLines));
        const subRanges = splitLineRange(start, end, lines, maxChunkBytes);
        for (const range of subRanges) {
          const textHash = sha256(range.text);
          const id = sha256(`${filePath}:${range.startLine}:${textHash}`);
          chunks.push({
            id,
            path: filePath,
            startLine: range.startLine,
            endLine: range.endLine,
            language,
            kind: "symbol",
            textHash,
            embeddingHash: "",
          });
        }
      }
      return chunks;
    }

    // 2. Markdown heading sections
    if (language === "markdown") {
      const headingIndices: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^#{1,6}(?:\s|$)/.test(lines[i])) {
          headingIndices.push(i);
        }
      }

      const sections: { startLine: number; endLine: number }[] = [];
      if (headingIndices.length === 0) {
        sections.push({ startLine: 1, endLine: totalLines });
      } else {
        if (headingIndices[0] > 0) {
          sections.push({ startLine: 1, endLine: headingIndices[0] });
        }
        for (let i = 0; i < headingIndices.length; i++) {
          const start = headingIndices[i] + 1;
          const end = i + 1 < headingIndices.length ? headingIndices[i + 1] : totalLines;
          sections.push({ startLine: start, endLine: end });
        }
      }

      const chunks: SemanticChunk[] = [];
      for (const sec of sections) {
        const subRanges = splitLineRange(sec.startLine, sec.endLine, lines, maxChunkBytes);
        for (const range of subRanges) {
          const textHash = sha256(range.text);
          const id = sha256(`${filePath}:${range.startLine}:${textHash}`);
          chunks.push({
            id,
            path: filePath,
            startLine: range.startLine,
            endLine: range.endLine,
            language,
            kind: "section",
            textHash,
            embeddingHash: "",
          });
        }
      }
      return chunks;
    }

    // 3. Everything else: size-bounded contiguous line windows
    const chunks: SemanticChunk[] = [];
    const subRanges = splitLineRange(1, totalLines, lines, maxChunkBytes);
    for (const range of subRanges) {
      const textHash = sha256(range.text);
      const id = sha256(`${filePath}:${range.startLine}:${textHash}`);
      chunks.push({
        id,
        path: filePath,
        startLine: range.startLine,
        endLine: range.endLine,
        language,
        kind: "file",
        textHash,
        embeddingHash: "",
      });
    }
    return chunks;

  } catch (err) {
    return [];
  }
}
