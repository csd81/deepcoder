import type { ModelProvider, AgentMessage } from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult } from "../tools/types.js";
import { InvalidArgumentsError } from "../tools/types.js";
import type { ApprovalMode } from "../config/config.js";
import { checkPermission } from "../permissions/policy.js";

export interface AgentDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  model: string;
  mode: ApprovalMode;
  maxTurns: number;
  /** Stream-ish hooks for the CLI to render activity. */
  onAssistantText?(text: string): void;
  onToolCall?(name: string, describe: string): void;
  onToolResult?(name: string, result: ToolResult): void;
  onNotice?(message: string): void;
  /** Approval callback for `ask` decisions. Returns true to proceed. */
  approve(invocation: ToolInvocation, preview?: ToolPreview): Promise<boolean>;
}

/**
 * The core loop. `messages` is the running conversation (mutated in place so a
 * REPL can keep history across turns). Returns the final assistant text.
 */
export async function runAgentLoop(messages: AgentMessage[], deps: AgentDeps): Promise<string> {
  const { provider, registry, ctx, model, mode, maxTurns } = deps;
  let lastInvalidSignature: string | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (ctx.signal.aborted) {
      deps.onNotice?.("Aborted.");
      return "";
    }

    const response = await provider.chat({
      messages,
      tools: registry.schemas(),
      model,
      signal: ctx.signal,
    });

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });
    if (response.text) deps.onAssistantText?.(response.text);

    // No tool calls => the model is done.
    if (response.toolCalls.length === 0) return response.text;

    for (const call of response.toolCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        pushToolResult(messages, call.id, call.name, `Unknown tool "${call.name}".`);
        continue;
      }

      let invocation: ToolInvocation;
      try {
        invocation = tool.build(call.arguments);
        lastInvalidSignature = null;
      } catch (err) {
        if (err instanceof InvalidArgumentsError) {
          const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
          if (signature === lastInvalidSignature) {
            deps.onNotice?.(`Stopping: ${call.name} called with invalid arguments repeatedly.`);
            return "";
          }
          lastInvalidSignature = signature;
          pushToolResult(messages, call.id, call.name, err.message);
          continue;
        }
        throw err;
      }

      const decision = checkPermission(invocation, mode);
      if (decision === "deny") {
        deps.onToolCall?.(call.name, invocation.describe());
        pushToolResult(
          messages,
          call.id,
          call.name,
          `Denied by permission policy (mode: ${mode}). This action was not run.`,
        );
        continue;
      }

      if (decision === "ask") {
        const preview = invocation.preview ? await invocation.preview(ctx) : undefined;
        const approved = await deps.approve(invocation, preview);
        if (!approved) {
          pushToolResult(messages, call.id, call.name, "User rejected this action. It was not run.");
          continue;
        }
      }

      deps.onToolCall?.(call.name, invocation.describe());
      const result = await invocation.execute(ctx);
      deps.onToolResult?.(call.name, result);
      pushToolResult(messages, call.id, call.name, result.output);
    }
  }

  deps.onNotice?.(`Reached max turns (${maxTurns}).`);
  return "";
}

function pushToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  name: string,
  content: string,
): void {
  messages.push({ role: "tool", toolCallId, name, content });
}
