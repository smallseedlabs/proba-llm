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
import type { LlmServiceConfig, ThinkingMode } from '../types/config.js';
import {
  buildFunctionNameMap,
  collectInternalFunctionNames,
  FunctionNameMappingError,
  type FunctionNameMap,
} from './function-names.js';

export interface DeepSeekProviderOptions {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  totalBudgetMs: number;
  temperature: number;
  thinking?: ThinkingMode;
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
    prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const RETRYABLE_STATUS = new Set([408, 429, 502, 503, 504]);

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function mapUsage(usage: ChatResponse['usage']): LlmResponse['usage'] {
  const promptTokens = usage?.prompt_tokens;
  let cachedTokens = usage?.prompt_cache_hit_tokens;
  let cacheMissTokens = usage?.prompt_cache_miss_tokens;
  if (
    !finiteNumber(cachedTokens) &&
    finiteNumber(promptTokens) &&
    finiteNumber(cacheMissTokens) &&
    cacheMissTokens <= promptTokens
  ) {
    cachedTokens = promptTokens - cacheMissTokens;
  }
  if (
    !finiteNumber(cacheMissTokens) &&
    finiteNumber(promptTokens) &&
    finiteNumber(cachedTokens) &&
    cachedTokens <= promptTokens
  ) {
    cacheMissTokens = promptTokens - cachedTokens;
  }
  return {
    promptTokens,
    completionTokens: usage?.completion_tokens,
    cachedTokens,
    cacheMissTokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
  };
}

function toVendorMessages(
  messages: LlmMessage[],
  names: FunctionNameMap,
  thinking: ThinkingMode
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}) };
    }
    if (m.role === 'assistant') {
      const row: Record<string, unknown> = { role: 'assistant', content: m.content };
      if (thinking === 'enabled' && m.reasoningContent != null && m.reasoningContent !== '') {
        row.reasoning_content = m.reasoningContent;
      }
      if (m.toolCalls && m.toolCalls.length > 0) {
        row.tool_calls = m.toolCalls.map((t) => ({
          id: t.id,
          type: 'function',
          function: { name: names.toVendor(t.name), arguments: t.arguments },
        }));
      }
      return row;
    }
    return { role: m.role, content: m.content };
  });
}

function parseToolCalls(raw: ChatResponse['choices'], names: FunctionNameMap): LlmToolCall[] | undefined {
  const calls = raw?.[0]?.message?.tool_calls;
  if (!calls || calls.length === 0) return undefined;
  const parsed: LlmToolCall[] = [];
  for (const call of calls) {
    if (!call.id || !call.function?.name) {
      throw new FunctionNameMappingError('vendor tool call is missing id or name');
    }
    parsed.push({
      id: call.id,
      name: names.toInternal(call.function.name),
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
  private readonly options: DeepSeekProviderOptions;
  private readonly thinking: ThinkingMode;

  constructor(options: DeepSeekProviderOptions) {
    const thinking = options.thinking ?? 'disabled';
    if (thinking !== 'enabled' && thinking !== 'disabled') {
      throw new Error('LLM_THINKING must be enabled or disabled');
    }
    this.thinking = thinking;
    this.options = { ...options, thinking };
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
    let names: FunctionNameMap;
    try {
      names = buildFunctionNameMap(collectInternalFunctionNames(request.tools, request.messages));
    } catch (err) {
      if (err instanceof FunctionNameMappingError) throw new LlmProviderError(err.message, false);
      throw err;
    }
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
            messages: toVendorMessages(request.messages, names, this.thinking),
            temperature: request.temperature ?? this.options.temperature,
            stream: false,
            thinking: { type: this.thinking },
            ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
            ...(request.json ? { response_format: { type: 'json_object' } } : {}),
            ...(request.tools && request.tools.length > 0
              ? {
                  tools: request.tools.map((t) => ({
                    type: 'function',
                    function: {
                      name: names.toVendor(t.name),
                      description: t.description,
                      parameters: t.parameters ?? { type: 'object' },
                    },
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
          let toolCalls: LlmToolCall[] | undefined;
          try {
            toolCalls = parseToolCalls(body.choices, names);
          } catch (err) {
            if (err instanceof FunctionNameMappingError) throw new LlmProviderError(err.message, false);
            throw err;
          }
          const reasoning = choice?.message?.reasoning_content;
          return {
            content: typeof content === 'string' ? content : null,
            ...(toolCalls ? { toolCalls } : {}),
            model: body.model ?? model,
            finishReason: choice?.finish_reason,
            ...(typeof reasoning === 'string' && reasoning.length > 0
              ? { reasoningChars: reasoning.length, reasoningContent: reasoning }
              : {}),
            usage: mapUsage(body.usage),
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
        if (err instanceof FunctionNameMappingError) {
          throw new LlmProviderError(err.message, false);
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
    thinking: config.deepseek.thinking,
    allowedHosts: config.allowedHosts,
    allowedModels: config.allowedModels,
    nodeEnv: config.env,
    fetchFn,
  };
}
