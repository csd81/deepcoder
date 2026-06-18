import type {
  ModelProvider,
  AgentMessage,
  ChatRequest,
  ChatResponse,
  ModelEvent,
  ToolCall,
} from "../providers/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext, ToolInvocation, ToolPreview, ToolResult } from "../tools/types.js";
import { InvalidArgumentsError } from "../tools/types.js";
import { renderTodos } from "../tools/todoWrite.js";
import type { ApprovalMode } from "../config/config.js";
import { checkPermission } from "../permissions/policy.js";

export interface AgentDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  model: string;
  mode: ApprovalMode;
  maxTurns: number;
  /** Streaming text hook (fired per chunk when the provider supports streaming). */
  onAssistantTextDelta?(chunk: string): void;
  /** Final assistant text (fired once per turn; fallback when not streaming). */
  onAssistantText?(text: string): void;
  onToolCall?(name: string, describe: string): void;
  onToolResult?(name: string, result: ToolResult): void;
  onNotice?(message: string): void;
  /** Persist session state (autosave). Called after assistant turns and tool results. */
  onPersist?(): void | Promise<void>;
  /** Approval callback for `ask` decisions. Returns true to proceed. */
  approve(invocation: ToolInvocation, preview?: ToolPreview): Promise<boolean>;
}

/**
 * The core loop. `messages` is the running conversation (mutated in place so a
 * REPL can keep history across turns). Returns the final assistant text.
 */
export async function runAgentLoop(messages: AgentMessage[], deps: AgentDeps): Promise<string> {
  const { ctx, mode, maxTurns } = deps;
  let lastInvalidSignature: string | null = null;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (ctx.signal.aborted) {
      deps.onNotice?.("Aborted.");
      return "";
    }

    const response = await getResponse(deps, withTodoContext(messages, ctx));

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls.length ? response.toolCalls : undefined,
    });
    if (response.text && !deps.onAssistantTextDelta) deps.onAssistantText?.(response.text);
    await deps.onPersist?.();

    // No tool calls => the model is done.
    if (response.toolCalls.length === 0) return response.text;

    for (const call of response.toolCalls) {
      const tool = deps.registry.get(call.name);
      if (!tool) {
        pushToolResult(messages, call.id, call.name, `Unknown tool "${call.name}".`);
        await deps.onPersist?.();
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
          await deps.onPersist?.();
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
        await deps.onPersist?.();
        continue;
      }

      if (decision === "ask") {
        const preview = invocation.preview ? await invocation.preview(ctx) : undefined;
        const approved = await deps.approve(invocation, preview);
        if (!approved) {
          pushToolResult(messages, call.id, call.name, "User rejected this action. It was not run.");
          await deps.onPersist?.();
          continue;
        }
      }

      deps.onToolCall?.(call.name, invocation.describe());
      const result = await invocation.execute(ctx);
      deps.onToolResult?.(call.name, result);
      pushToolResult(messages, call.id, call.name, result.output);
      await deps.onPersist?.();
    }
  }

  deps.onNotice?.(`Reached max turns (${maxTurns}).`);
  return "";
}

/** Append an ephemeral todo system message (not persisted in history). */
function withTodoContext(messages: AgentMessage[], ctx: ToolContext): AgentMessage[] {
  if (ctx.todos.length === 0) return messages;
  return [...messages, { role: "system", content: `Current todo list:\n${renderTodos(ctx.todos)}` }];
}

/** Use streaming when the provider supports it; otherwise a single chat() call. */
async function getResponse(deps: AgentDeps, sent: AgentMessage[]): Promise<ChatResponse> {
  const req: ChatRequest = {
    messages: sent,
    tools: deps.registry.schemas(),
    model: deps.model,
    signal: deps.ctx.signal,
  };
  if (deps.provider.streamChat) {
    return consumeStream(deps.provider.streamChat(req), deps.onAssistantTextDelta);
  }
  return deps.provider.chat(req);
}

async function consumeStream(
  stream: AsyncIterable<ModelEvent>,
  onDelta?: (chunk: string) => void,
): Promise<ChatResponse> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  for await (const ev of stream) {
    switch (ev.type) {
      case "assistant_text_delta":
        text += ev.text;
        onDelta?.(ev.text);
        break;
      case "tool_call_complete":
        toolCalls.push(ev.toolCall);
        break;
      case "error":
        throw new Error(ev.message);
      case "done":
        break;
    }
  }
  return { text, toolCalls };
}

function pushToolResult(
  messages: AgentMessage[],
  toolCallId: string,
  name: string,
  content: string,
): void {
  messages.push({ role: "tool", toolCallId, name, content });
}
