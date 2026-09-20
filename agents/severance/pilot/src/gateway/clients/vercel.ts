import { requestJson, type HttpOptions } from './http.ts';

const API = 'https://api.vercel.com';

interface VercelEnv {
  key: string;
  value?: string;
  type: string;
  target?: string[] | string;
}

export interface EnvExport {
  vars: { key: string; value: string }[];
  /** Names only. These could not be exported and must be re-entered by hand. */
  skipped: { key: string; reason: string }[];
  /** True if the API reported more pages than we read. */
  truncated: boolean;
}

/**
 * Reads a project's production env vars via GET /v10/projects/{id}/env?decrypt=true.
 *
 * Vercel "sensitive" variables are write-only, so no API can return their value. Rather
 * than silently dropping them we report their NAMES, because a migration that quietly
 * omits STRIPE_SECRET_KEY produces an app that boots and then fails at runtime.
 */
export class VercelClient {
  readonly #token: string;
  readonly #teamId?: string;
  readonly #http: HttpOptions;

  constructor(token: string, opts: { teamId?: string; fetch?: typeof fetch } = {}) {
    this.#token = token;
    this.#teamId = opts.teamId;
    this.#http = { provider: 'vercel', fetch: opts.fetch };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'VercelClient { token: [redacted] }';
  }

  async exportProductionEnvs(projectIdOrName: string): Promise<EnvExport> {
    const q = new URLSearchParams({ decrypt: 'true' });
    if (this.#teamId) q.set('teamId', this.#teamId);
    const r = await requestJson<{ envs?: VercelEnv[]; pagination?: { next?: number | null } } | VercelEnv[]>(
      this.#http,
      `${API}/v10/projects/${encodeURIComponent(projectIdOrName)}/env?${q}`,
      { headers: { authorization: `Bearer ${this.#token}` } },
    );
    const envs = Array.isArray(r) ? r : (r.envs ?? []);
    const truncated = !Array.isArray(r) && r.pagination?.next != null;

    const vars: EnvExport['vars'] = [];
    const skipped: EnvExport['skipped'] = [];
    for (const e of envs) {
      const targets = Array.isArray(e.target) ? e.target : e.target ? [e.target] : [];
      if (!targets.includes('production')) continue;
      if (e.type === 'system') continue; // VERCEL_* are provided by the platform, not the app
      if (e.type === 'sensitive' || e.value === undefined || e.value === '') {
        skipped.push({ key: e.key, reason: e.type === 'sensitive' ? 'sensitive (write-only on Vercel)' : 'no readable value' });
        continue;
      }
      vars.push({ key: e.key, value: e.value });
    }
    return { vars, skipped, truncated };
  }
}
