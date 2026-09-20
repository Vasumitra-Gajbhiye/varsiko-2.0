import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from '../pilot/runbook.ts';

export type StoredRun = {
  state: RunState;
  mandateToken: string;
  auditorPassToken?: string;
  contextId?: string;
  updatedAt: string;
};

/**
 * One JSON file per run_id. Single-replica assumption; mutex prevents concurrent advances.
 */
export class RunStore {
  readonly #dir: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #ensure(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  pathFor(runId: string): string {
    const safe = runId.replace(/[^A-Za-z0-9._-]/g, '_');
    return join(this.#dir, `${safe}.json`);
  }

  async get(runId: string): Promise<StoredRun | null> {
    await this.#ensure();
    try {
      const raw = await readFile(this.pathFor(runId), 'utf8');
      return JSON.parse(raw) as StoredRun;
    } catch {
      return null;
    }
  }

  async put(run: StoredRun): Promise<void> {
    await this.#ensure();
    const body = JSON.stringify({ ...run, updatedAt: new Date().toISOString() }, null, 2);
    await writeFile(this.pathFor(run.state.run_id), body + '\n', 'utf8');
  }

  /** Serialize work for a given run_id so two polls cannot advance concurrently. */
  async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.#locks.set(
      runId,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(runId) === gate) this.#locks.delete(runId);
    }
  }
}
