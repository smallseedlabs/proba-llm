import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTurnStore } from './file-turn-store.js';
import { hashedTurnKey } from '../audit/fingerprint.js';
import type { TurnRecord } from '../ports/turn-store.js';

describe('FileTurnStore', () => {
  it('survives process restart and keeps unpublished events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'proba-llm-turns-'));
    const key = hashedTurnKey('proba-gateway', 'gateway', '550e8400-e29b-41d4-a716-446655440000');
    const record: TurnRecord = {
      key,
      callerIss: 'proba-gateway',
      callerSub: 'gateway',
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      fingerprint: 'abc',
      state: 'completed',
      response: {
        message: { role: 'assistant', content: 'ok' },
        finishReason: 'stop',
        model: 'fake-test-model',
        provider: 'fake',
        usage: {},
        latencyMs: 1,
        cost: { estimate: 'unknown' },
      },
      events: [
        {
          version: 1,
          eventId: '11111111-1111-4111-8111-111111111111',
          traceId: '550e8400-e29b-41d4-a716-446655440000',
          spanId: 'aaaaaaaaaaaaaaaa',
          workspaceId: 'seedbed',
          actor: { type: 'service', id: 'gateway' },
          service: 'llm',
          action: 'brain.llm_call',
          category: 'brain',
          outcome: 'success',
          occurredAt: '2026-01-01T00:00:00.000Z',
          details: {},
        },
      ],
      publishedEventIds: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const first = new FileTurnStore(dir);
    await first.put(record);
    const restarted = new FileTurnStore(dir);
    const loaded = await restarted.get(key);
    expect(loaded?.response?.message.content).toBe('ok');
    expect((await restarted.unpublished())[0]?.events[0]?.eventId).toBe(record.events[0].eventId);
    await restarted.markPublished(key, record.events[0].eventId);
    expect(await restarted.unpublished()).toHaveLength(0);
    await rm(dir, { recursive: true, force: true });
  });
});
