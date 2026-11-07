/**
 * Durable producer handoff for one model turn (Hub outbox analogue, local to this
 * service). Not an audit database: events still go to the existing Redis stream
 * and proba-audit consumer. Survives Redis outages and process restart so a
 * retried complete never redispatches a paid provider call.
 */

import type { AuditEvent } from '../protocol.js';
import type { TurnResponse } from '../types/turn.js';

export type TurnState = 'inflight' | 'completed' | 'failed' | 'ambiguous';

export interface TurnRecord {
  key: string;
  callerIss: string;
  callerSub: string;
  idempotencyKey: string;
  fingerprint: string;
  state: TurnState;
  response?: TurnResponse;
  errorCode?: string;
  errorMessage?: string;
  events: AuditEvent[];
  publishedEventIds: string[];
  updatedAt: string;
}

export interface TurnStore {
  get(key: string): Promise<TurnRecord | undefined>;
  /** Atomic replace. File adapters fsync before resolve. */
  put(record: TurnRecord): Promise<void>;
  unpublished(): Promise<TurnRecord[]>;
  markPublished(key: string, eventId: string): Promise<void>;
  close(): Promise<void>;
}

export function turnStoreKey(issuer: string, subject: string, idempotencyKey: string): string {
  return `${issuer}\n${subject}\n${idempotencyKey}`;
}
