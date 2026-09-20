import { createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AnakinClient } from '../gateway/clients/anakin.ts';
import { CloudflareClient } from '../gateway/clients/cloudflare.ts';
import { ProviderError, requestJson } from '../gateway/clients/http.ts';
import { renderCloudInit, sha256Hex, ALLOWED_PLACEHOLDERS } from '../gateway/cloudinit.ts';
import { loadConfig } from '../gateway/config.ts';
import { TOOLS } from '../gateway/tools.ts';
import { signAuditorToken, verifyAuditorToken } from '../pilot/auditor.ts';
import { devMandate } from '../pilot/demo.ts';
import { PINNED_PRICES_USD_MONTH } from '../pilot/guard.ts';
import { isHandoff, signMandate, verifyMandate, type Mandate } from '../pilot/mandate.ts';
import { extractMonthlyPrice, FX_TO_USD, PRICE_SOURCE_URL } from '../pilot/pricing.ts';
import { DEFAULT_KEY_DIR, KEY_FILES } from './keygen.ts';
import { runMain, type CliIo } from './io.ts';

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface Row {
  check: string;
  status: Status;
  detail: string;
  /** Extra lines under the row (orphan list, sensitive var names). Never secret values. */
  extra?: string[];
}

export interface PreflightDeps {
  /** Used for every provider API (Hetzner, Cloudflare, Vercel, Anakin). */
  fetch?: typeof fetch;
  /** Used only to reach the gateway, which is usually on localhost. */
  gatewayFetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const HETZNER = 'https://api.hetzner.cloud/v1';
const SECRET_ENV = [
  'HETZNER_TOKEN', 'GATEWAY_BEARER_TOKEN', 'GATEWAY_OPERATOR_TOKEN', 'VAULT_KEY', 'CLOUDFLARE_TOKEN', 'VERCEL_TOKEN', 'ANAKIN_API_KEY', 'GITHUB_TOKEN',
];
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const targetsOf = (e: Record<string, unknown>): unknown[] => (typeof e.target === 'string' ? [e.target] : asArray(e.target));

const errText = (e: unknown): string => {
  if (e instanceof ProviderError) return e.status ? `${e.provider} answered ${e.status}` : `${e.provider}: ${e.message.replace(/^\S+ network: /, '')}`;
  return e instanceof Error ? e.message : String(e);
};
const authRejected = (e: unknown) => e instanceof ProviderError && (e.status === 401 || e.status === 403);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}

/** True if `ip` is inside `cidr` (IPv4 only; anything else compares as a string). */
export function cidrCovers(cidr: string, ip: string): boolean {
  const [base, bits] = cidr.split('/');
  if (!base || !isIPv4(base) || !isIPv4(ip)) return cidr === ip;
  const len = bits === undefined ? 32 : Number(bits);
  if (!Number.isInteger(len) || len < 0 || len > 32) return false;
  if (len === 0) return true;
  const shift = 2 ** (32 - len);
  return Math.floor(ipv4ToInt(base) / shift) === Math.floor(ipv4ToInt(ip) / shift);
}

const portIncludes = (spec: unknown, port: number): boolean => {
  const s = String(spec ?? '');
  const [lo, hi] = s.split('-').map(Number);
  if (lo === undefined || Number.isNaN(lo)) return false;
  return hi === undefined ? lo === port : port >= lo && port <= (hi ?? lo);
};

const age = (iso: unknown, now: Date): string => {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return 'unknown age';
  const m = Math.max(0, Math.round((now.getTime() - t) / 60_000));
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
};

const USAGE = `Usage: npm run preflight [-- options]

Read-only check of every configured credential before anything is bought. Never spends,
never prints a token. Exits non-zero if any check FAILs.

  --mandate <file>        Also check the mandate: signature, template hash, server type,
                          location, Cloudflare zone and Vercel project
  --domain <host>         Cloudflare zone to check (default: the mandate's domain)
  --vercel-project <id>   Vercel project to inspect (default: the mandate's)
  --spend-anakin          Submit ONE real scrape (uses credits) and check price extraction
  --save-markdown <file>  With --spend-anakin: save the scraped markdown (for a test fixture)
  --mandate-key <file>    Private mandate key to check against the public one
  --auditor-key <file>    Private auditor key to check against the public one`;

export async function preflight(argv: string[], io: CliIo, deps: PreflightDeps = {}): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mandate: { type: 'string' },
      domain: { type: 'string' },
      'vercel-project': { type: 'string' },
      'spend-anakin': { type: 'boolean', default: false },
      'save-markdown': { type: 'string' },
      'mandate-key': { type: 'string', default: join(DEFAULT_KEY_DIR, KEY_FILES.mandatePrivate) },
      'auditor-key': { type: 'string', default: join(DEFAULT_KEY_DIR, KEY_FILES.auditorPrivate) },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }

  const env = io.env;
  const f = deps.fetch ?? fetch;
  const now = (deps.now ?? (() => new Date()))();
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const rows: Row[] = [];

  // Belt and braces: even if some code path echoed a credential, it cannot reach the screen.
  const secrets = SECRET_ENV.map((k) => env[k]).filter((s): s is string => Boolean(s) && s!.length >= 8);
  const scrub = (line: string) => secrets.reduce((l, s) => l.split(s).join('[redacted]'), line);

  const add = (check: string, status: Status, detail: string, extra?: string[]): void => {
    rows.push({ check, status, detail, extra });
  };
  const guarded = async (check: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      add(check, 'FAIL', `unexpected error: ${errText(e)}`);
    }
  };

  // ---- Config ------------------------------------------------------------------------
  let configOk = true;
  try {
    loadConfig(env);
    add('Config', 'PASS', 'all required variables present');
  } catch (e) {
    configOk = false;
    add('Config', 'FAIL', errText(e));
  }

  // ---- Mandate file (optional) -------------------------------------------------------
  let mandate: Mandate | undefined;
  const pubPath = env.MANDATE_PUBLIC_KEY_FILE;
  let mandatePub: string | undefined;
  if (pubPath) mandatePub = await readFile(pubPath, 'utf8').catch(() => undefined);

  // ---- Keys --------------------------------------------------------------------------
  await guarded('Mandate keys', async () => {
    if (!pubPath) return add('Mandate keys', 'FAIL', 'MANDATE_PUBLIC_KEY_FILE is not set');
    if (!mandatePub) return add('Mandate keys', 'FAIL', `cannot read ${pubPath}`);
    let pub;
    try {
      pub = createPublicKey(mandatePub);
    } catch {
      return add('Mandate keys', 'FAIL', `${pubPath} is not a valid public key`);
    }
    if (pub.asymmetricKeyType !== 'ed25519') return add('Mandate keys', 'FAIL', 'the mandate public key must be Ed25519');
    const privPath = v['mandate-key']!;
    if (!existsSync(privPath)) {
      return add('Mandate keys', 'WARN', `public key parses; ${privPath} not found here, so the pair could not be checked`);
    }
    const probe = devMandate({ iat: now.toISOString(), exp: new Date(now.getTime() + 3_600_000).toISOString() });
    const res = verifyMandate(signMandate(probe, await readFile(privPath, 'utf8')), { publicKey: pub, now });
    if (!res.ok) return add('Mandate keys', 'FAIL', `${privPath} does not match ${pubPath}: mandates it signs would be refused`);
    add('Mandate keys', 'PASS', 'public key parses; a mandate signed by the private key verifies');
  });

  await guarded('Auditor key', async () => {
    const p = env.AUDITOR_PUBLIC_KEY_FILE;
    if (!p) return add('Auditor key', 'SKIP', 'AUDITOR_PUBLIC_KEY_FILE unset: DNS cutover is disabled');
    const pem = await readFile(p, 'utf8').catch(() => undefined);
    if (!pem) return add('Auditor key', 'FAIL', `cannot read ${p}`);
    try {
      createPublicKey(pem);
    } catch {
      return add('Auditor key', 'FAIL', `${p} is not a valid public key`);
    }
    const priv = v['auditor-key']!;
    if (!existsSync(priv)) return add('Auditor key', 'WARN', `public key parses; ${priv} not found here, so the pair could not be checked`);
    const claims = { mandate_id: 'probe', server_ip: '192.0.2.1', verdict: 'PASS' as const, iat: now.toISOString(), exp: new Date(now.getTime() + 60_000).toISOString() };
    const ok = verifyAuditorToken(signAuditorToken(claims, await readFile(priv, 'utf8')), { publicKey: pem, mandate_id: 'probe', server_ip: '192.0.2.1', now });
    add('Auditor key', ok.ok ? 'PASS' : 'FAIL', ok.ok ? 'public key parses; a token signed by the private key verifies' : `${priv} does not match ${p}`);
  });

  await guarded('Mandate', async () => {
    if (!v.mandate) return add('Mandate', 'SKIP', 'no --mandate given: server type, location, zone and project checks use it');
    const file = JSON.parse(await readFile(v.mandate, 'utf8').catch(() => '{}')) as { mandate?: Mandate; token?: string };
    if (!file.mandate || !file.token) return add('Mandate', 'FAIL', `${v.mandate} is not a { mandate, token } file`);
    mandate = file.mandate;
    if (!mandatePub) return add('Mandate', 'WARN', 'cannot verify the signature without the public key');
    const res = verifyMandate(file.token, { publicKey: mandatePub, now });
    if (res.ok) return add('Mandate', 'PASS', `${file.mandate.mandate_id} verifies; expires ${file.mandate.exp}`);
    add('Mandate', res.code === 'EXPIRED' ? 'WARN' : 'FAIL', `${res.code}: ${res.reason}`);
  });

  // ---- Template ----------------------------------------------------------------------
  await guarded('Template', async () => {
    const path = env.CLOUD_INIT_TEMPLATE ?? './cloud-init/coolify.yaml';
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text === undefined) return add('Template', 'FAIL', `cannot read ${path}`);
    try {
      renderCloudInit(text, Object.fromEntries(ALLOWED_PLACEHOLDERS.map((n) => [n, 'probe'])) as never);
    } catch (e) {
      return add('Template', 'FAIL', errText(e));
    }
    const sha = sha256Hex(text);
    if (mandate && mandate.provision.cloud_init_sha256 !== sha) {
      return add('Template', 'FAIL', `mandate pins ${mandate.provision.cloud_init_sha256.slice(0, 12)}... but ${path} hashes to ${sha.slice(0, 12)}...; the gateway would refuse (TEMPLATE_MISMATCH)`);
    }
    add('Template', 'PASS', `sha256 ${sha.slice(0, 16)}..., every placeholder whitelisted${mandate ? ', matches the mandate' : ''}`);
  });

  // ---- Hetzner -----------------------------------------------------------------------
  const hzToken = env.HETZNER_TOKEN;
  const hz = <T>(path: string) =>
    requestJson<T>({ provider: 'hetzner', fetch: f, timeoutMs: 15_000 }, `${HETZNER}${path}`, {
      headers: { authorization: `Bearer ${hzToken}` },
    });
  /** Follows `meta.pagination.next_page`, reading defensively. */
  const hzAll = async (path: string, key: string): Promise<Record<string, unknown>[]> => {
    const out: Record<string, unknown>[] = [];
    for (let page = 1; page <= 10; page++) {
      const r = asRecord(await hz(`${path}${path.includes('?') ? '&' : '?'}per_page=50&page=${page}`));
      out.push(...asArray(r[key]).map(asRecord));
      const next = asRecord(asRecord(r.meta).pagination).next_page;
      if (!next) break;
    }
    return out;
  };

  // A handoff mandate buys nothing at Hetzner, so none of its checks apply.
  const handoffMandate = mandate && isHandoff(mandate) ? mandate : undefined;
  const guardedHz: typeof guarded = (check, fn) => (handoffMandate ? Promise.resolve() : guarded(check, fn));
  let hetznerUsable = false;
  if (handoffMandate) {
    add('Hetzner', 'SKIP', 'handoff mandate: a human buys the server, so token, firewall, server type and orphan checks do not apply');
    add(
      'Operator token',
      env.GATEWAY_OPERATOR_TOKEN ? (env.GATEWAY_OPERATOR_TOKEN === env.GATEWAY_BEARER_TOKEN ? 'FAIL' : 'PASS') : 'FAIL',
      env.GATEWAY_OPERATOR_TOKEN
        ? env.GATEWAY_OPERATOR_TOKEN === env.GATEWAY_BEARER_TOKEN
          ? 'GATEWAY_OPERATOR_TOKEN equals GATEWAY_BEARER_TOKEN: Pilot could then register a server itself'
          : 'set and distinct from the agent bearer'
        : 'GATEWAY_OPERATOR_TOKEN is not set: handoff card and register would be refused (401)',
    );
    const vendorNote = `a human buys ${handoffMandate.provision.plan} at ${handoffMandate.provision.vendor}; the $${handoffMandate.provision.expected_monthly_usd}/mo price is advisory and cannot be checked from here`;
    add('Handoff', 'WARN', vendorNote);
  } else if (!hzToken) {
    add('Hetzner token', 'SKIP', 'HETZNER_TOKEN not set');
  } else {
    await guarded('Hetzner token', async () => {
      try {
        const keys = await hzAll('/ssh_keys', 'ssh_keys');
        hetznerUsable = true;
        add('Hetzner token', 'PASS', 'token accepted (read)');
        add('Hetzner write access', 'WARN', 'write permission cannot be verified without buying');

        const wanted = (env.HETZNER_SSH_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const have = new Set(keys.flatMap((k) => [String(k.name), String(k.id)]));
        const missing = wanted.filter((w) => !have.has(w));
        if (!wanted.length) add('Hetzner SSH keys', 'FAIL', 'HETZNER_SSH_KEYS is empty');
        else if (missing.length) add('Hetzner SSH keys', 'FAIL', `not found in this Hetzner project: ${missing.join(', ')}`);
        else add('Hetzner SSH keys', 'PASS', `${wanted.length} configured key(s) exist`);
      } catch (e) {
        add('Hetzner token', 'FAIL', authRejected(e) ? `token rejected (${(e as ProviderError).status}); check HETZNER_TOKEN` : errText(e));
      }
    });
  }

  // Firewall + egress IP
  let firewallSources: string[] | undefined;
  await guardedHz('Hetzner firewall', async () => {
    const id = env.HETZNER_FIREWALL_ID;
    if (!id) {
      return add('Hetzner firewall', 'WARN', 'HETZNER_FIREWALL_ID unset: server creation is refused unless ALLOW_INSECURE_COOLIFY_HTTP=true');
    }
    if (!hetznerUsable) return add('Hetzner firewall', 'SKIP', 'Hetzner token unusable');
    try {
      const fw = asRecord(asRecord(await hz(`/firewalls/${encodeURIComponent(id)}`)).firewall);
      const rules = asArray(fw.rules).map(asRecord).filter((r) => r.direction === 'in' && r.protocol === 'tcp' && portIncludes(r.port, 8000));
      if (!rules.length) return add('Hetzner firewall', 'WARN', `firewall ${id} has no inbound tcp/8000 rule: the gateway could not reach Coolify`);
      firewallSources = rules.flatMap((r) => asArray(r.source_ips).map(String));
      const open = firewallSources.filter((s) => s === '0.0.0.0/0' || s === '::/0');
      if (open.length) return add('Hetzner firewall', 'WARN', `tcp/8000 is open to ${open.join(', ')}: Coolify's plain-HTTP API is exposed`);
      add('Hetzner firewall', 'PASS', `tcp/8000 restricted to ${firewallSources.join(', ')}`);
    } catch (e) {
      add('Hetzner firewall', 'FAIL', (e as ProviderError).status === 404 ? `firewall ${id} does not exist` : errText(e));
    }
  });

  await guardedHz('Egress IP', async () => {
    const ip = env.GATEWAY_EGRESS_IP;
    if (!ip) return add('Egress IP', 'WARN', "GATEWAY_EGRESS_IP unset: Coolify's allowed_ips will be empty");
    if (!firewallSources) return add('Egress IP', 'SKIP', 'no firewall rule to compare against');
    if (firewallSources.some((c) => cidrCovers(c, ip))) return add('Egress IP', 'PASS', `${ip} is allowed on tcp/8000`);
    add('Egress IP', 'WARN', `${ip} is not allowed by the firewall's tcp/8000 rule (allows ${firewallSources.join(', ')}); Coolify would not answer the gateway`);
  });

  // Server type, location, orphans
  await guardedHz('Server type', async () => {
    if (!mandate) return add('Server type', 'SKIP', 'no --mandate given');
    if (!hetznerUsable) return add('Server type', 'SKIP', 'Hetzner token unusable');
    if (mandate.provision.provider !== 'hetzner') return;
    const { server_type: type, location } = mandate.provision;
    try {
      const st = (await hzAll(`/server_types?name=${encodeURIComponent(type)}`, 'server_types')).find((t) => t.name === type);
      if (!st) return add('Server type', 'FAIL', `Hetzner does not list server type "${type}"`);
      const notes: string[] = [];
      let status: Status = 'PASS';
      if (st.deprecated === true || st.deprecation) {
        status = 'WARN';
        notes.push('marked deprecated by Hetzner');
      }
      const prices = asArray(st.prices).map(asRecord);
      if (prices.length) {
        const hit = prices.find((p) => p.location === location);
        if (!hit) {
          status = 'WARN';
          notes.push(`no price listed for ${location}; it may not be available there`);
        } else {
          const eur = Number(asRecord(hit.price_monthly).gross);
          const pinned = PINNED_PRICES_USD_MONTH[type];
          if (Number.isFinite(eur)) {
            const usd = Math.round(eur * (FX_TO_USD.EUR ?? 1.1) * 100) / 100;
            notes.push(`Hetzner lists EUR ${eur}/mo gross (~$${usd}); pinned table has ${pinned === undefined ? 'nothing' : `$${pinned}`}`);
            if (pinned !== undefined && usd > pinned) {
              status = 'WARN';
              notes.push('pinned price is BELOW the listed price: update PINNED_PRICES_USD_MONTH (step B0)');
            }
          }
        }
      } else {
        status = 'WARN';
        notes.push('availability per location could not be read from the response');
      }
      add('Server type', status, `${type}: ${notes.join('; ') || 'listed'}`);
    } catch (e) {
      add('Server type', 'FAIL', errText(e));
    }
  });

  await guardedHz('Location', async () => {
    if (!mandate) return add('Location', 'SKIP', 'no --mandate given');
    if (!hetznerUsable) return add('Location', 'SKIP', 'Hetzner token unusable');
    try {
      const names = (await hzAll('/locations', 'locations')).map((l) => String(l.name));
      if (mandate.provision.provider !== 'hetzner') return;
      const loc = mandate.provision.location;
      add('Location', names.includes(loc) ? 'PASS' : 'FAIL', names.includes(loc) ? `${loc} exists` : `Hetzner has no location "${loc}" (has ${names.join(', ')})`);
    } catch (e) {
      add('Location', 'FAIL', errText(e));
    }
  });

  await guardedHz('Orphans', async () => {
    if (!hetznerUsable) return add('Orphans', 'SKIP', 'Hetzner token unusable');
    try {
      const servers = await hzAll(`/servers?label_selector=${encodeURIComponent('managed_by=varsiko-pilot')}`, 'servers');
      if (!servers.length) return add('Orphans', 'PASS', 'no servers labelled managed_by=varsiko-pilot');
      add('Orphans', 'WARN', `${servers.length} server(s) labelled managed_by=varsiko-pilot already exist (they cost money until deleted)`,
        servers.map((s) => `id ${s.id}  ${s.name}  mandate ${asRecord(s.labels).mandate_id ?? '?'}  age ${age(s.created, now)}`));
    } catch (e) {
      add('Orphans', 'FAIL', errText(e));
    }
  });

  // ---- Cloudflare --------------------------------------------------------------------
  await guarded('Cloudflare', async () => {
    const token = env.CLOUDFLARE_TOKEN;
    if (!token) return add('Cloudflare', 'SKIP', 'CLOUDFLARE_TOKEN unset: DNS cutover tools disabled');
    const http = { provider: 'cloudflare', fetch: f, timeoutMs: 15_000 };
    try {
      const r = asRecord(await requestJson(http, 'https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${token}` } }));
      const status = asRecord(r.result).status;
      if (r.success === false || status !== 'active') return add('Cloudflare', 'FAIL', `token is not active (status: ${String(status ?? 'unknown')})`);
    } catch (e) {
      return add('Cloudflare', 'FAIL', authRejected(e) ? 'token rejected' : errText(e));
    }
    const domain = v.domain ?? mandate?.migration.domain;
    if (!domain || domain.endsWith('.invalid')) return add('Cloudflare', 'WARN', 'token active (API shape unverified); no domain to check the zone for');
    try {
      await new CloudflareClient(token, { fetch: f }).zoneIdFor(domain);
      add('Cloudflare', 'PASS', `token active and a zone for ${domain} is visible (API shape unverified)`);
    } catch (e) {
      add('Cloudflare', 'FAIL', `token active but ${errText(e)}`);
    }
  });

  // ---- Vercel ------------------------------------------------------------------------
  await guarded('Vercel', async () => {
    const token = env.VERCEL_TOKEN;
    if (!token) return add('Vercel', 'SKIP', 'VERCEL_TOKEN unset: env export disabled');
    const project = v['vercel-project'] ?? mandate?.migration.vercel_project_id;
    if (!project) return add('Vercel', 'WARN', 'token set; pass --mandate or --vercel-project to inspect a project');
    const q = env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(env.VERCEL_TEAM_ID)}` : '';
    try {
      // No `decrypt`: preflight must never receive a secret value.
      const r = asRecord(
        await requestJson({ provider: 'vercel', fetch: f, timeoutMs: 15_000 }, `https://api.vercel.com/v10/projects/${encodeURIComponent(project)}/env${q}`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      const prod = asArray(r.envs).map(asRecord).filter((e) => targetsOf(e).includes('production') && e.type !== 'system');
      const sensitive = prod.filter((e) => e.type === 'sensitive').map((e) => String(e.key));
      const truncated = asRecord(r.pagination).next != null;
      const detail = `${prod.length} production var(s), ${sensitive.length} sensitive`;
      if (sensitive.length || truncated) {
        return add('Vercel', 'WARN', `${detail}${truncated ? '; more pages exist than were read' : ''}. Sensitive vars are write-only and will NOT be migrated`, sensitive.map((n) => `re-enter by hand: ${n}`));
      }
      add('Vercel', 'PASS', detail);
    } catch (e) {
      add('Vercel', 'FAIL', authRejected(e) ? 'token rejected' : errText(e));
    }
  });

  // ---- Anakin ------------------------------------------------------------------------
  await guarded('Anakin', async () => {
    if (!v['spend-anakin']) return add('Anakin', 'SKIP', 'not checked by default because a scrape uses credits; pass --spend-anakin');
    const key = env.ANAKIN_API_KEY;
    if (!key) return add('Anakin', 'FAIL', '--spend-anakin given but ANAKIN_API_KEY is not set');
    const ak = new AnakinClient(key, { fetch: f });
    try {
      const { jobId } = await ak.submit(PRICE_SOURCE_URL);
      let job = await ak.status(jobId);
      for (let i = 0; i < 30 && (job.status === 'pending' || job.status === 'processing'); i++) {
        await sleep(2_000);
        job = await ak.status(jobId);
      }
      if (job.status !== 'completed') return add('Anakin', 'FAIL', `scrape ${job.status === 'failed' ? `failed: ${job.error ?? 'unknown'}` : 'did not finish in time'}`);
      const md = job.markdown ?? '';
      if (v['save-markdown']) await writeFile(v['save-markdown'], md, 'utf8');
      const type = mandate?.provision.provider === 'hetzner' ? mandate.provision.server_type : 'cpx31';
      const price = extractMonthlyPrice(md, type);
      const saved = v['save-markdown'] ? `; markdown saved to ${v['save-markdown']}` : '';
      if (!price) return add('Anakin', 'WARN', `scrape completed (${md.length} chars) but no monthly price row found for ${type}: fix extraction against the real page${saved}`);
      add('Anakin', 'PASS', `scrape completed; ${type} priced at ${price.currency} ${price.amount}${saved}`);
    } catch (e) {
      add('Anakin', 'FAIL', authRejected(e) ? 'API key rejected' : errText(e));
    }
  });

  // ---- Gateway -----------------------------------------------------------------------
  await guarded('Gateway', async () => {
    const gf = deps.gatewayFetch ?? fetch;
    const url = env.GATEWAY_URL ?? 'http://127.0.0.1:8787/mcp';
    const origin = new URL(url).origin;
    let health: Response;
    try {
      health = await gf(`${origin}/healthz`, { signal: AbortSignal.timeout(5_000) });
    } catch {
      return add('Gateway', 'WARN', `not reachable at ${origin} (start it with npm run gateway)`);
    }
    if (!health.ok) return add('Gateway', 'FAIL', `/healthz answered ${health.status}`);
    if (!env.GATEWAY_BEARER_TOKEN) return add('Gateway', 'WARN', 'healthy, but GATEWAY_BEARER_TOKEN is unset so tools/list was not checked');
    const res = await gf(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.GATEWAY_BEARER_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) return add('Gateway', 'FAIL', 'healthy, but it rejects GATEWAY_BEARER_TOKEN (401)');
    const body = asRecord(await res.json().catch(() => ({})));
    const names = asArray(asRecord(body.result).tools).map((t) => String(asRecord(t).name));
    const agentTools = TOOLS.filter((t) => t.role === 'agent');
    const missing = agentTools.map((t) => t.name).filter((n) => !names.includes(n));
    if (missing.length || names.length !== agentTools.length) {
      return add('Gateway', 'FAIL', `expected ${agentTools.length} tools, got ${names.length}${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
    }
    add('Gateway', 'PASS', `healthy, ${names.length} tools listed`);
  });

  // ---- Report ------------------------------------------------------------------------
  if (!configOk) io.out(scrub('note: config did not fully load, so checks that rely on missing variables are skipped or fail.'));
  const width = Math.max(...rows.map((r) => r.check.length));
  for (const r of rows) {
    io.out(scrub(`${r.status.padEnd(4)}  ${r.check.padEnd(width)}  ${r.detail}`));
    for (const x of r.extra ?? []) io.out(scrub(`      ${' '.repeat(width)}  - ${x}`));
  }
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  io.out('');
  io.out(scrub(`${count('PASS')} pass, ${count('WARN')} warn, ${count('FAIL')} fail, ${count('SKIP')} skip`));
  io.out('Response shapes for Hetzner list endpoints and Cloudflare are from memory and unverified until a live run.');
  return count('FAIL') ? 1 : 0;
}

if (import.meta.main) await runMain((argv, io) => preflight(argv, io));
