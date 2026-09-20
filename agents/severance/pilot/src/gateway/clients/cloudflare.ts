import { requestJson, ProviderError, type HttpOptions } from './http.ts';

const API = 'https://api.cloudflare.com/client/v4';

interface Envelope<T> {
  success: boolean;
  errors?: { message: string }[];
  result: T;
}

export interface DnsPrevious {
  content: string;
  ttl: number;
  proxied: boolean;
}

/**
 * Cloudflare DNS. Written from Cloudflare's long-stable v4 API (zones lookup, dns_records
 * list/create/patch/delete, {success, errors, result} envelope), NOT from a fetched doc
 * page: that fetch timed out during the build. Verify against a real zone.
 */
export class CloudflareClient {
  readonly #token: string;
  readonly #http: HttpOptions;

  constructor(token: string, opts: { fetch?: typeof fetch } = {}) {
    this.#token = token;
    this.#http = { provider: 'cloudflare', fetch: opts.fetch };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'CloudflareClient { token: [redacted] }';
  }

  async #call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const r = await requestJson<Envelope<T>>(this.#http, `${API}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (r.success === false) {
      throw new ProviderError('cloudflare', 400, (r.errors ?? []).map((e) => e.message).join('; ') || 'request failed');
    }
    return r.result;
  }

  /** Finds the zone by trying the domain, then each parent, most specific first. */
  async zoneIdFor(domain: string): Promise<string> {
    const labels = domain.toLowerCase().split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      const candidate = labels.slice(i).join('.');
      const zones = await this.#call<{ id: string; name: string }[]>(`/zones?name=${encodeURIComponent(candidate)}`);
      const hit = zones.find((z) => z.name === candidate);
      if (hit) return hit.id;
    }
    throw new ProviderError('cloudflare', 404, `no zone visible to this token for ${domain}`);
  }

  async getARecord(zoneId: string, name: string) {
    const rs = await this.#call<{ id: string; content: string; ttl: number; proxied: boolean }[]>(
      `/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
    );
    return rs[0] ?? null;
  }

  /** TTL 60 so a rollback propagates quickly. Not proxied: the origin is what we are testing. */
  async upsertA(zoneId: string, name: string, ip: string) {
    const existing = await this.getARecord(zoneId, name);
    const body = { type: 'A', name, content: ip, ttl: 60, proxied: false };
    if (existing) {
      await this.#call(`/zones/${zoneId}/dns_records/${existing.id}`, { method: 'PATCH', body });
      return {
        record_id: existing.id,
        previous: { content: existing.content, ttl: existing.ttl, proxied: existing.proxied } as DnsPrevious,
      };
    }
    const created = await this.#call<{ id: string }>(`/zones/${zoneId}/dns_records`, { method: 'POST', body });
    return { record_id: created.id, previous: null as DnsPrevious | null };
  }

  /** Restores the prior record, or deletes the one we created. */
  async restore(zoneId: string, recordId: string, name: string, previous: DnsPrevious | null) {
    if (previous) {
      await this.#call(`/zones/${zoneId}/dns_records/${recordId}`, {
        method: 'PATCH',
        body: { type: 'A', name, ...previous },
      });
    } else {
      await this.#call(`/zones/${zoneId}/dns_records/${recordId}`, { method: 'DELETE' });
    }
  }
}
