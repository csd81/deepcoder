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
import { compactIfNeeded } from "../context/compaction.js";

export interface AgentDeps {
  provider: ModelProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  model: string;
  mode: ApprovalMode;
  maxTurns: number;
  /** Token budget + trigger fraction for history compaction. */
  contextBudgetTokens: number;
  compactAt: number;
  /** Whether execute-kind MCP tools may run (off in Phase 4A). */
  mcpExecuteEnabled?: boolean;
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

    const compaction = compactIfNeeded(messages, {
      budgetTokens: deps.contextBudgetTokens,
      compactAt: deps.compactAt,
      todos: ctx.todos,
    });
    if (compaction.compacted) {
      deps.onNotice?.(`Compacted context (~${compaction.before} → ~${compaction.after} tokens).`);
      await deps.onPersist?.();
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
      // Abort between tool calls in the same assistant turn — otherwise a Ctrl-C
      // during one tool would still let the remaining calls run.
      if (ctx.signal.aborted) {
        deps.onNotice?.("Aborted.");
        return "";
      }
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

      const decision = checkPermission(invocation, mode, { mcpExecuteEnabled: deps.mcpExecuteEnabled });
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
      // A tool that throws (e.g. read_file on a missing path) must not abort the
      // whole run — turn it into a recoverable tool-result the model can react to.
      let result: ToolResult;
      try {
        result = await invocation.execute(ctx);
      } catch (err) {
        // An abort must stop the whole run, not be swallowed as a recoverable error.
        if (ctx.signal.aborted || (err as Error).name === "AbortError") {
          deps.onNotice?.("Aborted.");
          return "";
        }
        result = { output: `Tool ${call.name} failed: ${(err as Error).message ?? String(err)}`, isError: true };
      }
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

/**
 * Produce a provider-safe copy of the message list: every assistant tool-call
 * must have its tool result present, and every tool message must have its
 * owning assistant call. OpenAI-compatible APIs reject either kind of dangling
 * reference. This defends against compaction boundaries AND corrupted/resumed
 * history. Operates on a copy — stored history is never mutated.
 */
export function sanitizeForProvider(messages: AgentMessage[]): AgentMessage[] {
  const presentResultIds = new Set<string>();
  for (const m of messages) if (m.role === "tool" && m.toolCallId) presentResultIds.add(m.toolCallId);

  const keptCallIds = new Set<string>();
  const out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls?.length) {
      const calls = m.toolCalls.filter((c) => presentResultIds.has(c.id));
      for (const c of calls) keptCallIds.add(c.id);
      if (calls.length === 0 && !m.content) continue; // empty, useless turn
      out.push(calls.length ? { ...m, toolCalls: calls } : { ...m, toolCalls: undefined });
    } else if (m.role === "tool") {
      if (m.toolCallId && keptCallIds.has(m.toolCallId)) out.push(m);
      // else: orphan tool result — drop it
    } else {
      out.push(m);
    }
  }
  return out;
}

/** Use streaming when the provider supports it; otherwise a single chat() call. */
async function getResponse(deps: AgentDeps, sent: AgentMessage[]): Promise<ChatResponse> {
  const req: ChatRequest = {
    messages: sanitizeForProvider(sent),
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
