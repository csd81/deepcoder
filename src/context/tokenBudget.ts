import type { AgentMessage } from "../providers/types.js";

/**
 * Approximate token counting. We deliberately avoid a real tokenizer dependency;
 * ~4 characters per token is a good-enough heuristic for budgeting decisions.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessage(m: AgentMessage): number {
  let chars = m.content.length;
  if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
  return Math.ceil(chars / 4) + 4; // +4 per-message framing overhead
}

export function estimateMessages(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessage(m), 0);
}
