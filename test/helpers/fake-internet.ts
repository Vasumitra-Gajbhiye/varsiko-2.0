import { createHash } from 'node:crypto';

export const SERVER_IP = '203.0.113.42';
export const COOLIFY_HOST = `${SERVER_IP}:8000`;

export interface FakeInternetOptions {
  /** Hetzner creates the server, then the response is lost (network error). Once. */
  hetznerLoseResponse?: boolean;
  /** Coolify's authenticated API answers 401 until this many /teams/current calls. */
  bootAfterCalls?: number;
  /** Deployment reports in_progress this many times before finishing. */
  deployPolls?: number;
  deployFails?: boolean;
  /** Network errors on the first N GET /deployments calls. */
  deployStatusBlips?: number;
  priceJobPolls?: number;
  priceMarkdown?: string;
  /** Every Hetzner call answers 401, as with a revoked or wrong token. */
  hetznerUnauthorized?: boolean;
  /** SSH key names that exist in the Hetzner project. */
  sshKeyNames?: string[];
  /** Server types Hetzner lists. */
  serverTypes?: string[];
  /** Server types Hetzner marks deprecated. */
  deprecatedServerTypes?: string[];
  /** Inbound sources on the firewall's tcp/8000 rule. Empty list means no rule at all. */
  firewallSources?: string[];
  /** Cloudflare token verify returns an inactive token. */
  cloudflareInactive?: boolean;
}

interface FakeServer {
  id: number;
  name: string;
  labels: Record<string, string>;
  ip: string;
  user_data: string;
  created: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake internet that speaks just enough of the Hetzner, Coolify, Cloudflare, Vercel and
 * Anakin APIs for the gateway's real clients to run against. It also simulates cloud-init:
 * Coolify's API only accepts the token whose SHA-256 was written into the server's
 * user_data, exactly as the bootstrap script would install it.
 *
 * Response shapes follow the public docs where they were fetched; Cloudflare's and
 * Coolify's server list are from memory. Nothing here proves the real APIs agree.
 */
export class FakeInternet {
  readonly opts: Required<FakeInternetOptions>;
  readonly servers = new Map<number, FakeServer>();
  /** user_data of boxes a HUMAN bought (handoff lane), by IP. Never created through the Hetzner API. */
  readonly humanBoxes = new Map<string, string>();
  readonly requests: { method: string; host: string; path: string; search: string }[] = [];
  readonly envsReceived: { key: string; value: string }[] = [];
  readonly appBodies: Record<string, unknown>[] = [];
  readonly dns = new Map<string, { id: string; content: string; ttl: number; proxied: boolean }>();
  #nextId = 5000;
  #lostOnce = false;
  #teamCalls = 0;
  #deployPolls = 0;
  #blips = 0;
  #priceCalls = 0;

  constructor(opts: FakeInternetOptions = {}) {
    this.opts = {
      hetznerLoseResponse: false,
      bootAfterCalls: 2,
      deployPolls: 2,
      deployFails: false,
      deployStatusBlips: 0,
      priceJobPolls: 2,
      priceMarkdown: '| Name | Price |\n|---|---|\n| CPX31 | $15.00/mo |',
      hetznerUnauthorized: false,
      sshKeyNames: ['ops-key'],
      serverTypes: ['cpx21', 'cpx31', 'cpx41'],
      deprecatedServerTypes: [],
      firewallSources: ['198.51.100.7/32'],
      cloudflareInactive: false,
      ...opts,
    };
  }

  /** Servers the fake believes exist; used to plant a foreign one for safety tests. */
  plant(name: string, labels: Record<string, string>, ip = '203.0.113.99'): number {
    const id = this.#nextId++;
    this.servers.set(id, { id, name, labels, ip, user_data: '', created: '2026-09-20T12:00:00Z' });
    return id;
  }

  /** Simulates a human pasting the rendered cloud-init into a vendor's user-data field and booting the box. */
  humanBuys(userData: string, ip = SERVER_IP) {
    this.humanBoxes.set(ip, userData);
  }

  #expectedTokenHash(): string | null {
    for (const ud of [...[...this.servers.values()].map((s) => s.user_data), ...this.humanBoxes.values()]) {
      const m = /forceFill\(\['token' => '([0-9a-f]{64})'\]\)/.exec(ud);
      if (m) return m[1]!;
    }
    return null;
  }

  #serverJson(s: FakeServer) {
    return { id: s.id, name: s.name, status: 'running', created: s.created, labels: s.labels, public_net: { ipv4: { ip: s.ip } } };
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, any>) : undefined;
    this.requests.push({ method, host: url.host, path: url.pathname, search: url.search });

    if (url.host === 'api.hetzner.cloud') return this.#hetzner(method, url, body);
    if (url.host === COOLIFY_HOST) return this.#coolify(method, url, headers, body);
    if (url.host === 'api.cloudflare.com') return this.#cloudflare(method, url, body);
    if (url.host === 'api.vercel.com') return this.#vercel(url);
    if (url.host === 'api.anakin.io') return this.#anakin(method, url);
    return json({ error: `fake internet has no route for ${url.host}` }, 502);
  };

  #hetzner(method: string, url: URL, body?: Record<string, any>): Response {
    const path = url.pathname.replace('/v1', '');
    if (this.opts.hetznerUnauthorized) return json({ error: { code: 'unauthorized', message: 'unable to authenticate' } }, 401);

    // Read-only routes used by `npm run preflight`. Shapes are from memory of the docs.
    if (method === 'GET' && path === '/ssh_keys') {
      return json({ ssh_keys: this.opts.sshKeyNames.map((name, i) => ({ id: 100 + i, name })), meta: { pagination: { next_page: null } } });
    }
    if (method === 'GET' && path === '/locations') {
      return json({ locations: ['fsn1', 'nbg1', 'hel1'].map((name, id) => ({ id, name })) });
    }
    if (method === 'GET' && path === '/server_types') {
      const want = url.searchParams.get('name');
      const types = this.opts.serverTypes
        .filter((n) => !want || n === want)
        .map((name, id) => ({
          id,
          name,
          deprecated: this.opts.deprecatedServerTypes.includes(name),
          prices: [{ location: 'nbg1', price_monthly: { net: '10.92', gross: '13.00' } }],
        }));
      return json({ server_types: types, meta: { pagination: { next_page: null } } });
    }
    if (method === 'GET' && path === '/firewalls/42') {
      const rules: Record<string, unknown>[] = [{ direction: 'in', protocol: 'tcp', port: '80', source_ips: ['0.0.0.0/0', '::/0'] }];
      if (this.opts.firewallSources.length) {
        rules.push({ direction: 'in', protocol: 'tcp', port: '8000', source_ips: this.opts.firewallSources });
      }
      return json({ firewall: { id: 42, name: 'pilot', rules } });
    }
    if (method === 'POST' && path === '/servers') {
      const id = this.#nextId++;
      const s: FakeServer = {
        id,
        name: body!.name,
        labels: body!.labels ?? {},
        ip: SERVER_IP,
        user_data: body!.user_data ?? '',
        created: '2026-09-20T15:00:00Z',
      };
      this.servers.set(id, s);
      if (this.opts.hetznerLoseResponse && !this.#lostOnce) {
        this.#lostOnce = true;
        throw new TypeError('fetch failed'); // the purchase happened; the response did not arrive
      }
      return json({ server: this.#serverJson(s), action: { id: 1 } }, 201);
    }
    if (method === 'GET' && path === '/servers') {
      const sel = url.searchParams.get('label_selector') ?? '';
      const [k, v] = sel.split('=');
      const found = [...this.servers.values()].filter((s) => s.labels[k!] === v);
      return json({ servers: found.map((s) => this.#serverJson(s)) });
    }
    const m = /^\/servers\/(\d+)$/.exec(path);
    if (m) {
      const s = this.servers.get(Number(m[1]));
      if (!s) return json({ error: { code: 'not_found' } }, 404);
      if (method === 'GET') return json({ server: this.#serverJson(s) });
      if (method === 'DELETE') {
        this.servers.delete(s.id);
        return json({ action: { id: 2 } });
      }
    }
    return json({ error: 'unhandled' }, 404);
  }

  #coolify(method: string, url: URL, headers: Headers, body?: Record<string, any>): Response {
    const path = url.pathname.replace('/api/v1', '');
    const token = /^Bearer (.+)$/.exec(headers.get('authorization') ?? '')?.[1];
    const want = this.#expectedTokenHash();
    const authed = Boolean(token && want && createHash('sha256').update(token).digest('hex') === want);

    if (path === '/teams/current') {
      // Simulates the boot window: Coolify is up but bootstrap has not created our token yet.
      if (++this.#teamCalls <= this.opts.bootAfterCalls) return json({ message: 'Unauthenticated.' }, 401);
    }
    if (!authed) return json({ message: 'Unauthenticated.' }, 401);

    if (method === 'GET' && path === '/teams/current') return json({ id: 0, name: 'root' });
    if (method === 'GET' && path === '/servers') return json([{ uuid: 'srv-local', name: 'localhost' }]);
    if (method === 'POST' && path === '/projects') return json({ uuid: 'prj-1' }, 201);
    if (method === 'POST' && path === '/applications/public') {
      this.appBodies.push(body!);
      return json({ uuid: 'app-1' }, 201);
    }
    if (method === 'PATCH' && path === '/applications/app-1/envs/bulk') {
      for (const e of body!.data) this.envsReceived.push({ key: e.key, value: e.value });
      return json([], 201);
    }
    if (method === 'POST' && path === '/deploy') return json({ deployments: [{ deployment_uuid: 'dep-1', resource_uuid: 'app-1' }] });
    if (method === 'GET' && path === '/deployments/dep-1') {
      if (this.#blips < this.opts.deployStatusBlips) {
        this.#blips++;
        throw new TypeError('fetch failed');
      }
      if (this.opts.deployFails) return json({ status: 'failed' });
      return json({ status: ++this.#deployPolls > this.opts.deployPolls ? 'finished' : 'in_progress' });
    }
    return json({ message: 'not found' }, 404);
  }

  #cloudflare(method: string, url: URL, body?: Record<string, any>): Response {
    const ok = (result: unknown) => json({ success: true, errors: [], result });
    const path = url.pathname.replace('/client/v4', '');
    if (method === 'GET' && path === '/user/tokens/verify') {
      return ok({ id: 'tok-1', status: this.opts.cloudflareInactive ? 'expired' : 'active' });
    }
    if (method === 'GET' && path === '/zones') {
      return ok(url.searchParams.get('name') === 'example.com' ? [{ id: 'zone-1', name: 'example.com' }] : []);
    }
    if (path === '/zones/zone-1/dns_records') {
      if (method === 'GET') {
        const r = this.dns.get(url.searchParams.get('name') ?? '');
        return ok(r ? [r] : []);
      }
      if (method === 'POST') {
        const rec = { id: `rec-${this.dns.size + 1}`, content: body!.content, ttl: body!.ttl, proxied: body!.proxied };
        this.dns.set(body!.name, rec);
        return ok({ id: rec.id });
      }
    }
    const m = /^\/zones\/zone-1\/dns_records\/(.+)$/.exec(path);
    if (m) {
      const entry = [...this.dns.entries()].find(([, r]) => r.id === m[1]);
      if (!entry) return json({ success: false, errors: [{ message: 'not found' }] }, 404);
      if (method === 'PATCH') {
        this.dns.set(entry[0], { id: entry[1].id, content: body!.content, ttl: body!.ttl, proxied: body!.proxied });
        return ok({ id: entry[1].id });
      }
      if (method === 'DELETE') {
        this.dns.delete(entry[0]);
        return ok({ id: entry[1].id });
      }
    }
    return json({ success: false, errors: [{ message: 'unhandled' }] }, 404);
  }

  #vercel(url: URL): Response {
    if (url.pathname === '/v10/projects/prj_shop/env') {
      return json({
        envs: [
          { key: 'DATABASE_URL', value: 'postgres://app:s3cr3t-db-pass@db.internal/app', type: 'encrypted', target: ['production'] },
          { key: 'NEXT_PUBLIC_SITE', value: 'https://app.example.com', type: 'plain', target: ['production', 'preview'] },
          { key: 'STRIPE_SECRET_KEY', type: 'sensitive', target: ['production'] },
          { key: 'PREVIEW_ONLY', value: 'not-for-prod', type: 'plain', target: ['preview'] },
          { key: 'VERCEL_URL', value: 'shop.vercel.app', type: 'system', target: ['production'] },
        ],
      });
    }
    return json({ error: 'not found' }, 404);
  }

  #anakin(method: string, url: URL): Response {
    if (method === 'POST' && url.pathname === '/v1/url-scraper') return json({ jobId: 'job-1', status: 'pending' }, 202);
    if (method === 'GET' && url.pathname === '/v1/url-scraper/job-1') {
      if (++this.#priceCalls < this.opts.priceJobPolls) return json({ id: 'job-1', status: 'processing' });
      return json({ id: 'job-1', status: 'completed', markdown: this.opts.priceMarkdown });
    }
    return json({ error: 'not found' }, 404);
  }
}
