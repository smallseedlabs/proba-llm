import { describe, expect, it } from 'vitest';
import { SingleTurnHandler } from './single-turn.js';
import { FakeLlmProvider } from '../testing/fake-provider.js';
import { MemoryAuditPublisher } from '../testing/memory-audit.js';
import { MemoryTurnStore } from '../adapters/memory-turn-store.js';
import { SystemClock } from '../adapters/system-clock.js';
import { loadConfig } from '../config.js';
import type { TurnRequest } from '../types/turn.js';
import type { VerifiedCaller } from '../ports/auth.js';
import { AmbiguousProviderError, IdempotencyConflictError } from '../errors.js';
import { TurnAbortedError } from '../errors.js';
import { AUDIT_CONTENT_MAX_CHARS, validateAuditEvent } from '../protocol.js';
import { joinAuditBody } from '../audit/body-chunks.js';
import { parseConsumerStreamFields } from '../audit/consumer-parse.js';
import { hashedTurnKey, requestFingerprint } from '../audit/fingerprint.js';

const caller: VerifiedCaller = {
  issuer: 'proba-gateway',
  subject: 'gateway',
  jti: 'jti-1',
  keyId: 'k1',
  expiresAt: new Date('2099-01-01T00:00:00Z'),
};

const otherCaller: VerifiedCaller = { ...caller, issuer: 'proba-other', subject: 'other' };

const baseRequest: TurnRequest = {
  traceId: '550e8400-e29b-41d4-a716-446655440000',
  workspaceId: 'seedbed',
  messages: [{ role: 'user', content: 'hello api_key=sk-live-abcdefghijklmnopqrstuvwxyz' }],
};

function handler(
  provider: FakeLlmProvider,
  audit = new MemoryAuditPublisher(),
  turns = new MemoryTurnStore(),
  extraEnv: Record<string, string> = {}
) {
  const config = loadConfig({
    NODE_ENV: 'test',
    LLM_BASE_URL: 'https://api.deepseek.com',
    LLM_MODEL: 'deepseek-chat',
    LLM_ALLOWED_HOSTS: 'api.deepseek.com',
    LLM_ALLOWED_MODELS: 'deepseek-chat,fake-test-model',
    AUDIT_CONTENT_ENABLED: 'true',
    LLM_MAX_MESSAGE_CHARS: '40000',
    ...extraEnv,
  });
  return { audit, turns, inner: new SingleTurnHandler({ provider, audit, clock: new SystemClock(), config, turns }) };
}

describe('SingleTurnHandler', () => {
  it('returns tool-call proposals without executing them and audits redacted prompt/response', async () => {
    const provider = new FakeLlmProvider({
      responder: async () => ({
        content: null,
        toolCalls: [{ id: '1', name: 'launch_campaign', arguments: '{"budget":1}' }],
        model: 'fake-test-model',
        finishReason: 'tool_calls',
        usage: { promptTokens: 4, completionTokens: 2 },
      }),
    });
    const { inner, audit } = handler(provider);
    const result = await inner.handle(baseRequest, caller);
    expect(result.message.toolCalls?.[0]?.name).toBe('launch_campaign');
    expect(provider.calls).toHaveLength(1);
    expect(audit.events.map((e) => e.action)).toEqual(['brain.llm_call', 'brain.reply_generated', 'tool.proposed']);
    expect(audit.events[0].traceId).toBe(baseRequest.traceId);
    expect(JSON.stringify(audit.events)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
    expect(audit.events[0].content?.kind).toBe('prompt');
    expect(audit.events[2].details).toMatchObject({ tool: 'launch_campaign' });
    const ids = audit.events.map((e) => e.eventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('audits cache-aware cost and both cache token counts', async () => {
    const provider = new FakeLlmProvider({
      responder: async () => ({
        content: 'ok',
        model: 'fake-test-model',
        finishReason: 'stop',
        usage: { promptTokens: 1_000, completionTokens: 50, cachedTokens: 800, cacheMissTokens: 200 },
      }),
    });
    const { inner, audit } = handler(provider, new MemoryAuditPublisher(), new MemoryTurnStore(), {
      PRICE_PROMPT_USD_PER_MILLION: '0.3',
      PRICE_COMPLETION_USD_PER_MILLION: '1.2',
      PRICE_PROMPT_CACHE_HIT_USD_PER_MILLION: '0.006',
    });
    const result = await inner.handle(baseRequest, caller);
    const expected = (800 / 1_000_000) * 0.006 + (200 / 1_000_000) * 0.3 + (50 / 1_000_000) * 1.2;
    expect(result.cost.estimate).toBeCloseTo(expected, 12);
    expect(result.usage).toMatchObject({ cachedTokens: 800, cacheMissTokens: 200, promptTokens: 1_000, completionTokens: 50 });
    const call = audit.events.find((e) => e.action === 'brain.llm_call');
    expect(call?.cost?.amount).toBeCloseTo(expected, 12);
    expect(call?.details?.pricingVersion).toBe('env:0.3/1.2/hit:0.006');
    expect(call?.details?.costEstimate).toBeCloseTo(expected, 12);
  });

  it('does not redispatch the provider when Redis publish fails, and retries publish the same eventIds', async () => {
    const provider = new FakeLlmProvider();
    const audit = new MemoryAuditPublisher();
    audit.failPublish = true;
    const { inner, turns } = handler(provider, audit);
    const first = await inner.handle(baseRequest, caller);
    expect(first.message.content).toBe('ok');
    expect(provider.calls).toHaveLength(1);
    expect(audit.events).toHaveLength(0);
    const pending = await turns.unpublished();
    expect(pending[0]?.events.length).toBeGreaterThan(0);
    const eventIds = pending[0]!.events.map((e) => e.eventId);

    audit.failPublish = false;
    const second = await inner.handle(baseRequest, caller);
    expect(second.message.content).toBe('ok');
    expect(provider.calls).toHaveLength(1);
    expect(audit.events.map((e) => e.eventId)).toEqual(eventIds);
  });

  it('isolates idempotency by caller and conflicts on a different body', async () => {
    const provider = new FakeLlmProvider();
    const { inner } = handler(provider);
    await inner.handle(baseRequest, caller);
    await inner.handle(baseRequest, otherCaller);
    expect(provider.calls).toHaveLength(2);
    await expect(
      inner.handle({ ...baseRequest, messages: [{ role: 'user', content: 'other' }] }, caller)
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(provider.calls).toHaveLength(2);
  });

  it('treats a leftover inflight record as ambiguous and does not redispatch', async () => {
    const provider = new FakeLlmProvider();
    const turns = new MemoryTurnStore();
    const key = hashedTurnKey(caller.issuer, caller.subject, baseRequest.traceId);
    await turns.put({
      key,
      callerIss: caller.issuer,
      callerSub: caller.subject,
      idempotencyKey: baseRequest.traceId,
      fingerprint: requestFingerprint(baseRequest),
      state: 'inflight',
      events: [],
      publishedEventIds: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const { inner } = handler(provider, new MemoryAuditPublisher(), turns);
    await expect(inner.handle(baseRequest, caller)).rejects.toBeInstanceOf(AmbiguousProviderError);
    expect(provider.calls).toHaveLength(0);
  });

  it('does not retry an ambiguous provider dispatch', async () => {
    const provider = new FakeLlmProvider({
      responder: async () => {
        throw new TurnAbortedError('timed out after send');
      },
    });
    const { inner } = handler(provider);
    await expect(inner.handle(baseRequest, caller)).rejects.toBeInstanceOf(AmbiguousProviderError);
    await expect(inner.handle(baseRequest, caller)).rejects.toBeInstanceOf(AmbiguousProviderError);
    expect(provider.calls).toHaveLength(1);
  });

  it('persists full redacted bodies as protocol content chunks the consumer accepts', async () => {
    const big = `prompt ${'x'.repeat(AUDIT_CONTENT_MAX_CHARS + 50)} api_key=sk-live-abcdefghijklmnopqrstuvwxyz`;
    const provider = new FakeLlmProvider({
      responder: async () => ({
        content: `reply ${'y'.repeat(AUDIT_CONTENT_MAX_CHARS + 20)}`,
        model: 'fake-test-model',
        finishReason: 'stop',
        usage: { promptTokens: 8, completionTokens: 8 },
      }),
    });
    const { inner, audit } = handler(provider);
    await inner.handle({ ...baseRequest, messages: [{ role: 'user', content: big }] }, caller);
    for (const event of audit.events) {
      expect(validateAuditEvent(event).success).toBe(true);
      if (event.content) expect(event.content.text.length).toBeLessThanOrEqual(AUDIT_CONTENT_MAX_CHARS);
      const roundTrip = parseConsumerStreamFields({
        data: JSON.stringify(event),
        publishedAt: event.occurredAt,
        key: event.workspaceId,
      });
      expect(roundTrip.eventId).toBe(event.eventId);
      expect(roundTrip.content?.text).toBe(event.content?.text);
    }
    const promptParts = audit.events.filter((e) => e.content?.kind === 'prompt').map((e) => e.content!);
    const replyParts = audit.events.filter((e) => e.content?.kind === 'brain_reply').map((e) => e.content!);
    expect(joinAuditBody(promptParts).includes('sk-live-abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(joinAuditBody(promptParts).length).toBeGreaterThan(AUDIT_CONTENT_MAX_CHARS);
    expect(joinAuditBody(replyParts).length).toBeGreaterThan(AUDIT_CONTENT_MAX_CHARS);
    expect(JSON.stringify(audit.events)).not.toContain('sk-live-abcdefghijklmnopqrstuvwxyz');
  });
});
