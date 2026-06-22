# Feature — DeepSeek-specific system prompt tuning

## Context

Deepcoder's system prompt is generic across all 6 providers. DeepSeek V4 Flash/Pro have specific behavioral quirks that differ from Claude and GPT: over-explaining, hesitating on tool calls, repeating failed calls, generating verbose code, and going off-task on long turns. A provider-specific prompt section would address these without affecting other providers.

The `buildSystemPrompt` function already has conditional sections (solve mode, web awareness). Adding a DeepSeek-specific section follows the same pattern.

## Design

### 1. Add DeepSeek behavior section

In `buildSystemPrompt`, after the main rules block, add a conditional section for DeepSeek:

```ts
if (opts.provider === "deepseek") {
  base.push(
    "",
    "## DeepSeek-specific guidance",
    "- Call tools directly. Do NOT describe what you would do — just call the tool.",
    "- Be extremely concise. No summary of changes already visible in a diff. No 'I've made the following changes:' preamble.",
    "- When a tool returns an error, read the error and change your approach. Do NOT retry the exact same call.",
    "- Do exactly what was asked, nothing more. Do not add extra features, refactor unrelated code, or suggest improvements.",
    "- You have the full conversation history (up to 1M tokens). Use it. Earlier context is NOT lost unless you see [compacted-summary].",
    "- Write minimal code: no unnecessary comments, no defensive checks for impossible states, no type annotations that TypeScript infers.",
  );
}
```

### 2. Thread provider name through

Add `provider` to the opts parameter:

```ts
export function buildSystemPrompt(opts: {
  // … existing fields …
  provider?: string;        // NEW
}): string {
```

Thread it from the call site in `repl.ts`:

```ts
content: buildSystemPrompt({
  workspaceRoot: config.workspaceRoot,
  mode,
  provider: config.provider,    // NEW
  // …
}),
```

### 3. Set DeepSeek temperature to 0

In `src/providers/deepseek.ts`, set default temperature for deterministic coding:

```ts
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string }) {
    super({
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL,
      label: "DeepSeek",
      temperature: 0,          // deterministic coding output
    });
  }
}
```

### 4. A/B test with smoke suite

Add a smoke case that runs with the DeepSeek provider and a prompt known to trigger verbose responses. The test asserts the response length is under a threshold.

## Files

- **Edit:** `src/agent/systemPrompt.ts` (add DeepSeek section + provider param), `src/cli/repl.ts` (thread provider), `src/providers/deepseek.ts` (temperature).

## Verification

1. `npm run typecheck` clean.
2. Manual: run with DeepSeek provider, prompt "fix this typo: 'teh'" → model edits the file with a one-line response, no preamble about what it did.
3. Manual: run with Anthropic provider → DeepSeek section is absent from system prompt.
4. Temperature 0 → repeated runs with the same prompt produce identical edits.

## Safety

- Provider-specific prompt section only fires for DeepSeek — no effect on other providers.
- The conciseness directive is behavioral — the model may ignore it, but that's harmless.
- Temperature 0 for DeepSeek only — other providers keep their current defaults.
