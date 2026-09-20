import { randomBytes } from 'node:crypto';
import { verifyAuditorToken } from '../pilot/auditor.ts';
import { authorize } from '../pilot/guard.ts';
import { claim, settle, type Ledger, type LedgerRow } from '../pilot/ledger.ts';
import { verifyMandate, type Mandate } from '../pilot/mandate.ts';
import { PRICE_SOURCE_URL } from '../pilot/pricing.ts';
import type { AnakinClient } from './clients/anakin.ts';
import type { CloudflareClient, DnsPrevious } from './clients/cloudflare.ts';
import type { CoolifyClient } from './clients/coolify.ts';
import { ProviderError } from './clients/http.ts';
import type { HetznerClient } from './clients/hetzner.ts';
import type { VercelClient } from './clients/vercel.ts';
import { renderCloudInit, sha256Hex } from './cloudinit.ts';
import type { GatewayConfig } from './config.ts';
import type { Vault } from './vault.ts';

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

export interface GatewayDeps {
  cfg: GatewayConfig;
  ledger: Ledger;
  vault: Vault;
  hetzner: HetznerClient;
  coolify: (ip: string, token: string) => CoolifyClient;
  cloudflare?: CloudflareClient;
  vercel?: VercelClient;
  anakin?: AnakinClient;
  cloudInitTemplate: string;
  now?: () => Date;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Args, deps: GatewayDeps): Promise<Record<string, unknown>>;
}

type Args = Record<string, unknown>;

const DEFAULT_RUN_WINDOW_MIN = 120;
const ENV_BLOB_TTL_MS = 30 * 60_000;
export const SECRETS_TTL_MS = 7 * 24 * 3_600_000;

// ---------------------------------------------------------------- argument helpers

const str = (a: Args, k: string, max = 4000): string => {
  const v = a[k];
  if (typeof v !== 'string' || v.length === 0 || v.length > max) {
    throw new ToolError('BAD_ARGS', `${k} must be a non-empty string`);
  }
  return v;
};
const int = (a: Args, k: string): number => {
  const v = a[k];
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolError('BAD_ARGS', `${k} must be an integer`);
  return v;
};
const runId = (a: Args): string => {
  const v = str(a, 'run_id', 60);
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new ToolError('BAD_ARGS', 'run_id has unsafe characters');
  return v;
};

// ---------------------------------------------------------------- mandate handling

type Phase = 'spend' | 'continue' | 'rollback';

/**
 * spend    - strict: signature AND `exp`. Only the initial purchase and the pre-purchase
 *            price scrape need fresh authority.
 * continue - signature, plus the run window measured from the committed purchase.
 * rollback - signature only. Cleanup must stay possible after everything else expires,
 *            and it is confined to resources this mandate itself created.
 */
async function requireMandate(deps: GatewayDeps, a: Args, phase: Phase): Promise<Mandate> {
  const now = deps.now?.() ?? new Date();
  const v = verifyMandate(str(a, 'mandate', 16_000), {
    publicKey: deps.cfg.mandatePublicKey,
    now,
    allowExpired: phase !== 'spend',
  });
  if (!v.ok) throw new ToolError(v.code, v.reason);
  const m = v.mandate;
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(m.mandate_id)) throw new ToolError('BAD_MANDATE_ID', 'mandate_id has unsafe characters');

  if (phase === 'continue') {
    const p2 = await committed(deps, m, 'P2');
    if (!p2) throw new ToolError('NO_SERVER', 'no server has been provisioned under this mandate');
    const windowMs = (m.run_window_minutes ?? DEFAULT_RUN_WINDOW_MIN) * 60_000;
    if (now.getTime() - Date.parse(p2.ts) > windowMs) {
      throw new ToolError('RUN_WINDOW_EXPIRED', `run window of ${m.run_window_minutes ?? DEFAULT_RUN_WINDOW_MIN} min from purchase has closed`);
    }
  }
  return m;
}

const rowKey = (m: Mandate, step: string) => `${m.mandate_id}:${step}`;

async function committed(deps: GatewayDeps, m: Mandate, step: string): Promise<LedgerRow | undefined> {
  const rows = await deps.ledger.rows();
  const last = rows.findLast((r) => r.key === rowKey(m, step));
  return last?.state === 'COMMITTED' ? last : undefined;
}

/** The server this mandate bought, derived from OUR ledger. Never from the caller. */
async function target(deps: GatewayDeps, m: Mandate) {
  const row = await committed(deps, m, 'P2');
  const d = row?.detail as { server_id?: string; ip?: string } | undefined;
  if (!d?.server_id || !d.ip) throw new ToolError('NO_SERVER', 'no server has been provisioned under this mandate');
  const secrets = await deps.vault.get<{ api_token: string }>('coolify', `coolify:${m.mandate_id}`);
  if (!secrets) throw new ToolError('NO_CREDENTIALS', 'Coolify credentials for this mandate are missing or expired');
  return { server_id: d.server_id, ip: d.ip, client: deps.coolify(d.ip, secrets.api_token) };
}

// ---------------------------------------------------------------- write-ahead helper

/**
 * Runs a side-effecting action at most once per (mandate, step).
 *
 *  - fresh claim         -> act, then settle
 *  - committed, same run -> return the recorded result (a retry after a lost response)
 *  - committed, other run-> REPLAY
 *  - unresolved INTENT   -> try `adopt` (did the provider actually do it?), else refuse
 *
 * A provider error that MAY have created the resource (5xx, timeout) leaves the row as
 * INTENT. Only a definitive 4xx rejection marks it FAILED and frees the step for retry.
 */
async function once(
  deps: GatewayDeps,
  m: Mandate,
  step: string,
  run_id: string,
  act: () => Promise<Record<string, unknown>>,
  opts: {
    /** Did the provider actually do it? Consulted when an earlier attempt left an open INTENT. */
    adopt?: () => Promise<Record<string, unknown> | null>;
    /**
     * Purchases only. An ambiguous outcome keeps the INTENT open so nothing retries blindly.
     * Free, repeatable steps (project, deploy, DNS upsert) release the claim instead, so a
     * network blip is retryable rather than terminal.
     */
    strict?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const { adopt, strict = false } = opts;
  const row = { run_id, mandate_id: m.mandate_id, nonce: m.nonce, step, key: rowKey(m, step) };
  const c = await claim(deps.ledger, row);

  if (!c.ok) {
    if (c.code === 'ALREADY_COMMITTED') {
      if (c.prior.run_id !== run_id) throw new ToolError('REPLAY', `${step} was already executed by ${c.prior.run_id}`);
      return { ...(c.prior.detail ?? {}), idempotent: true };
    }
    // IN_FLIGHT: a previous attempt may have acted and lost its response.
    if (adopt && c.prior.run_id === run_id) {
      const found = await adopt();
      if (found) {
        await settle(deps.ledger, { ...row, detail: found }, 'COMMITTED');
        return { ...found, adopted: true };
      }
    }
    throw new ToolError('IN_FLIGHT', c.reason);
  }

  try {
    const result = await act();
    await settle(deps.ledger, { ...row, detail: result }, 'COMMITTED');
    return result;
  } catch (e) {
    if (e instanceof ProviderError && e.definitive) {
      await settle(deps.ledger, row, 'FAILED');
      throw new ToolError('PROVIDER_REJECTED', e.message);
    }
    if (e instanceof ToolError) {
      await settle(deps.ledger, row, 'FAILED');
      throw e;
    }
    if (strict) {
      // Ambiguous purchase: leave INTENT open so a retry reconciles instead of double-buying.
      throw new ToolError('PROVIDER_AMBIGUOUS', `${(e as Error).message}; outcome unknown, will reconcile on retry`);
    }
    await settle(deps.ledger, row, 'FAILED');
    throw new ToolError('PROVIDER_AMBIGUOUS', `${(e as Error).message}; outcome unknown, safe to retry`);
  }
}

const need = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new ToolError('NOT_CONFIGURED', `${what} is not configured on this gateway`);
  return v;
};

// ---------------------------------------------------------------- the tools

const MANDATE = { type: 'string', description: 'Signed mandate token, carried by the caller as a capability.' };
const RUN = { type: 'string', description: 'Run identifier, used for idempotency.' };
const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties: props,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDef[] = [
  {
    name: 'anakin_scrape_submit',
    description: 'Submit a scrape of the vendor pricing page. Only the pinned pricing URL is accepted.',
    inputSchema: obj({ mandate: MANDATE, url: { type: 'string' } }, ['mandate', 'url']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'spend');
      const d = authorize(m, 'anakin:scrape.submit', { url: a.url });
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const { jobId } = await need(deps.anakin, 'ANAKIN_API_KEY').submit(PRICE_SOURCE_URL);
      return { jobId };
    },
  },
  {
    name: 'anakin_scrape_status',
    description: 'Poll a pricing scrape job.',
    inputSchema: obj({ mandate: MANDATE, job_id: { type: 'string' } }, ['mandate', 'job_id']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'spend');
      const d = authorize(m, 'anakin:scrape.status', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const job = await need(deps.anakin, 'ANAKIN_API_KEY').status(str(a, 'job_id', 200));
      // Untrusted page content: cap size, and the caller only ever regex-parses it.
      return { status: job.status, markdown: job.markdown?.slice(0, 200_000), error: job.error?.slice(0, 200) };
    },
  },
  {
    name: 'hetzner_server_create',
    description: 'Buy the one server the mandate approves. Every parameter must equal the mandate; nothing is substituted.',
    inputSchema: obj(
      {
        mandate: MANDATE,
        run_id: RUN,
        server_type: { type: 'string' },
        image: { type: 'string' },
        location: { type: 'string' },
        count: { type: 'integer' },
        cloud_init_sha256: { type: 'string' },
      },
      ['mandate', 'run_id', 'server_type', 'image', 'location', 'count', 'cloud_init_sha256'],
    ),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'spend');
      const rid = runId(a);
      const requested = {
        server_type: str(a, 'server_type', 40),
        image: str(a, 'image', 60),
        location: str(a, 'location', 20),
        count: int(a, 'count'),
        cloud_init_sha256: str(a, 'cloud_init_sha256', 100),
      };
      const d = authorize(m, 'hetzner:server.create', requested);
      if (!d.allow) throw new ToolError(d.code, d.reason);
      if (m.provision.count !== 1) throw new ToolError('UNSUPPORTED_COUNT', 'this gateway provisions exactly one server per mandate');
      if (sha256Hex(deps.cloudInitTemplate) !== m.provision.cloud_init_sha256) {
        throw new ToolError('TEMPLATE_MISMATCH', 'the mandate approved a different cloud-init template than this gateway holds');
      }
      if (!deps.cfg.hetznerFirewallId && !deps.cfg.allowInsecureCoolifyHttp) {
        throw new ToolError('NO_FIREWALL', 'set HETZNER_FIREWALL_ID (restricting :8000 to this gateway) or ALLOW_INSECURE_COOLIFY_HTTP=true');
      }

      // Everything that can fail locally happens BEFORE the ledger claim, so a local error
      // can never leave an open INTENT that blocks a retry. Credentials are minted before
      // the purchase so a lost response cannot orphan a box we can no longer log in to, and
      // are reused if an earlier attempt already minted them.
      const secretsName = `coolify:${m.mandate_id}`;
      let secrets = await deps.vault.get<{ api_token: string; root_password: string }>('coolify', secretsName);
      if (!secrets) {
        secrets = { api_token: randomBytes(32).toString('hex'), root_password: randomBytes(24).toString('hex') };
        await deps.vault.put('coolify', secretsName, secrets, SECRETS_TTL_MS);
      }
      let userData: string;
      try {
        userData = renderCloudInit(deps.cloudInitTemplate, {
          COOLIFY_ROOT_USER: 'varsiko',
          COOLIFY_ROOT_EMAIL: 'admin@varsiko.invalid',
          COOLIFY_ROOT_PASSWORD: secrets.root_password,
          API_TOKEN_SHA256: sha256Hex(secrets.api_token),
          ALLOWED_IPS: deps.cfg.gatewayEgressIp ?? '',
        }).userData;
      } catch (e) {
        throw new ToolError('BAD_TEMPLATE', (e as Error).message);
      }
      const estimated = d.estimated_monthly_usd;

      return once(
        deps,
        m,
        'P2',
        rid,
        async () => {
          const s = await deps.hetzner.createServer({
            name: `varsiko-${m.mandate_id.replace(/[._]/g, '-').toLowerCase()}`,
            server_type: requested.server_type,
            image: requested.image,
            location: requested.location,
            ssh_keys: deps.cfg.hetznerSshKeys,
            user_data: userData,
            labels: { managed_by: 'varsiko-pilot', mandate_id: m.mandate_id, run_id: rid },
            firewall_id: deps.cfg.hetznerFirewallId,
          });
          if (!s.ip) throw new ProviderError('hetzner', 0, 'server created but no IPv4 returned');
          return { server_id: String(s.id), ip: s.ip, estimated_monthly_usd: estimated };
        },
        {
          strict: true,
          adopt: async () => {
            const found = await deps.hetzner.findByLabel('mandate_id', m.mandate_id);
            if (found.length > 1) throw new ToolError('MULTIPLE_SERVERS', `${found.length} servers carry this mandate label; manual review required`);
            const s = found[0];
            return s?.ip ? { server_id: String(s.id), ip: s.ip, estimated_monthly_usd: estimated } : null;
          },
        },
      );
    },
  },
  {
    name: 'hetzner_server_delete',
    description: 'Destroy a server. Only servers this same mandate created can be deleted.',
    inputSchema: obj({ mandate: MANDATE, server_id: { type: 'string' } }, ['mandate', 'server_id']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'rollback');
      const d = authorize(m, 'hetzner:server.delete', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const id = Number(str(a, 'server_id', 20));
      if (!Number.isInteger(id)) throw new ToolError('BAD_ARGS', 'server_id must be numeric');
      const s = await deps.hetzner.getServer(id);
      if (s.labels.managed_by !== 'varsiko-pilot' || s.labels.mandate_id !== m.mandate_id) {
        throw new ToolError('FORBIDDEN', 'that server was not created by this mandate');
      }
      await deps.hetzner.deleteServer(id);
      return { deleted: String(id) };
    },
  },
  {
    name: 'coolify_health',
    description: 'True once the new server’s authenticated Coolify API answers, proving bootstrap completed.',
    inputSchema: obj({ mandate: MANDATE }, ['mandate']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      return { ready: await (await target(deps, m)).client.ready() };
    },
  },
  {
    name: 'coolify_project_create',
    description: 'Create the Coolify project. Name is pinned to the mandate.',
    inputSchema: obj({ mandate: MANDATE, run_id: RUN, name: { type: 'string' } }, ['mandate', 'run_id', 'name']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'coolify:project.create', { name: a.name });
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const t = await target(deps, m);
      return once(deps, m, 'P4P', runId(a), async () => {
        const p = await t.client.createProject(str(a, 'name', 100));
        return { project_uuid: p.uuid };
      });
    },
  },
  {
    name: 'coolify_application_create',
    description: 'Create the application from the mandate’s repo and branch.',
    inputSchema: obj(
      {
        mandate: MANDATE,
        run_id: RUN,
        project_uuid: { type: 'string' },
        git_repository: { type: 'string' },
        git_branch: { type: 'string' },
        build_pack: { type: 'string' },
      },
      ['mandate', 'run_id', 'project_uuid', 'git_repository', 'git_branch', 'build_pack'],
    ),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'coolify:application.create', a);
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const build = str(a, 'build_pack', 20);
      if (!['nixpacks', 'railpack', 'static', 'dockerfile', 'dockercompose'].includes(build)) {
        throw new ToolError('BAD_ARGS', 'unknown build_pack');
      }
      const t = await target(deps, m);
      return once(deps, m, 'P4A', runId(a), async () => {
        const app = await t.client.createApplication({
          project_uuid: str(a, 'project_uuid', 100),
          server_uuid: await t.client.localServerUuid(),
          git_repository: str(a, 'git_repository', 300),
          git_branch: str(a, 'git_branch', 100),
          build_pack: build,
          ports_exposes: deps.cfg.appPort,
        });
        return { app_uuid: app.uuid };
      });
    },
  },
  {
    name: 'vercel_env_export',
    description: 'Read the Vercel project’s production env vars into a sealed blob. Values are never returned; only a reference, a count, and the NAMES of variables that could not be exported.',
    inputSchema: obj({ mandate: MANDATE, project_id: { type: 'string' } }, ['mandate', 'project_id']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'vercel:env.export', { project_id: a.project_id });
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const ex = await need(deps.vercel, 'VERCEL_TOKEN').exportProductionEnvs(str(a, 'project_id', 100));
      const ref = await deps.vault.put('env', `env:${m.mandate_id}`, ex.vars, ENV_BLOB_TTL_MS);
      return { sealed_ref: ref, count: ex.vars.length, skipped: ex.skipped.map((s) => s.key), truncated: ex.truncated };
    },
  },
  {
    name: 'coolify_envs_bulk_update',
    description: 'Load a sealed env blob into the application. The caller never sees the values.',
    inputSchema: obj(
      { mandate: MANDATE, app_uuid: { type: 'string' }, sealed_ref: { type: 'string' } },
      ['mandate', 'app_uuid', 'sealed_ref'],
    ),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'coolify:envs.bulk_update', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      // The blob is bound to this mandate by name; another mandate's blob cannot be opened.
      if (a.sealed_ref !== `sealed:env:${m.mandate_id}`) throw new ToolError('BAD_REF', 'sealed_ref does not belong to this mandate');
      const vars = await deps.vault.get<{ key: string; value: string }[]>('env', str(a, 'sealed_ref', 100));
      if (!vars) throw new ToolError('BAD_REF', 'sealed blob is missing or expired');
      const t = await target(deps, m);
      return { count: await t.client.bulkEnvs(str(a, 'app_uuid', 100), vars) };
    },
  },
  {
    name: 'coolify_application_deploy',
    description: 'Trigger the deployment.',
    inputSchema: obj({ mandate: MANDATE, run_id: RUN, app_uuid: { type: 'string' } }, ['mandate', 'run_id', 'app_uuid']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'coolify:application.deploy', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const t = await target(deps, m);
      return once(deps, m, 'P6', runId(a), async () => ({
        deployment_uuid: (await t.client.deploy(str(a, 'app_uuid', 100))).deployment_uuid,
      }));
    },
  },
  {
    name: 'coolify_deployment_status',
    description: 'Poll a deployment.',
    inputSchema: obj({ mandate: MANDATE, deployment_uuid: { type: 'string' } }, ['mandate', 'deployment_uuid']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const d = authorize(m, 'coolify:deployment.status', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      return { status: await (await target(deps, m)).client.deploymentStatus(str(a, 'deployment_uuid', 100)) };
    },
  },
  {
    name: 'cloudflare_dns_upsert',
    description: 'Point the mandate’s domain at the server this mandate bought. Requires a valid Auditor PASS token bound to this mandate and server.',
    inputSchema: obj(
      { mandate: MANDATE, run_id: RUN, auditor_token: { type: 'string' }, name: { type: 'string' } },
      ['mandate', 'run_id', 'auditor_token', 'name'],
    ),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'continue');
      const t = await target(deps, m);
      const check = verifyAuditorToken(str(a, 'auditor_token', 8000), {
        publicKey: need(deps.cfg.auditorPublicKey, 'AUDITOR_PUBLIC_KEY_FILE'),
        mandate_id: m.mandate_id,
        server_ip: t.ip,
        now: deps.now?.(),
      });
      if (!check.ok) throw new ToolError(check.code, check.reason);
      // Signature verified above, so the guard's "token present" check is now meaningful.
      const d = authorize(m, 'cloudflare:dns.upsert', { name: a.name }, { auditorPassToken: 'verified' });
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const cf = need(deps.cloudflare, 'CLOUDFLARE_TOKEN');
      const name = str(a, 'name', 253);
      return once(deps, m, 'P8', runId(a), async () => {
        const zone = await cf.zoneIdFor(name);
        const r = await cf.upsertA(zone, name, t.ip);
        return { record_id: r.record_id, zone_id: zone, name, previous: r.previous };
      });
    },
  },
  {
    name: 'cloudflare_dns_rollback',
    description: 'Restore the DNS record this mandate changed to its previous value.',
    inputSchema: obj({ mandate: MANDATE, record_id: { type: 'string' } }, ['mandate', 'record_id']),
    async handler(a, deps) {
      const m = await requireMandate(deps, a, 'rollback');
      const d = authorize(m, 'cloudflare:dns.rollback', {});
      if (!d.allow) throw new ToolError(d.code, d.reason);
      const row = await committed(deps, m, 'P8');
      const detail = row?.detail as { record_id: string; zone_id: string; name: string; previous: DnsPrevious | null } | undefined;
      // Confined to the record this mandate wrote. No arbitrary record edits.
      if (!detail || detail.record_id !== a.record_id) throw new ToolError('FORBIDDEN', 'that record was not changed by this mandate');
      await need(deps.cloudflare, 'CLOUDFLARE_TOKEN').restore(detail.zone_id, detail.record_id, detail.name, detail.previous);
      return { restored: detail.record_id };
    },
  },
];
