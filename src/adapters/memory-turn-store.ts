import type { TurnRecord, TurnStore } from '../ports/turn-store.js';

export class MemoryTurnStore implements TurnStore {
  readonly records = new Map<string, TurnRecord>();

  async get(key: string): Promise<TurnRecord | undefined> {
    const row = this.records.get(key);
    return row ? structuredClone(row) : undefined;
  }

  async put(record: TurnRecord): Promise<void> {
    this.records.set(record.key, structuredClone(record));
  }

  async unpublished(): Promise<TurnRecord[]> {
    return [...this.records.values()]
      .filter((row) => row.events.some((event) => !row.publishedEventIds.includes(event.eventId)))
      .map((row) => structuredClone(row));
  }

  async markPublished(key: string, eventId: string): Promise<void> {
    const row = this.records.get(key);
    if (!row) return;
    if (!row.publishedEventIds.includes(eventId)) row.publishedEventIds.push(eventId);
  }

  async close(): Promise<void> {
    return;
  }
}
