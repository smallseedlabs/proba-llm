/**
 * Model-provider port: exactly one chat completion.
 *
 * Tool *proposals* may be returned; this service never executes tools, never
 * loops, never mixes models, and never streams.
 */

export type LlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface LlmToolCall {
  id: string;
  name: string;
  /** Vendor JSON arguments string (unexecuted). */
  arguments: string;
}

export interface LlmMessage {
  role: LlmRole;
  content: string;
  toolCallId?: string;
  toolCalls?: LlmToolCall[];
  /** Vendor thinking text. Passed through only when thinking is enabled; not a tool. */
  reasoningContent?: string | null;
}

export interface LlmToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  model?: string;
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls?: LlmToolCall[];
  model: string;
  usage?: LlmUsage;
  finishReason?: string;
  /** Present when the vendor returned reasoning separately; not executed as a tool. */
  reasoningChars?: number;
  reasoningContent?: string | null;
}

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number
  ) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Readiness only: must not spend a vendor call. */
  ping(): Promise<void>;
  close(): Promise<void>;
}
