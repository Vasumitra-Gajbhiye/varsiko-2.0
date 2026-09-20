import type { VercelProject } from './types.ts';

const API = 'https://api.vercel.com';

export class VercelApiError extends Error {
  readonly status: number;
  constructor(status: number, path: string, hint?: string) {
    super(`Vercel API ${status} on ${path}${hint ? `: ${hint}` : ''}`);
    this.name = 'VercelApiError';
    this.status = status;
  }
}

const HINTS: Record<number, string> = {
  401: 'token is invalid or expired',
  403:
    'token lacks access. Billing data is team-level: a project-scoped token cannot read it, ' +
    'and your role must be Owner, Member, Developer, Security, Billing or Enterprise Viewer',
};

export interface VercelClientOptions {
  token: string;
  teamId?: string;
  fetch?: typeof fetch;
  /** Retries on 429/5xx. */
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Read-only by construction: the only verb this class can send is GET.
 * Vercel has no read-only token scope, so this is where the guarantee lives.
 */
export class VercelReadOnlyClient {
  readonly #token: string;
  readonly #teamId?: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;

  constructor(opts: VercelClientOptions) {
    if (!opts.token) throw new Error('A Vercel access token is required');
    this.#token = opts.token;
    this.#teamId = opts.teamId;
    this.#fetch = opts.fetch ?? fetch;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
  }

  // Keep the token out of console.log / util.inspect / JSON.stringify.
  toJSON() {
    return { teamId: this.#teamId };
  }
  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'VercelReadOnlyClient { token: [redacted] }';
  }

  async #get(path: string, query: Record<string, string | undefined> = {}): Promise<Response> {
    const url = new URL(path, API);
    if (this.#teamId) url.searchParams.set('teamId', this.#teamId);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json, application/jsonl' },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < this.#maxRetries) {
        const header = res.headers.get('retry-after');
        const retryAfter = header === null ? NaN : Number(header);
        const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new VercelApiError(res.status, url.pathname, HINTS[res.status]);
      }
      return res;
    }
  }

  async listProjects(): Promise<VercelProject[]> {
    const out: VercelProject[] = [];
    let from: string | undefined;
    do {
      const body = (await (await this.#get('/v10/projects', { limit: '100', from })).json()) as
        | VercelProject[]
        | { projects: VercelProject[]; pagination?: { next?: number | string | null } };
      if (Array.isArray(body)) return body;
      out.push(...body.projects);
      const next = body.pagination?.next;
      from = next == null ? undefined : String(next);
    } while (from);
    return out;
  }

  async findProject(nameOrId: string): Promise<VercelProject> {
    const all = await this.listProjects();
    const hit = all.find((p) => p.id === nameOrId || p.name === nameOrId);
    if (!hit) {
      const names = all.map((p) => p.name).slice(0, 20).join(', ');
      throw new Error(`No project "${nameOrId}" visible to this token. Visible: ${names || '(none)'}`);
    }
    return hit;
  }

  /** Streams the FOCUS v1.3 JSONL body. `from` inclusive, `to` exclusive, ISO 8601 UTC. */
  async billingCharges(from: string, to: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.#get('/v1/billing/charges', { from, to });
    if (!res.body) throw new Error('Billing response had no body');
    return res.body;
  }
}
