import { requestJson, type HttpOptions } from './http.ts';

const API = 'https://api.hetzner.cloud/v1';

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  ip: string;
  labels: Record<string, string>;
}

interface RawServer {
  id: number;
  name: string;
  status: string;
  labels?: Record<string, string>;
  public_net?: { ipv4?: { ip?: string } };
}

const toServer = (s: RawServer): HetznerServer => ({
  id: s.id,
  name: s.name,
  status: s.status,
  ip: s.public_net?.ipv4?.ip ?? '',
  labels: s.labels ?? {},
});

/** Label values: Hetzner allows [A-Za-z0-9._-], max 63, and selectors are not escaped. */
export const safeLabel = (v: string) => {
  if (!/^[A-Za-z0-9._-]{1,63}$/.test(v)) throw new Error(`unsafe label value: ${v}`);
  return v;
};

export class HetznerClient {
  readonly #token: string;
  readonly #http: HttpOptions;

  constructor(token: string, opts: { fetch?: typeof fetch } = {}) {
    this.#token = token;
    this.#http = { provider: 'hetzner', fetch: opts.fetch };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'HetznerClient { token: [redacted] }';
  }

  #h() {
    return { authorization: `Bearer ${this.#token}` };
  }

  async createServer(a: {
    name: string;
    server_type: string;
    image: string;
    location: string;
    ssh_keys: string[];
    user_data: string;
    labels: Record<string, string>;
    firewall_id?: number;
  }): Promise<HetznerServer> {
    const body = {
      name: a.name,
      server_type: a.server_type,
      image: a.image,
      location: a.location,
      ssh_keys: a.ssh_keys,
      user_data: a.user_data,
      labels: a.labels,
      start_after_create: true,
      ...(a.firewall_id ? { firewalls: [{ firewall: a.firewall_id }] } : {}),
    };
    const r = await requestJson<{ server: RawServer }>(this.#http, `${API}/servers`, {
      method: 'POST',
      headers: this.#h(),
      body,
    });
    return toServer(r.server);
  }

  async getServer(id: number): Promise<HetznerServer> {
    const r = await requestJson<{ server: RawServer }>(this.#http, `${API}/servers/${id}`, { headers: this.#h() });
    return toServer(r.server);
  }

  /** Used to reconcile after a lost create response: did the purchase actually happen? */
  async findByLabel(key: string, value: string): Promise<HetznerServer[]> {
    const sel = encodeURIComponent(`${safeLabel(key)}=${safeLabel(value)}`);
    const r = await requestJson<{ servers: RawServer[] }>(this.#http, `${API}/servers?label_selector=${sel}`, {
      headers: this.#h(),
    });
    return r.servers.map(toServer);
  }

  async deleteServer(id: number): Promise<void> {
    await requestJson(this.#http, `${API}/servers/${id}`, { method: 'DELETE', headers: this.#h() });
  }
}
