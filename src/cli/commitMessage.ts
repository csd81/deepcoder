/**
 * Pure Conventional Commits message generator. Input is a git diff string;
 * output is a single-line Conventional Commits message. No I/O, no git calls.
 */

const MAX_DIFF_CHARS = 8000;
const MAX_DESC_LENGTH = 72;

const SYSTEM_PROMPT = `You are a commit message generator. Given a git diff, produce a single
Conventional Commits message. Format:

  type(scope): short description

Types: feat, fix, docs, test, refactor, chore, perf, ci, build, revert.
Scope is optional — omit if unclear.
- Description: imperative, lowercase, <=72 chars, no period at end.
- If the diff is empty or trivial, return "chore: minor updates".
- Return ONLY the message, no explanation, no markdown, no quotes.`;

function buildUserPrompt(diff: string, recentHistory?: string): string {
  const truncated = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff;
  const history = recentHistory && recentHistory.trim() ? recentHistory.trim() : "(none)";
  return `Recent commits (for style reference):\n${history}\n\nDiff:\n${truncated}`;
}

function stripPair(s: string, ch: string): string {
  if (s.startsWith(ch) && s.endsWith(ch)) {
    return s.slice(ch.length, s.length - ch.length);
  }
  return s;
}

function postProcess(raw: string): string {
  let msg = raw.trim();

  // Strip triple-backtick fences
  if (msg.startsWith("```\n") && msg.endsWith("\n```")) {
    msg = msg.slice(4, msg.length - 4);
  } else if (msg.startsWith("```") && msg.endsWith("```")) {
    msg = msg.slice(3, msg.length - 3);
  }

  // Strip paired surrounding characters: quotes then backtick
  msg = stripPair(msg, '"');
  msg = stripPair(msg, "'");
  msg = stripPair(msg, "`");

  // Take only first line
  msg = msg.split("\n")[0].trim();

  // Truncate to MAX_DESC_LENGTH
  if (msg.length > MAX_DESC_LENGTH) {
    msg = msg.slice(0, MAX_DESC_LENGTH);
  }

  return msg;
}

export async function generateCommitMessage(
  diff: string,
  recentHistory?: string,
  callLLM?: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<string> {
  try {
    if (callLLM) {
      const raw = await callLLM(SYSTEM_PROMPT, buildUserPrompt(diff, recentHistory));
      return postProcess(raw);
    }
    return "chore: update";
  } catch {
    return "chore: update";
  }
}
