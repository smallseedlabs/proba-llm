import { HostRefusedError, ModelRefusedError, TurnAbortedError } from '../errors.js';
import { assertAllowedBaseUrl, trimBaseUrl } from '../http/allowlist.js';
import {
  LlmProviderError,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
} from '../ports/provider.js';
import type { LlmServiceConfig } from '../types/config.js';

export interface DeepSeekProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  totalBudgetMs: number;
  temperature: number;
  allowedHosts: readonly string[];
  allowedModels: readonly string[];
  nodeEnv: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

function toVendorMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: t.name, arguments: t.arguments },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function parseToolCalls(raw: ChatResponse['choices']): LlmToolCall[] | undefined {
  const calls = raw?.[0]?.message?.tool_calls;
  if (!calls || calls.length === 0) return undefined;
  const parsed: LlmToolCall[] = [];
  for (const call of calls) {
    if (!call.id || !call.function?.name) continue;
    parsed.push({
      id: call.id,
      name: call.function.name,
      arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}',
    });
  }
  return parsed.length > 0 ? parsed : undefined;
}

/**
 * OpenAI-compatible DeepSeek chat completions. No streaming, no shadow, no
 * tool execution. Retries only clearly transient failures, within the total
 * time budget, and never after an HTTP 2xx (ambiguous acceptance).
 */
export class DeepSeekProvider implements LlmProvider {
  readonly name = 'deepseek';
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DeepSeekProviderOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!options.baseUrl) throw new Error('LLM_BASE_URL is required');
    if (!options.model) throw new Error('LLM_MODEL is required');
    assertAllowedBaseUrl(options.baseUrl, options.allowedHosts, options.nodeEnv);
    if (options.allowedModels.length > 0 && !options.allowedModels.includes(options.model)) {
      throw new ModelRefusedError(options.model);
    }
  }

  get model(): string {
    return this.options.model;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    if (request.messages.length === 0) throw new LlmProviderError('a chat request needs at least one message', false);
    const model = request.model ?? this.options.model;
    if (this.options.allowedModels.length > 0 && !this.options.allowedModels.includes(model)) {
      throw new ModelRefusedError(model);
    }
    const url = assertAllowedBaseUrl(this.options.baseUrl, this.options.allowedHosts, this.options.nodeEnv);
    const endpoint = `${trimBaseUrl(url.toString())}/chat/completions`;
    const started = Date.now();
    const budgetMs = this.options.totalBudgetMs;
    let lastError: Error | undefined;
    const attempts = this.options.maxRetries + 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (request.signal?.aborted) throw new TurnAbortedError();
      const remaining = budgetMs - (Date.now() - started);
      if (remaining <= 0) throw new TurnAbortedError('provider budget exhausted');
      const timeoutMs = Math.min(this.options.timeoutMs, remaining);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchFn(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: toVendorMessages(request.messages),
            temperature: request.temperature ?? this.options.temperature,
            stream: false,
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools.map((t) => ({
                    type: 'function',
                    function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object' } },
                  })),
                }
              : {}),
          }),
          signal: controller.signal,
        });
        if (response.ok) {
          // 2xx: do not retry (ambiguous acceptance / possible spend).
          let body: ChatResponse;
          try {
            body = (await response.json()) as ChatResponse;
          } catch {
            throw new TurnAbortedError('deepseek returned 2xx but the body could not be read');
          }
          const choice = body.choices?.[0];
          const content = choice?.message?.content ?? null;
          const toolCalls = parseToolCalls(body.choices);
          const reasoning = choice?.message?.reasoning_content;
          return {
            content: typeof content === 'string' ? content : null,
            ...(toolCalls ? { toolCalls } : {}),
            model: body.model ?? model,
            finishReason: choice?.finish_reason,
            ...(reasoning ? { reasoningChars: reasoning.length } : {}),
            usage: {
              promptTokens: body.usage?.prompt_tokens,
              completionTokens: body.usage?.completion_tokens,
              cachedTokens: body.usage?.prompt_cache_hit_tokens,
              reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
            },
          };
        }
        const status = response.status;
        const excerpt = (await response.text().catch(() => '')).slice(0, 200);
        const retryable = RETRYABLE_STATUS.has(status);
        lastError = new LlmProviderError(
          `deepseek answered ${status}${excerpt ? `: ${excerpt}` : ''}`,
          retryable,
          status
        );
        if (!retryable || attempt >= attempts) throw lastError;
      } catch (err) {
        if (err instanceof TurnAbortedError || err instanceof ModelRefusedError || err instanceof HostRefusedError) {
          throw err;
        }
        if (err instanceof LlmProviderError) {
          if (!err.retryable || attempt >= attempts) throw err;
          lastError = err;
        } else if (err instanceof Error && err.name === 'AbortError') {
          throw new TurnAbortedError(`deepseek timed out after ${timeoutMs}ms`);
        } else {
          throw new TurnAbortedError(
            `deepseek request failed: ${err instanceof Error ? err.message : 'network error'}`
          );
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }
      const wait = Math.min(1000 * 2 ** (attempt - 1), budgetMs - (Date.now() - started));
      if (wait > 0) await this.sleep(wait);
    }
    throw lastError ?? new LlmProviderError('deepseek failed', true);
  }

  async ping(): Promise<void> {
    if (!this.options.baseUrl) throw new Error('llm provider is not configured');
    assertAllowedBaseUrl(this.options.baseUrl, this.options.allowedHosts, this.options.nodeEnv);
  }

  async close(): Promise<void> {
    return;
  }
}

export function deepSeekOptionsFromConfig(config: LlmServiceConfig, fetchFn?: typeof fetch): DeepSeekProviderOptions {
  return {
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    apiKey: config.deepseek.apiKey,
    timeoutMs: config.deepseek.timeoutMs,
    maxRetries: config.deepseek.maxRetries,
    totalBudgetMs: config.deepseek.totalBudgetMs,
    temperature: config.deepseek.temperature,
    allowedHosts: config.allowedHosts,
    allowedModels: config.allowedModels,
    nodeEnv: config.env,
    fetchFn,
  };
}
