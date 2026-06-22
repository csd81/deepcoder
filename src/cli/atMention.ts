/**
 * @-file mentions — parse and expand @path tokens in user prompts.
 *
 * PURE module: no `fs` or `path` imports. `resolve` and `readFile` are injected
 * by the caller so this is fully unit-testable with no real filesystem.
 */

/** Extract @-mention path tokens from text (e.g. "explain @src/a.ts and @b.ts"). */
export function parseAtMentions(text: string): string[] {
  const results: string[] = [];
  const re = /(?:^|\s)@([\w./@-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let path = m[1]!;
    // Strip trailing punctuation: ., ,, ), etc.
    path = path.replace(/[.,)]+$/, "");
    results.push(path);
  }
  return results;
}

export interface MentionExpansion {
  prompt: string;            // original text + appended context blocks
  attached: string[];        // paths successfully injected
  skipped: { path: string; reason: string }[];
}

/**
 * Resolve + read each mention and append fenced context blocks to the prompt.
 * `readFile`/`resolve` are injected (no fs import here) so this is unit-testable
 * with no real filesystem and acceptance needs no live model.
 *
 *  - resolve throws (out-of-workspace) → skipped {reason: "outside workspace"}
 *  - readFile throws (missing) → skipped {reason: "not found"}
 *  - content longer than maxBytes → truncated with a "… (truncated)" marker
 *  - total injected content over maxBytes budget → skipped {reason: "context budget exceeded"}
 */
export function expandMentions(
  text: string,
  deps: {
    resolve: (p: string) => string;
    readFile: (abs: string) => string;
    maxBytes?: number;
  },
): MentionExpansion {
  const maxBytes = deps.maxBytes ?? 64_000;
  const attached: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let usedBytes = 0;
  const blocks: string[] = [];

  const mentions = parseAtMentions(text);

  for (const mention of mentions) {
    // 1. Resolve (throws if outside workspace)
    let abs: string;
    try {
      abs = deps.resolve(mention);
    } catch {
      skipped.push({ path: mention, reason: "outside workspace" });
      continue;
    }

    // 2. Read (throws if missing)
    let content: string;
    try {
      content = deps.readFile(abs);
    } catch {
      skipped.push({ path: mention, reason: "not found" });
      continue;
    }

    // 3. Per-file truncation: if the content alone exceeds the total budget,
    //    truncate it so it still fits (with a marker).
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + "\n… (truncated)";
    }

    // 4. Check total budget — skip if adding this block would exceed maxBytes.
    if (usedBytes + content.length > maxBytes) {
      skipped.push({ path: mention, reason: "context budget exceeded" });
      continue;
    }

    // 5. Build the fenced block and accumulate.
    const block = `@${mention}:\n\`\`\`\n${content}\n\`\`\``;
    blocks.push(block);
    attached.push(mention);
    usedBytes += content.length;
  }

  // Append all injected blocks to the original text.
  const prompt = blocks.length > 0 ? text + "\n\n" + blocks.join("\n\n") : text;

  return { prompt, attached, skipped };
}
