import { requestJson, type HttpOptions } from './http.ts';

const API = 'https://api.anakin.io/v1/url-scraper';

export interface AnakinJob {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  markdown?: string;
  error?: string;
}

/**
 * Anakin URL Scraper: POST /v1/url-scraper -> {jobId}, GET /v1/url-scraper/{id} ->
 * {status, markdown, error}. Auth is X-API-Key. Field names are from Anakin's docs.
 * useBrowser is on because the vendor pricing page is JS-rendered.
 */
export class AnakinClient {
  readonly #key: string;
  readonly #http: HttpOptions;

  constructor(apiKey: string, opts: { fetch?: typeof fetch } = {}) {
    this.#key = apiKey;
    this.#http = { provider: 'anakin', fetch: opts.fetch };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'AnakinClient { key: [redacted] }';
  }

  async submit(url: string): Promise<{ jobId: string }> {
    const r = await requestJson<{ jobId?: string }>(this.#http, API, {
      method: 'POST',
      headers: { 'x-api-key': this.#key },
      body: { url, country: 'us', formats: ['markdown'], useBrowser: true },
    });
    if (!r.jobId) throw new Error('anakin: submit response had no jobId');
    return { jobId: r.jobId };
  }

  async status(jobId: string): Promise<AnakinJob> {
    const r = await requestJson<AnakinJob>(this.#http, `${API}/${encodeURIComponent(jobId)}`, {
      headers: { 'x-api-key': this.#key },
    });
    return { status: r.status, markdown: r.markdown, error: r.error };
  }
}
