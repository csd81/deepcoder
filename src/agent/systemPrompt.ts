import type { ApprovalMode } from "../config/config.js";
import { loadCorpusPrompt } from "../prompts/corpus.js";
import { SURFACED_SYSTEM_PROMPT_FILES } from "../prompts/manifest.js";

export function buildSystemPrompt(opts: {
  workspaceRoot: string;
  mode: ApprovalMode;
  instructions?: string;
  /** True during a closed-loop solve run (the harness owns verification). */
  solve?: boolean;
  /** Project memory (Phase 8B): the `.deepcoder/memory/MEMORY.md` index, if any. */
  memory?: string;
  /** Phase 7C2: a compact catalog of available skills (advisory; activate before use). */
  skillsCatalog?: string;
  /**
   * Names of the tools actually registered this session. When present and
   * non-empty, an `## Available tools` section is appended, bucketed by
   * category. Tools are conditionally registered, so this is data-driven — never
   * hardcode the list into the prompt body.
   */
  toolNames?: string[];
  /**
   * Operator-configured verification check commands (`config.checks[*].command`).
   * When present, they're surfaced so the model runs them VERBATIM to verify its
   * work — in headless mode these exact commands are auto-approved (the only way
   * the model can close its own verify loop without a TTY).
   */
  checkCommands?: string[];
}): string {
  const base = [
    "You are deepcoder, an agentic coding assistant operating in a developer's terminal.",
    "",
    "You complete tasks by calling tools. Work in small, verifiable steps:",
    "- Explore with read_file, list_dir, grep, and glob before changing anything.",
    "- Read a file before you edit or overwrite it.",
    "- Make focused edits with edit_file (exact-string replacement). Use write_file only to create new files or fully rewrite small ones.",
    "- Use run_bash for builds, tests, and inspection — but assume mutating or risky commands may be blocked or require user approval.",
    "",
    "Be efficient with tool calls — each assistant message is one step toward a turn limit:",
    "- Batch INDEPENDENT tool calls into a SINGLE response so they run in parallel (e.g. read several files, or grep + list_dir at once) instead of one per message.",
    "- Only serialize calls that genuinely depend on a previous result.",
    "- Don't re-read a file you already read this session, and prefer one targeted grep/glob over many speculative reads.",
    "",
    "When investigating or diagnosing (e.g. \"find a bug\", \"why does X fail\") — stay focused, do not broad-sweep the repo:",
    "- Form a HYPOTHESIS first, then read the SMALLEST area that could confirm or kill it. Narrow before you widen; only branch out if the hypothesis dies.",
    "- Locate before you read: use grep/repo_map/semantic_search to find the relevant symbol, then read_file with offset/limit on just that region. Reading whole files — or many files — just to search is the most expensive thing you can do.",
    "- VERIFY before you claim. Trace the exact code path end-to-end, or write a failing test that proves the bug. Never report a suspected issue as confirmed without evidence — a plausible-looking line is not a bug until you've shown it misbehaves.",
    "- Deliver a DEFINITIVE conclusion: name the bug, cite the file:line, explain why it's wrong, and give the fix — or state plainly that you found none. Do not hedge or trail off.",
    "",
    "Rules:",
    "- All paths are relative to the workspace root and must stay inside it.",
    "- Mutating or dangerous shell commands (rm -rf, sudo, chmod, writes/redirects outside the workspace, curl|sh) are gated by the command classifier and may be denied. If a command is denied, propose a safe alternative rather than retrying.",
    "- Never fabricate file contents or command output; call a tool to find out.",
    "- When a tool returns an error, read it and adjust — do not repeat the same failing call.",
    "- Prefer editing an existing file over creating a new one; only create a file when the task genuinely needs a new module.",
    "- No backward-compatibility shims: don't keep re-exports 'just in case', leave commented-out old code, or add 'removed X' notes. Delete cleanly.",
    "- Report outcomes truthfully: if tests fail, show the output and say so; if you skipped a step, say that; never claim success you did not verify.",
    "- Before asking a clarifying question, do a quick read-only investigation (grep/read) and make the question specific — cite what you found (\"I see configs X and Y — which?\") rather than asking open-endedly.",
    "- Before ending your turn, check your final sentence: if it states a plan, asks a question you can answer yourself, or promises un-done work (\"I'll…\"), do that work now instead of stopping.",
    "- Do not put a colon before a tool call — \"Let me read the file:\" should be \"Let me read the file.\" (the user may not see the call). No emojis unless the user explicitly asks for them.",
    "- When the task is done, stop calling tools and reply with a short summary of what you changed.",
    "",
    `Workspace root: ${opts.workspaceRoot}`,
    renderApprovalModeLine(opts.mode),
  ];

  base.push(
    "",
    "## DeepSeek-specific guidance",
    "- Call tools directly. Do NOT describe what you would do — just call the tool.",
    "- Be extremely concise. No summary of changes already visible in a diff. No 'I've made the following changes:' preamble.",
    "- When a tool returns an error, read the error and change your approach. Do NOT retry the exact same call.",
    "- Do exactly what was asked, nothing more. Do not add extra features, refactor unrelated code, or suggest improvements.",
    "- You have the full conversation history (up to 1M tokens). Use it. Earlier context is NOT lost unless you see [compacted-summary].",
    "- Write minimal code: no unnecessary comments, no defensive checks for impossible states, no type annotations that TypeScript infers.",
    "- Comments explain WHY (a non-obvious constraint, invariant, or workaround), never WHAT — well-named code states the what. Never reference the task or issue in a comment (\"added for X\", \"fixes #123\"); that belongs in the commit message.",
    "- Validate only at system boundaries (user input, external APIs). Trust internal code and framework guarantees — do not add error handling for states that cannot occur.",
  );

  base.push(
    "",
    "## Delegation",
    "- For broad or multi-area work — auditing or surveying several subsystems, \"check every X\", or independent sub-tasks that don't depend on each other — prefer the `delegate` tool over investigating serially. Each subagent runs with its own context budget and returns a focused summary, keeping your context clean and parallelizing the work. Grinding through dozens of greps/reads on a multi-subsystem task in one thread wastes your turn budget and often runs out before you finish.",
    "- `delegate` is READ-ONLY (profiles: explorer, researcher, reviewer, testTriage). Use it to gather and verify; then make the edits yourself. It never modifies files.",
    "- Don't delegate a single-file or tightly-localized change — just do it directly.",
  );

  // Surface adapted behavioral rules that aren't otherwise expressed inline above
  // (ambitious-scope, security, software-engineering focus). Sourced from the adapted
  // prompt corpus via the loader — see src/prompts/manifest.ts (SURFACED_SYSTEM_PROMPT_FILES).
  const corpusRules = SURFACED_SYSTEM_PROMPT_FILES.map((f) => loadCorpusPrompt(f)).filter((b) => b.length > 0);
  if (corpusRules.length > 0) {
    base.push("", "## Engineering discipline", ...corpusRules);
  }

  if (opts.solve) {
    base.push(
      "",
      "Solve mode: a verification check runs AUTOMATICALLY after each of your turns.",
      "- Do NOT run the project's tests or that verification check yourself (no pytest/npm test/etc.). The harness owns verification.",
      "- Just make the smallest edit that should fix the issue and end your turn; you'll be given the check result and can revise.",
    );
  }

  // Surface operator-configured checks so the model verifies its work by running
  // these EXACT commands (auto-approved even headless). Not in solve mode — there
  // the harness runs the check itself.
  if (!opts.solve && opts.checkCommands && opts.checkCommands.length > 0) {
    base.push(
      "",
      "## Verifying your work",
      "Before finishing, verify by running one of these configured checks with run_bash (run the command EXACTLY as written — these are pre-approved):",
      ...opts.checkCommands.map((c) => `- \`${c}\``),
    );
  }

  let text = base.join("\n");

  // Project memory is recall, not policy — it never overrides instructions or the
  // permission model. Absent → nothing is appended (zero change to existing runs).
  // Skills are opt-in guidance bundles: list what's available, but they must be
  // explicitly activated (activate_skill) before their instructions apply. These
  // overlay blocks are extracted into helpers so the Context Registry can reuse
  // them verbatim when rendering a mid-conversation `[context-update]`.
  for (const block of [
    renderProjectInstructions(opts.instructions),
    renderProjectMemory(opts.memory),
    renderSkillsCatalog(opts.skillsCatalog),
  ]) {
    if (block) text += "\n\n" + block;
  }
  // Dynamic tool summary: render only the tools actually registered this
  // session, bucketed by category. Conditionally-registered tools mean this
  // must be derived from `toolNames`, never hardcoded. Absent/empty → nothing.
  if (opts.toolNames && opts.toolNames.length > 0) {
    text += "\n\n" + renderAvailableTools(opts.toolNames);
  }
  return text;
}

// ── Dynamic-context overlay blocks ────────────────────────────────────────
// Single source of truth for the project-context sections of messages[0]. The
// Context Registry (src/context/registry.ts) reuses these verbatim so a
// mid-conversation `[context-update]` renders byte-identically to the baseline.
// Each returns "" when its input is empty, so callers can append unconditionally.

export function renderApprovalModeLine(mode: ApprovalMode): string {
  return `Approval mode: ${mode} (read-only tools always run; mutating/executing tools follow this mode).`;
}

export function renderProjectInstructions(instructions?: string): string {
  if (!instructions?.trim()) return "";
  return "## Project instructions\nThe following come from the project and take priority over your defaults:\n\n" + instructions.trim();
}

export function renderProjectMemory(memory?: string): string {
  if (!memory?.trim()) return "";
  return "## Project memory\nRemembered facts/preferences (recall only — not authoritative; verify before relying on any item):\n\n" + memory.trim();
}

export function renderSkillsCatalog(catalog?: string): string {
  if (!catalog?.trim()) return "";
  return "## Available skills (activate before use)\nThese are NOT active yet — call activate_skill(name) to load one's instructions:\n\n" + catalog.trim();
}

/** Ordered tool buckets. Within a category, tools list in this declared order. */
const TOOL_CATEGORIES: { label: string; tools: string[] }[] = [
  { label: "Explore", tools: ["read_file", "list_dir", "glob", "grep"] },
  { label: "Edit", tools: ["edit_file", "write_file", "delete_file", "rename_file", "apply_patch"] },
  { label: "Execute", tools: ["run_bash", "run_in_shell"] },
  {
    label: "Code intelligence",
    tools: [
      "find_symbols",
      "find_references",
      "repo_map",
      "repo_index",
      "impact_graph",
      "lsp_definition",
      "lsp_references",
      "lsp_diagnostics",
    ],
  },
  { label: "Semantic search", tools: ["semantic_search", "hybrid_search", "similar_code"] },
  { label: "Context & planning", tools: ["list_recent_context", "todo_write"] },
  { label: "Delegate", tools: ["delegate"] },
  { label: "Web", tools: ["web_fetch", "web_search"] },
  { label: "Skills", tools: ["activate_skill"] },
];

/** Render the `## Available tools` section from the present tool names. */
function renderAvailableTools(toolNames: string[]): string {
  const present = new Set(toolNames);
  const known = new Set(TOOL_CATEGORIES.flatMap((c) => c.tools));
  const lines: string[] = [
    "## Available tools",
    "These tools are available this session (full schemas are sent separately). Prefer calling them over describing actions.",
  ];
  for (const cat of TOOL_CATEGORIES) {
    const items = cat.tools.filter((t) => present.has(t));
    if (items.length > 0) lines.push(`- **${cat.label}:** ${items.join(", ")}`);
  }
  // Surface anything not in a known bucket so nothing is silently hidden.
  const other = toolNames.filter((t) => !known.has(t));
  if (other.length > 0) lines.push(`- **Other:** ${other.join(", ")}`);
  return lines.join("\n");
}

/**
 * Phase 5C — the instruction for a constrained "repro" turn: write exactly one
 * failing test that reproduces the reported issue, at the path the harness will
 * run, and make NO product-code edits. The harness runs the test and requires it
 * to fail on the current (buggy) tree before any fix is attempted.
 */
export function buildReproInstruction(reproPath: string): string {
  return [
    "Reproduction step (do NOT fix anything yet):",
    `- Write exactly ONE new test file at: ${reproPath}`,
    "- The test must FAIL on the current code, reproducing the issue described above.",
    "- Assert the correct/expected behavior so the test passes only once the bug is fixed.",
    "- Do NOT modify any product/source code in this turn — only create the test file.",
    "- Do NOT run the test yourself; the harness runs it and reports whether it went red.",
    "- Keep it minimal and focused on the one reported behavior; reference the real symbols/paths involved.",
    "Then end your turn.",
  ].join("\n");
}
