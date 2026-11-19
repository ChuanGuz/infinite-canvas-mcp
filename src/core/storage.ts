import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StoreSchema } from '../types/schema.js';
import type { Store } from '../types/schema.js';
import { buildHandoff } from './handoff.js';

export const emptyStore = (): Store => ({
  schemaVersion: 1, activeCanvasId: null, groups: [], canvases: [], crossProjectExperiences: [],
});

/** Same-directory temp + fsync + rename keeps readers from seeing partial JSON. */
export function atomicWriteFile(path: string, contents: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx');
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export class JsonStorage {
  readonly dataDir: string;
  readonly storePath: string;
  readonly handoffDir: string;
  private readonly lockPath: string;

  constructor(dataDir = resolve('data')) {
    this.dataDir = resolve(dataDir);
    this.storePath = join(this.dataDir, 'store.json');
    this.handoffDir = join(this.dataDir, 'handoffs');
    this.lockPath = join(this.dataDir, 'store.lock');
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.handoffDir, { recursive: true });
  }

  private locked<T>(operation: () => T): T {
    let fd: number;
    try { fd = openSync(this.lockPath, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error(`Store is locked: ${this.lockPath}. Retry after the writer exits; remove a stale lock only after confirming no writer is running.`, { cause: error });
      throw error;
    }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return operation();
    } finally { closeSync(fd); unlinkSync(this.lockPath); }
  }

  initialize(factory: () => Store = emptyStore): void {
    this.locked(() => {
      // Only a genuinely absent store may seed; invalid JSON/schema is never overwritten.
      if (!existsSync(this.storePath)) this.commit(factory());
      else this.syncHandoffs(this.read());
    });
  }

  read(): Store {
    return StoreSchema.parse(JSON.parse(readFileSync(this.storePath, 'utf8')) as unknown);
  }

  transaction<T>(mutate: (draft: Store) => T): T {
    return this.locked(() => {
      // Reload inside the lock so multiple engine instances cannot lose each other's updates.
      const draft = this.read();
      const result = mutate(draft);
      this.commit(draft);
      return structuredClone(result);
    });
  }

  syncHandoffs(store: Store): void {
    for (const canvas of store.canvases) {
      const path = join(this.handoffDir, `HANDOFF-${canvas.id}.md`);
      const markdown = buildHandoff(store, canvas).markdown;
      if (!existsSync(path) || readFileSync(path, 'utf8') !== markdown) atomicWriteFile(path, markdown);
    }
  }

  private commit(input: Store): void {
    const store = StoreSchema.parse(input);
    // Render/validate all derived documents before committing the source of truth.
    for (const canvas of store.canvases) buildHandoff(store, canvas);
    atomicWriteFile(this.storePath, `${JSON.stringify(store, null, 2)}\n`);
    try { this.syncHandoffs(store); }
    catch (error) {
      throw new Error('Store committed, but handoff synchronization failed. Restart the engine to rebuild Markdown mirrors.', { cause: error });
    }
  }
}
