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
    const result = await provider.complete(request);
    expect(calls).toBe(1);
    expect(result.content).toBe('hello');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'lookup', arguments: '{}' }]);
    expect(result.usage?.cachedTokens).toBe(1);
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
});
