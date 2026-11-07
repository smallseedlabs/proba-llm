import { createHash } from 'node:crypto';
import type { TurnRequest } from '../types/turn.js';

/** Canonical hash of the turn payload (not caller identity). */
export function requestFingerprint(request: TurnRequest): string {
  const canonical = JSON.stringify({
    workspaceId: request.workspaceId,
    userId: request.userId ?? null,
    goalId: request.goalId ?? null,
    threadId: request.threadId ?? null,
    messages: request.messages,
    tools: request.tools ?? null,
    json: request.json ?? null,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    model: request.model ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function hashedTurnKey(issuer: string, subject: string, idempotencyKey: string): string {
  return createHash('sha256').update(`${issuer}\n${subject}\n${idempotencyKey}`).digest('hex');
}
