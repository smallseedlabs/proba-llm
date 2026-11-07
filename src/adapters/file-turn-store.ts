import { mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { TurnRecord, TurnStore } from '../ports/turn-store.js';

/**
 * Directory of one JSON file per turn. Writes fsync+rename so a restart can
 * replay unpublished protocol events without calling the provider again.
 */
export class FileTurnStore implements TurnStore {
  constructor(private readonly dir: string) {}

  private fileFor(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('turn store key must be a sha256 hex digest');
    return join(this.dir, `${key}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async get(key: string): Promise<TurnRecord | undefined> {
    try {
      const raw = await readFile(this.fileFor(key), 'utf8');
      return JSON.parse(raw) as TurnRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async put(record: TurnRecord): Promise<void> {
    await this.ensureDir();
    const target = this.fileFor(record.key);
    const tmp = `${target}.${process.pid}.tmp`;
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(record), 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, target);
    const dirFh = await open(this.dir, 'r');
    try {
      await dirFh.sync();
    } finally {
      await dirFh.close();
    }
  }

  async unpublished(): Promise<TurnRecord[]> {
    await this.ensureDir();
    const names = await readdir(this.dir);
    const out: TurnRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const row = JSON.parse(await readFile(join(this.dir, name), 'utf8')) as TurnRecord;
      if (row.events.some((event) => !row.publishedEventIds.includes(event.eventId))) out.push(row);
    }
    return out;
  }

  async markPublished(key: string, eventId: string): Promise<void> {
    const row = await this.get(key);
    if (!row) return;
    if (!row.publishedEventIds.includes(eventId)) {
      row.publishedEventIds.push(eventId);
      await this.put(row);
    }
  }

  async close(): Promise<void> {
    return;
  }
}
