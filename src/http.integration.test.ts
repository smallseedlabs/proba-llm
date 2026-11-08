import { describe, expect, it } from 'vitest';
import { buildApp } from './http/app.js';
import { SingleTurnHandler } from './handler/single-turn.js';
import { FakeLlmProvider } from './testing/fake-provider.js';
import { DeepSeekProvider } from './adapters/deepseek.js';
import { MemoryAuditPublisher } from './testing/memory-audit.js';
import { MemoryTurnStore } from './adapters/memory-turn-store.js';
import { SystemClock } from './adapters/system-clock.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { ServiceTokenAuth } from './auth/service-token.js';
import { createTestSigner, mintGatewayToken } from './testing/token-signer.js';

const TRACE = '550e8400-e29b-41d4-a716-446655440000';
const body = {
  traceId: TRACE,
  workspaceId: 'seedbed',
  messages: [{ role: 'user', content: 'plan a campaign' }],
};

async function harness() {
  const signer = await createTestSigner();
  const now = () => new Date('2026-01-01T00:00:00.000Z');
  const config = loadConfig({
    NODE_ENV: 'test',
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_MODEL: 'deepseek-chat',
    LLM_ALLOWED_HOSTS: 'api.deepseek.com',
    LLM_ALLOWED_MODELS: 'deepseek-chat,fake-test-model',
    AUDIT_CONTENT_ENABLED: 'true',
  });
  const provider = new FakeLlmProvider();
  const audit = new MemoryAuditPublisher();
  const turns = new MemoryTurnStore();
  const clock = new SystemClock();
  const auth = new ServiceTokenAuth({
    keys: signer.keys,
    allowedIssuers: ['proba-gateway'],
    allowedSubjects: ['gateway'],
    now,
  });
  const handler = new SingleTurnHandler({ provider, audit, clock, config, turns });
  const app = await buildApp({
    config,
    handler,
    auth,
    audit,
    clock,
    logger: createLogger('silent'),
    ready: async () => ({ config: 'ok', provider: 'ok', audit: 'ok' }),
  });
  return { app, signer, now, provider, audit };
}

describe('HTTP /v1/complete', () => {
  it('requires a verified gateway token and completes one turn', async () => {
    const { app, signer, now, provider } = await harness();
    const denied = await app.inject({ method: 'POST', url: '/v1/complete', payload: body });
    expect(denied.statusCode).toBe(401);

    const token = await mintGatewayToken(signer, now);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ok.statusCode).toBe(200);
    const json = ok.json();
    expect(json.message.content).toBe('ok');
    expect(json.provider).toBe('fake');
    expect(json.cost.estimate).toBe('unknown');
    expect(json.cost.estimate).not.toBe(0);
    expect(provider.calls).toHaveLength(1);

    const again = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      payload: body,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.statusCode).toBe(200);
    expect(provider.calls).toHaveLength(1);
    await app.close();
  });

  it('health is unauthenticated; complete ignores body identity spoofing', async () => {
    const { app, signer, now } = await harness();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().service).toBe('llm');

    const token = await mintGatewayToken(signer, now);
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      payload: { ...body, userId: '11111111-1111-4111-8111-111111111111' },
      headers: { authorization: `Bearer ${token}`, 'x-user-id': 'attacker' },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it('returns 200 when audit publish fails after a paid turn, and does not redispatch', async () => {
    const { app, signer, now, provider, audit } = await harness();
    audit.failPublish = true;
    const token = await mintGatewayToken(signer, now);
    const headers = { authorization: `Bearer ${token}` };
    const first = await app.inject({ method: 'POST', url: '/v1/complete', payload: body, headers });
    expect(first.statusCode).toBe(200);
    expect(first.json().message.content).toBe('ok');
    expect(provider.calls).toHaveLength(1);
    const second = await app.inject({ method: 'POST', url: '/v1/complete', payload: body, headers });
    expect(second.statusCode).toBe(200);
    expect(provider.calls).toHaveLength(1);
    await app.close();
  });

  it('rate-limits by verified caller, not spoofed headers', async () => {
    const signer = await createTestSigner();
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_BASE_URL: 'https://api.deepseek.com',
      LLM_MODEL: 'deepseek-chat',
      LLM_ALLOWED_HOSTS: 'api.deepseek.com',
      LLM_ALLOWED_MODELS: 'deepseek-chat,fake-test-model',
      RATE_LIMIT_MAX: '1',
      RATE_LIMIT_WINDOW_MS: '60000',
    });
    const provider = new FakeLlmProvider();
    const audit = new MemoryAuditPublisher();
    const turns = new MemoryTurnStore();
    const clock = new SystemClock();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
      now,
    });
    const handler = new SingleTurnHandler({ provider, audit, clock, config, turns });
    const app = await buildApp({
      config,
      handler,
      auth,
      audit,
      clock,
      logger: createLogger('silent'),
    });
    const token = await mintGatewayToken(signer, now);
    const headers = { authorization: `Bearer ${token}`, 'x-user-id': 'attacker' };
    const first = await app.inject({ method: 'POST', url: '/v1/complete', payload: body, headers });
    expect(first.statusCode).toBe(200);
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      payload: { ...body, traceId: '660e8400-e29b-41d4-a716-446655440000' },
      headers,
    });
    expect(limited.statusCode).toBe(429);
    expect(provider.calls).toHaveLength(1);
    await app.close();
  });

  it('round-trips dotted tool names through HTTP complete via the DeepSeek adapter', async () => {
    const signer = await createTestSigner();
    const now = () => new Date('2026-01-01T00:00:00.000Z');
    const config = loadConfig({
      NODE_ENV: 'test',
      LLM_BASE_URL: 'https://api.deepseek.com',
      LLM_MODEL: 'test-model',
      LLM_ALLOWED_HOSTS: 'api.deepseek.com',
      LLM_ALLOWED_MODELS: 'test-model',
      AUDIT_CONTENT_ENABLED: 'true',
    });
    let vendorName: string | undefined;
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
      fetchFn: async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { tools?: Array<{ function?: { name?: string } }> };
        vendorName = parsed.tools?.[0]?.function?.name;
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: 'c1', function: { name: 'page__attach_user_page', arguments: '{"url":"https://example.com"}' } },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      },
    });
    const audit = new MemoryAuditPublisher();
    const turns = new MemoryTurnStore();
    const clock = new SystemClock();
    const auth = new ServiceTokenAuth({
      keys: signer.keys,
      allowedIssuers: ['proba-gateway'],
      allowedSubjects: ['gateway'],
      now,
    });
    const handler = new SingleTurnHandler({ provider, audit, clock, config, turns });
    const app = await buildApp({
      config,
      handler,
      auth,
      audit,
      clock,
      logger: createLogger('silent'),
    });
    const token = await mintGatewayToken(signer, now);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/complete',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        ...body,
        tools: [{ name: 'page.attach_user_page', description: 'attach', parameters: { type: 'object' } }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(vendorName).toBe('page__attach_user_page');
    expect(res.json().message.toolCalls).toEqual([
      { id: 'c1', name: 'page.attach_user_page', arguments: '{"url":"https://example.com"}' },
    ]);
    await app.close();
  });
});
