/**
 * Neutral one-turn HTTP contract. Not a protocol command/event schema.
 * Gateway maps Hub envelopes onto this and maps the result back.
 * Tool calls here are proposals only.
 */

import { z } from 'zod';
import type { AuditEvent } from '../protocol.js';
import type { LlmMessage, LlmToolCall, LlmToolDefinition } from '../ports/provider.js';

export type TraceId = AuditEvent['traceId'];
export type SpanId = AuditEvent['spanId'];
export type WorkspaceId = AuditEvent['workspaceId'];

export type { LlmMessage, LlmToolCall, LlmToolDefinition };

const uuid = z.string().uuid();
const spanId = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((id) => id !== '0000000000000000');

export const llmMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string(),
    toolCallId: z.string().min(1).max(128).optional(),
    toolCalls: z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          name: z.string().min(1).max(128),
          arguments: z.string().max(32_768),
        })
      )
      .max(16)
      .optional(),
  })
  .strict();

export const completeRequestSchema = z
  .object({
    traceId: uuid,
    parentSpanId: spanId.optional(),
    workspaceId: z.string().min(1).max(256),
    userId: uuid.optional(),
    goalId: uuid.optional(),
    threadId: uuid.optional(),
    messages: z.array(llmMessageSchema).min(1),
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1).max(128),
            description: z.string().max(4096).optional(),
            parameters: z.record(z.unknown()).optional(),
          })
          .strict()
      )
      .max(32)
      .optional(),
    json: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().max(128_000).optional(),
    model: z.string().min(1).max(128).optional(),
    idempotencyKey: uuid.optional(),
  })
  .strict();

export type CompleteRequest = z.infer<typeof completeRequestSchema>;
export type TurnRequest = CompleteRequest;

export type CostEstimate =
  | { estimate: 'unknown' }
  | { estimate: number; currency: 'USD'; pricingVersion: string };

export interface TurnResponse {
  message: {
    role: 'assistant';
    content: string | null;
    toolCalls?: LlmToolCall[];
  };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'unknown';
  model: string;
  provider: string;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  };
  latencyMs: number;
  cost: CostEstimate;
  cached?: boolean;
}
