import { createPublicKey, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256Hex } from '../gateway/cloudinit.ts';
import { PINNED_PRICES_USD_MONTH } from '../pilot/guard.ts';
import { HANDOFF_IMAGES, HANDOFF_SCOPES, signMandate, verifyMandate, type Mandate, type Provision } from '../pilot/mandate.ts';
import { DEFAULT_KEY_DIR, KEY_FILES } from './keygen.ts';
import { runMain, UsageError, type CliIo } from './io.ts';

export const DEFAULT_MANDATE_DIR = '.local/mandates';
export const DEFAULT_TEMPLATE = 'cloud-init/coolify.yaml';

/** Same list `devMandate` uses; `--no-dns` drops the cloudflare entries. */
const DNS_SCOPES = ['cloudflare:dns.upsert', 'cloudflare:dns.rollback'];
const SCOPES = [
  'hetzner:server.create',
  'hetzner:server.delete',
  'coolify:*',
  ...DNS_SCOPES,
  'vercel:env.export',
  'anakin:scrape.*',
];

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
/** Placeholder for `migration.domain` when DNS is out of scope. `.invalid` never resolves. */
const NO_DNS_DOMAIN = 'no-dns.invalid';

/** Handoff mandates carry no hetzner or anakin scope: Pilot buys nothing and scrapes nothing. */
const HANDOFF_MANDATE_SCOPES = [...HANDOFF_SCOPES, 'coolify:*', ...DNS_SCOPES, 'vercel:env.export'];

const USAGE = `Usage: npm run mandate -- [options]

Issues a signed, single-use mandate authorising ONE server and ONE migration.

  --handoff               A HUMAN buys the server (any vendor with cloud-init); Pilot continues from
                          boot. Replaces --server-type/--location/--max-monthly with:
    --vendor <name>         e.g. contabo
    --plan <name>           the vendor plan name
    --region <name>         the vendor region
    --expected-monthly <usd> ADVISORY price, shown on the card; nothing enforces it
    --source-url <https://> where the price was seen (shown, never fetched)
                          --image must be one of ${HANDOFF_IMAGES.join(', ')}; --ttl-minutes defaults to 1440
                          (max 4320) because a person has to buy the server

  --server-type <t>       Hetzner server type, must have a pinned price (e.g. cpx31)
  --location <l>          Hetzner location (e.g. nbg1)
  --repo <owner/name|url> Git repository to deploy (owner/name means github.com)
  --vercel-project <id>   Vercel project id to export env vars from
  --max-monthly <usd>     Spend cap; must cover the pinned price
  --approved-by <email>   Who is approving this
  --domain <host>         Domain to cut over (required unless --no-dns)
  --image <i>             Default ubuntu-24.04
  --branch <b>            Default main
  --max-hourly <usd>      Default derived from --max-monthly
  --ttl-minutes <n>       Time to START spending. Default 10 (1440 with --handoff)
  --run-window <n>        Minutes allowed after purchase. Default 60
  --no-dns                Exclude cloudflare from scope
  --prediction-sha256 <h> Surveyor prediction hash (else a placeholder, with a warning)
  --yes                   Skip the confirmation prompt
  --key <file>            Mandate private key (default ${DEFAULT_KEY_DIR}/${KEY_FILES.mandatePrivate})
  --template <file>       cloud-init template (default ${DEFAULT_TEMPLATE})
  --out-dir <dir>         Default ${DEFAULT_MANDATE_DIR}`;

const positive = (name: string, raw: string | undefined, max: number): number => {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0 || n > max) throw new UsageError(`${name} must be a number in (0, ${max}]`);
  return n;
};

const need = (name: string, v: string | undefined): string => {
  if (!v) throw new UsageError(`--${name} is required (see --help)`);
  return v;
};

/** `owner/name` becomes a github.com URL; anything else must already be an https URL. */
export function normalizeRepo(raw: string): string {
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return `https://github.com/${raw}`;
  if (/^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9_./-]+$/.test(raw)) return raw;
  throw new UsageError('--repo must look like owner/name or an https:// URL');
}

const label = (repo: string) => repo.replace(/^https:\/\/github\.com\//, '');

export async function mandateCommand(
  argv: string[],
  io: CliIo,
  deps: { now?: () => Date } = {},
): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      'server-type': { type: 'string' },
      location: { type: 'string' },
      image: { type: 'string', default: 'ubuntu-24.04' },
      repo: { type: 'string' },
      branch: { type: 'string', default: 'main' },
      domain: { type: 'string' },
      'vercel-project': { type: 'string' },
      'max-monthly': { type: 'string' },
      'max-hourly': { type: 'string' },
      'ttl-minutes': { type: 'string' },
      handoff: { type: 'boolean', default: false },
      vendor: { type: 'string' },
      plan: { type: 'string' },
      region: { type: 'string' },
      'expected-monthly': { type: 'string' },
      'source-url': { type: 'string' },
      'run-window': { type: 'string', default: '60' },
      'approved-by': { type: 'string' },
      'prediction-sha256': { type: 'string' },
      'no-dns': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      key: { type: 'string', default: join(DEFAULT_KEY_DIR, KEY_FILES.mandatePrivate) },
      template: { type: 'string', default: DEFAULT_TEMPLATE },
      'out-dir': { type: 'string', default: DEFAULT_MANDATE_DIR },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }

  const handoff = v.handoff!;
  // Checked here, not with the rest of the lane's inputs below, so the automated lane still
  // reports a missing --server-type/--location before anything else.
  if (!handoff) {
    need('server-type', v['server-type']);
    need('location', v.location);
  }
  const repo = normalizeRepo(need('repo', v.repo));
  const vercelProject = need('vercel-project', v['vercel-project']);
  const approvedBy = need('approved-by', v['approved-by']);
  const ttlMinutes = handoff
    ? positive('--ttl-minutes', v['ttl-minutes'] ?? '1440', 4320)
    : positive('--ttl-minutes', v['ttl-minutes'] ?? '10', 240);
  const runWindow = positive('--run-window', v['run-window'], 1440);
  const domain = v.domain ?? (v['no-dns'] ? NO_DNS_DOMAIN : undefined);
  if (!domain) throw new UsageError('--domain is required unless --no-dns is set');
  if (!v['no-dns'] && !HOSTNAME.test(domain)) throw new UsageError('--domain must be a hostname such as app.example.com');
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(vercelProject)) throw new UsageError('--vercel-project has unexpected characters');
  if (!/^[A-Za-z0-9_./-]{1,100}$/.test(v.branch!)) throw new UsageError('--branch has unexpected characters');

  let serverType = '';
  let location = '';
  let pinned = 0;
  let maxMonthly: number;
  let provision: Provision;
  const template = await readFile(v.template!, 'utf8').catch(() => {
    throw new UsageError(`cannot read cloud-init template ${v.template}`);
  });
  if (handoff) {
    for (const f of ['vendor', 'plan', 'region', 'expected-monthly', 'source-url'] as const) need(f, v[f]);
    if (v['server-type'] || v.location || v['max-monthly']) {
      throw new UsageError('--server-type, --location and --max-monthly belong to the automated lane; --handoff uses --vendor/--plan/--region/--expected-monthly');
    }
    maxMonthly = positive('--expected-monthly', v['expected-monthly'], 500);
    provision = {
      provider: 'handoff',
      vendor: v.vendor!,
      plan: v.plan!,
      region: v.region!,
      image: v.image!,
      expected_monthly_usd: maxMonthly,
      source_url: v['source-url']!,
      count: 1,
      cloud_init_sha256: sha256Hex(template),
    };
  } else {
    serverType = need('server-type', v['server-type']);
    location = need('location', v.location);
    maxMonthly = positive('--max-monthly', v['max-monthly'], 10_000);
    // The pinned table is the ceiling the gateway budgets against, so a mandate the gateway
    // could never accept is refused here, before anyone approves it.
    const p = PINNED_PRICES_USD_MONTH[serverType];
    if (p === undefined) {
      throw new UsageError(
        `no pinned price for server type "${serverType}". Known: ${Object.keys(PINNED_PRICES_USD_MONTH).join(', ')}`,
      );
    }
    pinned = p;
    if (maxMonthly < pinned) {
      throw new UsageError(`--max-monthly ${maxMonthly} is below the pinned price $${pinned}/mo for ${serverType}; the gateway would refuse this purchase`);
    }
    provision = {
      provider: 'hetzner',
      server_type: serverType,
      image: v.image!,
      location,
      count: 1,
      cloud_init_sha256: sha256Hex(template),
    };
  }
  const maxHourly = v['max-hourly'] ? positive('--max-hourly', v['max-hourly'], 1000) : Math.ceil((maxMonthly / 730) * 10_000) / 10_000;

  const keyPem = await readFile(v.key!, 'utf8').catch(() => {
    throw new UsageError(`cannot read mandate key ${v.key} (run \`npm run keygen\`?)`);
  });

  const now = (deps.now ?? (() => new Date()))();
  const mandate: Mandate = {
    mandate_id: `mdt_${now.getTime()}`,
    nonce: randomBytes(16).toString('hex'),
    iat: now.toISOString(),
    exp: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    approved_by: approvedBy,
    scope: (handoff ? HANDOFF_MANDATE_SCOPES : SCOPES).filter((s) => !v['no-dns'] || !DNS_SCOPES.includes(s)),
    budget: { max_monthly_usd: maxMonthly, max_hourly_usd: maxHourly },
    provision,
    migration: { vercel_project_id: vercelProject, git_repository: repo, git_branch: v.branch!, domain },
    surveyor_prediction_sha256: v['prediction-sha256'] ?? sha256Hex('manual-test'),
    run_window_minutes: runWindow,
  };

  if (provision.provider === 'handoff') {
    // Refuse a malformed handoff provision before anyone is asked to approve it.
    const pre = verifyMandate(signMandate(mandate, keyPem), { publicKey: createPublicKey(keyPem), now });
    if (!pre.ok) throw new UsageError(pre.reason);
    io.out(`This authorises a HUMAN to buy, and Pilot to migrate ${label(repo)}@${v.branch} onto, exactly this server:`);
    io.out(`  vendor                 ${provision.vendor}`);
    io.out(`  plan                   ${provision.plan}`);
    io.out(`  region                 ${provision.region}`);
    io.out(`  image                  ${provision.image}`);
    io.out(`  expected price         $${provision.expected_monthly_usd}/mo (ADVISORY: nothing enforces it; the human pays and Pilot cannot check)`);
    io.out(`  price seen at          ${provision.source_url}`);
    io.out(`  time to buy + register ${ttlMinutes} min from now (mandate expires ${mandate.exp})`);
    io.out(`  after registration     ${runWindow} min to finish`);
  } else {
    io.out(
      `This authorises buying 1 x ${serverType} in ${location}, capped at $${maxMonthly}/mo, valid ${ttlMinutes} min, ` +
        `deploying ${label(repo)}@${v.branch}`,
    );
    io.out(`  pinned price checked   $${pinned}/mo for ${serverType} (approximate; TODO verify against the Hetzner console)`);
    io.out(`  after purchase         ${runWindow} min to finish; hourly cap $${maxHourly}`);
  }
  io.out(`  DNS                    ${v['no-dns'] ? 'DISABLED (cloudflare not in scope)' : `cutover of ${domain} allowed, after an Auditor PASS`}`);
  io.out(`  env source             Vercel project ${vercelProject}`);
  io.out(`  cloud-init template    sha256 ${provision.cloud_init_sha256.slice(0, 16)}...`);
  io.out(`  approved by            ${approvedBy}`);
  if (!v['prediction-sha256']) {
    io.out('  WARNING: no --prediction-sha256; using a placeholder hash (fine for manual tests, not for a real chain)');
  }

  if (!v.yes && !(await io.confirm('Sign this mandate?'))) {
    io.out('Not confirmed; nothing was written.');
    return 2;
  }

  const token = signMandate(mandate, keyPem);
  const check = verifyMandate(token, { publicKey: createPublicKey(keyPem), now });
  if (!check.ok) throw new Error(`internal error: the signed mandate does not verify (${check.code})`);

  await mkdir(v['out-dir']!, { recursive: true });
  const file = join(v['out-dir']!, `${mandate.mandate_id}.json`);
  await writeFile(file, JSON.stringify({ mandate, token }, null, 2), { mode: 0o600 });
  io.out(`Mandate ${mandate.mandate_id} written to ${file.replace(/\\/g, '/')} (the token is inside; do not share it)`);
  return 0;
}

if (import.meta.main) await runMain((argv, io) => mandateCommand(argv, io));
