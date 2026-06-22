import type { ChatRequest, ChatResponse, ModelProvider } from "./types.js";

/**
 * A minimal faux provider that returns a canned "done" response immediately.
 * Used by the smoke-test suite to exercise the agent loop without real API keys.
 * No network, no secrets, no side effects.
 */
export class FauxProvider implements ModelProvider {
  async chat(_input: ChatRequest): Promise<ChatResponse> {
    return { text: "done", toolCalls: [] };
  }
}
