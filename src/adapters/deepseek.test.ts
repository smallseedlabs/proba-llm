import { describe, expect, it } from 'vitest';
import { DeepSeekProvider } from './deepseek.js';
import { HostRefusedError } from '../errors.js';
import { TurnAbortedError } from '../errors.js';
import type { LlmRequest } from '../ports/provider.js';

const request: LlmRequest = { messages: [{ role: 'user', content: 'hi' }] };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('DeepSeekProvider', () => {
  it('refuses a host that is not allowlisted', () => {
    expect(
      () =>
        new DeepSeekProvider({
          baseUrl: 'https://evil.example',
          model: 'deepseek-chat',
          apiKey: 'sk-test',
          timeoutMs: 1000,
          maxRetries: 0,
          totalBudgetMs: 5000,
          temperature: 0,
          allowedHosts: ['api.deepseek.com'],
          allowedModels: ['deepseek-chat'],
          nodeEnv: 'test',
        })
    ).toThrow(HostRefusedError);
  });

  it('does not retry after HTTP 200', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { content: 'hello', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, prompt_cache_hit_tokens: 1 },
      });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 3,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    const result = await provider.complete({
      ...request,
      tools: [{ name: 'lookup', description: 'lookup', parameters: { type: 'object' } }],
    });
    expect(calls).toBe(1);
    expect(result.content).toBe('hello');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'lookup', arguments: '{}' }]);
    expect(result.usage?.cachedTokens).toBe(1);
    expect(result.usage?.cacheMissTokens).toBe(2);
    expect(result.usage?.promptTokens).toBe(3);
  });

  it('maps prompt_cache_miss_tokens and does not re-derive when both cache fields are present', async () => {
    const fetchFn: typeof fetch = async () =>
      jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_cache_hit_tokens: 7,
          prompt_cache_miss_tokens: 3,
        },
      });
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 0,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    const result = await provider.complete(request);
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 7,
      cacheMissTokens: 3,
      reasoningTokens: undefined,
    });
  });

  it('retries 429 within the budget and does not mix models', async () => {
    const models: unknown[] = [];
    let calls = 0;
    const fetchFn: typeof fetch = async (_url, init) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (calls === 1) return new Response('busy', { status: 429 });
      return jsonResponse({
        model: 'deepseek-chat',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 1,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
      sleep: async () => undefined,
    });
    const result = await provider.complete(request);
    expect(calls).toBe(2);
    expect(models).toEqual(['deepseek-chat', 'deepseek-chat']);
    expect(result.content).toBe('ok');
  });

  it('does not retry HTTP 400', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return new Response('no', { status: 400 });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 3,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    await expect(provider.complete(request)).rejects.toMatchObject({ status: 400, retryable: false });
    expect(calls).toBe(1);
  });

  it('does not retry after HTTP 200 with an unreadable body', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      return new Response('not-json{', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 3,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(TurnAbortedError);
    expect(calls).toBe(1);
  });

  it('does not retry a network error after dispatch', async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls += 1;
      throw new Error('socket hang up');
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 3,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(TurnAbortedError);
    expect(calls).toBe(1);
  });

  it('aborts when the turn signal fires', async () => {
    const controller = new AbortController();
    const fetchFn: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      timeoutMs: 5_000,
      maxRetries: 0,
      totalBudgetMs: 5_000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['deepseek-chat'],
      nodeEnv: 'test',
      fetchFn,
    });
    const pending = provider.complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(TurnAbortedError);
  });

  it('maps dotted tool names to the vendor charset and back without changing the internal id', async () => {
    let vendorBody: { tools?: Array<{ function?: { name?: string } }>; thinking?: { type?: string } } | undefined;
    const fetchFn: typeof fetch = async (_url, init) => {
      vendorBody = JSON.parse(String(init?.body)) as typeof vendorBody;
      return jsonResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'c1', function: { name: 'page__attach_user_page', arguments: '{"url":"https://example.com"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'test-model',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 0,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['test-model'],
      nodeEnv: 'test',
      fetchFn,
    });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'attach' }],
      tools: [{ name: 'page.attach_user_page', description: 'attach', parameters: { type: 'object' } }],
    });
    expect(vendorBody?.tools?.[0]?.function?.name).toBe('page__attach_user_page');
    expect(vendorBody?.thinking).toEqual({ type: 'disabled' });
    expect(result.toolCalls).toEqual([
      { id: 'c1', name: 'page.attach_user_page', arguments: '{"url":"https://example.com"}' },
    ]);
  });

  it('passes reasoning_content back only when thinking is enabled', async () => {
    const bodies: Array<{ thinking?: { type?: string }; messages?: Array<{ reasoning_content?: string }> }> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
      return jsonResponse({
        choices: [{ message: { content: 'done', reasoning_content: 'because' }, finish_reason: 'stop' }],
      });
    };
    const enabled = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'test-model',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 0,
      totalBudgetMs: 5000,
      temperature: 0,
      thinking: 'enabled',
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['test-model'],
      nodeEnv: 'test',
      fetchFn,
    });
    const first = await enabled.complete({
      messages: [{ role: 'user', content: 'why' }],
    });
    expect(first.reasoningContent).toBe('because');
    await enabled.complete({
      messages: [
        { role: 'user', content: 'why' },
        { role: 'assistant', content: 'done', reasoningContent: 'because' },
        { role: 'user', content: 'again' },
      ],
    });
    expect(bodies[0]?.thinking).toEqual({ type: 'enabled' });
    expect(bodies[1]?.messages?.[1]?.reasoning_content).toBe('because');

    const disabledBodies: Array<{ messages?: Array<{ reasoning_content?: string }> }> = [];
    const disabled = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'test-model',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 0,
      totalBudgetMs: 5000,
      temperature: 0,
      thinking: 'disabled',
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['test-model'],
      nodeEnv: 'test',
      fetchFn: async (_url, init) => {
        disabledBodies.push(JSON.parse(String(init?.body)) as (typeof disabledBodies)[number]);
        return jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
      },
    });
    await disabled.complete({
      messages: [
        { role: 'user', content: 'why' },
        { role: 'assistant', content: 'done', reasoningContent: 'because' },
      ],
    });
    expect(disabledBodies[0]?.messages?.[1]?.reasoning_content).toBeUndefined();
  });

  it('refuses an unknown vendor tool name instead of inventing an internal id', async () => {
    const provider = new DeepSeekProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'test-model',
      apiKey: 'sk-test',
      timeoutMs: 1000,
      maxRetries: 0,
      totalBudgetMs: 5000,
      temperature: 0,
      allowedHosts: ['api.deepseek.com'],
      allowedModels: ['test-model'],
      nodeEnv: 'test',
      fetchFn: async () =>
        jsonResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [{ id: 'c1', function: { name: 'not_declared', arguments: '{}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
    });
    await expect(
      provider.complete({
        messages: [{ role: 'user', content: 'x' }],
        tools: [{ name: 'page.attach_user_page' }],
      })
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/unknown vendor function name/) });
  });
});
