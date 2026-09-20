/**
 * Provider surface Pilot is allowed to touch.
 *
 * Two implementations:
 *  - NasikoProviders: real calls, routed through the Nasiko MCP gateway so provider
 *    credentials stay in the connector and never reach this process.
 *  - FakeProviders: deterministic, instant, spends nothing. Used for the demo and tests.
 *
 * Pilot itself cannot tell them apart, which is the point: the demo exercises the real
 * code path, not a narrated mock.
 */
export interface Providers {
  hetzner: {
    createServer(args: ProvisionArgs): Promise<{ server_id: string; ip: string }>;
    deleteServer(serverId: string): Promise<void>;
  };
  /**
   * Handoff lane. READ-ONLY: Pilot learns whether a human has registered a server and at
   * which address. Registering is an operator action with its own credential; nothing on
   * this surface can supply or change the address.
   */
  handoff: {
    status(): Promise<HandoffStatus>;
  };
  coolify: {
    health(ip: string): Promise<boolean>;
    createProject(ip: string, name: string): Promise<{ project_uuid: string }>;
    createApplication(ip: string, a: AppArgs): Promise<{ app_uuid: string }>;
    bulkEnvs(ip: string, appUuid: string, sealedRef: string): Promise<{ count: number }>;
    deploy(ip: string, appUuid: string): Promise<{ deployment_uuid: string }>;
    deploymentStatus(ip: string, deploymentUuid: string): Promise<DeployStatus>;
  };
  cloudflare: {
    upsert(name: string, ip: string): Promise<{ record_id: string }>;
    rollback(recordId: string): Promise<void>;
  };
  vercel: {
    /** Returns an opaque reference. Values are never returned to this process. */
    exportEnvs(
      projectId: string,
    ): Promise<{ sealed_ref: string; count: number; skipped?: string[]; truncated?: boolean }>;
  };
  /**
   * Optional. Anakin scrape, submit/poll to match its job model and to stay under the
   * 120s flow-guard ceiling. The Anakin API key lives in the gateway connector.
   */
  pricing?: {
    submit(url: string): Promise<{ job_id: string }>;
    poll(jobId: string): Promise<PriceJob>;
  };
}

export interface HandoffStatus {
  registered: boolean;
  ip?: string;
  server_id?: string;
}

export type DeployStatus = 'queued' | 'running' | 'success' | 'failed';

/** Mirrors Anakin's GET /v1/url-scraper/{id}: pending | processing | completed | failed. */
export interface PriceJob {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  markdown?: string;
  error?: string;
}

export interface ProvisionArgs {
  server_type: string;
  image: string;
  location: string;
  count: number;
  cloud_init_sha256: string;
}

export interface AppArgs {
  project_uuid: string;
  git_repository: string;
  git_branch: string;
  build_pack: string;
}

// ---------------------------------------------------------------------------
// Nasiko MCP gateway client
// ---------------------------------------------------------------------------

/** Transport-level MCP failure (JSON-RPC error). */
export class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(`MCP ${code}: ${message}`);
    this.code = code;
    this.name = 'McpError';
  }
  /** -32001: the tool is on an `ask` stance and a human has not approved yet. */
  get needsApproval(): boolean {
    return this.code === -32001;
  }
  /** -32000: blocked by the user's permission rules. */
  get blocked(): boolean {
    return this.code === -32000;
  }
}

/**
 * The gateway understood the call and refused it (mandate invalid, argument substituted,
 * over budget, replay...). Distinct from McpError: the transport worked.
 */
export class ToolRefusal extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ToolRefusal';
    this.code = code;
  }
  /** The provider may or may not have acted. Callers must NOT treat this as "did not happen". */
  get ambiguous(): boolean {
    return this.code === 'PROVIDER_AMBIGUOUS' || this.code === 'IN_FLIGHT';
  }
}

export interface GatewayOptions {
  url: string;
  /** Minted per inbound request by Nasiko; expires in minutes. Never a static key. */
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class NasikoGateway {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  /**
   * Nasiko docs: the tool name must be the exact namespaced string from tools/list, and
   * the list must not be cached. This instance is built per inbound request (the token is
   * minted per request too), so caching within it is "fresh per request".
   */
  #names: Map<string, string> | null = null;

  constructor(opts: GatewayOptions) {
    this.#url = opts.url;
    this.#token = opts.token;
    this.#fetch = opts.fetch ?? fetch;
    // Docs: use 30-60s for real connector calls, not short defaults. Kept under the
    // 120s flow-guard ceiling so a hung tool cannot take the whole step down with it.
    this.#timeoutMs = opts.timeoutMs ?? 60_000;
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'NasikoGateway { token: [redacted] }';
  }

  async #rpc(method: string, params?: Record<string, unknown>) {
    const res = await this.#fetch(this.#url, {
      method: 'POST',
      headers: { 'x-nasiko-agent-token': this.#token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, ...(params ? { params } : {}) }),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const body = (await res.json()) as {
      error?: { code: number; message: string };
      result?: Record<string, unknown>;
    };
    if (body.error) throw new McpError(body.error.code, body.error.message);
    return body.result ?? {};
  }

  /** Calls a tool by its exact (already namespaced) name. */
  async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = (await this.#rpc('tools/call', { name, arguments: args })) as {
      content?: { text?: string }[];
      isError?: boolean;
    };
    const text = result.content?.[0]?.text;
    if (result.isError) {
      // Gateway tools report refusals as {error, message}. Anything else is a raw failure.
      let refusal: ToolRefusal | null = null;
      try {
        const e = JSON.parse(text ?? '') as { error?: string; message?: string };
        if (e.error) refusal = new ToolRefusal(e.error, e.message ?? '');
      } catch {
        /* not JSON: fall through to the raw failure below */
      }
      if (refusal) throw refusal;
      throw new McpError(-32603, text ?? 'tool reported an error');
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * Calls a tool by its base name (e.g. `hetzner_server_create`), resolving the connector
   * prefix Nasiko adds (`{prefix}__{tool}`) from tools/list.
   */
  async callTool<T>(base: string, args: Record<string, unknown>): Promise<T> {
    if (!this.#names) {
      const r = (await this.#rpc('tools/list')) as { tools?: { name: string }[] };
      const map = new Map<string, string>();
      const dup = new Set<string>();
      for (const t of r.tools ?? []) {
        const i = t.name.indexOf('__');
        const key = i >= 0 ? t.name.slice(i + 2) : t.name;
        if (map.has(key)) dup.add(key);
        map.set(key, t.name);
      }
      for (const k of dup) map.delete(k); // two connectors exposing one name: refuse to guess
      this.#names = map;
    }
    const exact = this.#names.get(base);
    if (!exact) throw new McpError(-32601, `tool ${base} is not exposed to this agent (or is ambiguous)`);
    return this.call<T>(exact, args);
  }
}

export interface RunCredentials {
  /** The signed mandate: a capability Pilot carries but cannot alter. */
  mandate: string;
  runId: string;
  /** Agent 5's signed PASS verdict; only needed for the DNS step. */
  auditorToken?: string;
}

/**
 * Providers backed by the Nasiko-hosted gateway. Note what is NOT passed: any IP, host or
 * URL. The gateway derives the target server from its own ledger, so a hijacked Pilot has
 * no argument through which to point the gateway (and the migrated secrets) elsewhere.
 */
export function nasikoProviders(gw: NasikoGateway, c: RunCredentials): Providers {
  const base = { mandate: c.mandate };
  const run = { ...base, run_id: c.runId };
  return {
    hetzner: {
      createServer: (a) => gw.callTool('hetzner_server_create', { ...run, ...a }),
      deleteServer: async (server_id) => {
        await gw.callTool('hetzner_server_delete', { ...base, server_id });
      },
    },
    handoff: {
      status: () => gw.callTool<HandoffStatus>('handoff_status', base),
    },
    coolify: {
      health: async () => (await gw.callTool<{ ready: boolean }>('coolify_health', base)).ready,
      createProject: async (_ip, name) => {
        const r = await gw.callTool<{ project_uuid: string }>('coolify_project_create', { ...run, name });
        return { project_uuid: r.project_uuid };
      },
      createApplication: async (_ip, a) => {
        const r = await gw.callTool<{ app_uuid: string }>('coolify_application_create', { ...run, ...a });
        return { app_uuid: r.app_uuid };
      },
      bulkEnvs: (_ip, app_uuid, sealed_ref) =>
        gw.callTool('coolify_envs_bulk_update', { ...base, app_uuid, sealed_ref }),
      deploy: async (_ip, app_uuid) => {
        const r = await gw.callTool<{ deployment_uuid: string }>('coolify_application_deploy', { ...run, app_uuid });
        return { deployment_uuid: r.deployment_uuid };
      },
      deploymentStatus: async (_ip, deployment_uuid) =>
        (await gw.callTool<{ status: DeployStatus }>('coolify_deployment_status', { ...base, deployment_uuid })).status,
    },
    cloudflare: {
      upsert: async (name) => {
        if (!c.auditorToken) throw new ToolRefusal('NO_AUDITOR_TOKEN', 'DNS cutover requires an Auditor pass token');
        const r = await gw.callTool<{ record_id: string }>('cloudflare_dns_upsert', {
          ...run,
          auditor_token: c.auditorToken,
          name,
        });
        return { record_id: r.record_id };
      },
      rollback: async (record_id) => {
        await gw.callTool('cloudflare_dns_rollback', { ...base, record_id });
      },
    },
    vercel: {
      exportEnvs: (project_id) => gw.callTool('vercel_env_export', { ...base, project_id }),
    },
    // The gateway-side tools request formats:["markdown"] with useBrowser:true (the
    // vendor page is JS-rendered) and re-check the URL allowlist themselves.
    pricing: {
      submit: async (url) => ({ job_id: (await gw.callTool<{ jobId: string }>('anakin_scrape_submit', { ...base, url })).jobId }),
      poll: (job_id) => gw.callTool<PriceJob>('anakin_scrape_status', { ...base, job_id }),
    },
  };
}

// ---------------------------------------------------------------------------
// Fake providers — deterministic, zero spend
// ---------------------------------------------------------------------------

export interface FakeOptions {
  /** How many health polls before Coolify reports ready. Real boots take minutes. */
  bootPolls?: number;
  /** How many status polls before the deployment resolves. */
  deployPolls?: number;
  /** Force a failure at a named step, to exercise rollback. */
  failAt?: 'provision' | 'boot' | 'deploy';
  /**
   * Shapes the fake Anakin response. `markdown` is SYNTHETIC: it imitates a pricing
   * table and is not a capture of the real page. `mode` simulates Anakin misbehaving.
   */
  price?: { markdown?: string; mode?: 'ok' | 'failed' | 'down' | 'stuck'; polls?: number };
  /** Names of Vercel "sensitive" vars the export could not read. */
  skippedEnvs?: string[];
  /** Handoff lane: `status()` reports registered from this many polls on (default 2). */
  registerAfterPolls?: number;
  /** Handoff lane: the human never buys a server. */
  neverRegister?: boolean;
}

/** Synthetic stand-in for the vendor pricing page. */
export const FAKE_PRICE_PAGE = [
  '| Name | vCPU | RAM | Price |',
  '|---|---|---|---|',
  '| CX22 | 2 | 4 GB | $4.50/mo |',
  '| CPX31 | 4 | 8 GB | $15.00/mo |',
  '| CPX51 | 16 | 32 GB | $58.00/mo |',
].join('\n');

export class FakeProviders implements Providers {
  #bootPolls: number;
  #deployPolls: number;
  #failAt?: FakeOptions['failAt'];
  #price: NonNullable<FakeOptions['price']>;
  #skippedEnvs: string[];
  #boot = 0;
  #deploy = 0;
  #priceCalls = 0;
  #registerAfterPolls: number;
  #neverRegister: boolean;
  #handoffPolls = 0;
  #registered: { ip: string; server_id: string } | null = null;
  /** Everything the fake actually did, for assertions and for the demo transcript. */
  readonly calls: { tool: string; args: unknown }[] = [];
  readonly live = new Set<string>();

  constructor(opts: FakeOptions = {}) {
    this.#bootPolls = opts.bootPolls ?? 2;
    this.#deployPolls = opts.deployPolls ?? 2;
    this.#failAt = opts.failAt;
    this.#price = opts.price ?? {};
    this.#skippedEnvs = opts.skippedEnvs ?? [];
    this.#registerAfterPolls = opts.registerAfterPolls ?? 2;
    this.#neverRegister = opts.neverRegister ?? false;
  }

  /**
   * Test/demo control, NOT part of Providers: models the operator having registered a
   * server through the gateway. Callers do the address validation the gateway would do.
   */
  registerNow(ip = '203.0.113.42') {
    this.#registered = { ip, server_id: `handoff:${ip}` };
  }

  #log(tool: string, args: unknown) {
    this.calls.push({ tool, args });
  }

  hetzner = {
    createServer: async (a: ProvisionArgs) => {
      this.#log('hetzner__server_create', a);
      if (this.#failAt === 'provision') throw new Error('hetzner: 500 internal error');
      const server_id = `srv_${7740 + this.calls.length}`;
      this.live.add(server_id);
      return { server_id, ip: '203.0.113.42' };
    },
    deleteServer: async (id: string) => {
      this.#log('hetzner__server_delete', { id });
      this.live.delete(id);
    },
  };

  handoff = {
    status: async (): Promise<HandoffStatus> => {
      this.#log('handoff__status', {});
      if (!this.#registered && !this.#neverRegister && ++this.#handoffPolls >= this.#registerAfterPolls) this.registerNow();
      return this.#registered ? { registered: true, ...this.#registered } : { registered: false };
    },
  };

  coolify = {
    health: async (ip: string) => {
      this.#log('coolify__health', { ip });
      if (this.#failAt === 'boot') return false;
      return ++this.#boot >= this.#bootPolls;
    },
    createProject: async (ip: string, name: string) => {
      this.#log('coolify__project_create', { ip, name });
      return { project_uuid: 'prj_c001' };
    },
    createApplication: async (ip: string, a: AppArgs) => {
      this.#log('coolify__application_create', { ip, ...a });
      return { app_uuid: 'app_a001' };
    },
    bulkEnvs: async (ip: string, app_uuid: string, sealed_ref: string) => {
      this.#log('coolify__envs_bulk_update', { ip, app_uuid, sealed_ref });
      return { count: 14 };
    },
    deploy: async (ip: string, app_uuid: string) => {
      this.#log('coolify__application_deploy', { ip, app_uuid });
      return { deployment_uuid: 'dep_d001' };
    },
    deploymentStatus: async (ip: string, deployment_uuid: string): Promise<DeployStatus> => {
      this.#log('coolify__deployment_status', { ip, deployment_uuid });
      if (this.#failAt === 'deploy') return 'failed';
      return ++this.#deploy >= this.#deployPolls ? 'success' : 'running';
    },
  };

  cloudflare = {
    upsert: async (name: string, ip: string) => {
      this.#log('cloudflare__dns_upsert', { name, ip });
      return { record_id: 'rec_f001' };
    },
    rollback: async (record_id: string) => {
      this.#log('cloudflare__dns_rollback', { record_id });
    },
  };

  vercel = {
    exportEnvs: async (project_id: string) => {
      this.#log('vercel__env_export', { project_id });
      // Opaque by construction: no values cross this boundary.
      return { sealed_ref: 'sealed:blob_7f3a', count: 14, skipped: this.#skippedEnvs };
    },
  };

  pricing = {
    submit: async (url: string) => {
      this.#log('anakin__scrape_submit', { url });
      if (this.#price.mode === 'down') throw new Error('anakin: 503 service unavailable');
      return { job_id: 'job_p001' };
    },
    poll: async (job_id: string): Promise<PriceJob> => {
      this.#log('anakin__scrape_status', { job_id });
      const mode = this.#price.mode ?? 'ok';
      if (mode === 'down') throw new Error('anakin: 503 service unavailable');
      if (mode === 'stuck') return { status: 'processing' };
      if (++this.#priceCalls < (this.#price.polls ?? 2)) return { status: 'processing' };
      if (mode === 'failed') return { status: 'failed', error: 'blocked by target' };
      return { status: 'completed', markdown: this.#price.markdown ?? FAKE_PRICE_PAGE };
    },
  };
}
