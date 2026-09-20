import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write-ahead ledger. The ordering is the whole point.
 *
 * Nasiko's MAF retries a failed step up to MAF_MAX_ATTEMPTS (default 3), and the
 * flow guard kills any agent-to-agent call at 120s wall clock. A Hetzner provision
 * that succeeds at 95s but whose response is lost at 120s therefore comes back as a
 * "failure" and gets retried — buying a second and third server.
 *
 * Recording intent BEFORE the spend closes that hole: the retry finds an existing
 * INTENT row for the same key and refuses instead of re-spending.
 */
export type StepState = 'INTENT' | 'COMMITTED' | 'FAILED';

export interface LedgerRow {
  ts: string;
  run_id: string;
  mandate_id: string;
  nonce: string;
  step: string;
  /** Idempotency key: stable across retries of the same logical action. */
  key: string;
  state: StepState;
  detail?: Record<string, unknown>;
}

export interface Ledger {
  append(row: Omit<LedgerRow, 'ts'>): Promise<void>;
  rows(): Promise<LedgerRow[]>;
}

/** Append-only JSONL ledger. Swap for Redis/Postgres in production; the contract holds. */
export class FileLedger implements Ledger {
  readonly #path: string;
  readonly #now: () => Date;
  #cache: LedgerRow[] | null = null;

  /** `now` is injectable so ledger timestamps and mandate checks share ONE clock. */
  constructor(path: string, now: () => Date = () => new Date()) {
    this.#path = path;
    this.#now = now;
  }

  async append(row: Omit<LedgerRow, 'ts'>): Promise<void> {
    const full: LedgerRow = { ts: this.#now().toISOString(), ...row };
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, JSON.stringify(full) + '\n', 'utf8');
    this.#cache = this.#cache ? [...this.#cache, full] : null;
  }

  async rows(): Promise<LedgerRow[]> {
    if (this.#cache) return this.#cache;
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      return (this.#cache = []);
    }
    return (this.#cache = text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as LedgerRow));
  }
}

export class MemoryLedger implements Ledger {
  #rows: LedgerRow[] = [];
  readonly #now: () => Date;
  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }
  async append(row: Omit<LedgerRow, 'ts'>): Promise<void> {
    this.#rows.push({ ts: this.#now().toISOString(), ...row });
  }
  async rows(): Promise<LedgerRow[]> {
    return this.#rows;
  }
}

export type Claim =
  | { ok: true; key: string }
  | { ok: false; code: 'REPLAY' | 'IN_FLIGHT' | 'ALREADY_COMMITTED'; reason: string; prior: LedgerRow };

/**
 * Claims the right to perform one spending action, write-ahead.
 * Call this BEFORE the provider API call, never after.
 */
export async function claim(
  ledger: Ledger,
  row: Omit<LedgerRow, 'ts' | 'state'>,
): Promise<Claim> {
  const rows = await ledger.rows();
  // Latest row wins: the log is append-only, so a key accumulates INTENT then
  // COMMITTED/FAILED. Reading the first row would report a settled step as in-flight.
  const prior = rows.findLast((r) => r.key === row.key);
  if (prior) {
    if (prior.state === 'COMMITTED') {
      return { ok: false, code: 'ALREADY_COMMITTED', reason: `${row.key} already committed`, prior };
    }
    if (prior.state === 'INTENT') {
      // The dangerous case: a prior attempt may have spent money before dying.
      return {
        ok: false,
        code: 'IN_FLIGHT',
        reason: `${row.key} has an unresolved INTENT from ${prior.ts}; reconcile with the provider before retrying`,
        prior,
      };
    }
  }
  await ledger.append({ ...row, state: 'INTENT' });
  return { ok: true, key: row.key };
}

/** A mandate's nonce may be spent exactly once, across all runs. */
export async function nonceSpent(ledger: Ledger, nonce: string): Promise<LedgerRow | null> {
  return (await ledger.rows()).find((r) => r.nonce === nonce) ?? null;
}

export async function settle(
  ledger: Ledger,
  row: Omit<LedgerRow, 'ts' | 'state'>,
  state: 'COMMITTED' | 'FAILED',
): Promise<void> {
  await ledger.append({ ...row, state });
}
