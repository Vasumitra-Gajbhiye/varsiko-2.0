import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { HetznerClient } from '../gateway/clients/hetzner.ts';
import { PINNED_PRICES_USD_MONTH } from '../pilot/guard.ts';
import { FileLedger, settle } from '../pilot/ledger.ts';
import { verifyMandate, type Mandate } from '../pilot/mandate.ts';
import { NasikoGateway, nasikoProviders, type Providers } from '../pilot/providers.ts';
import { advance, newRun, type RunContext, type RunState } from '../pilot/runbook.ts';
import { runMain, UsageError, type CliIo } from './io.ts';

export const DEFAULT_LOCAL_DIR = '.local';
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8787/mcp';
/** Coolify's installer takes minutes. The runbook's own default of 20 polls would destroy a healthy box. */
const BOOT_BUDGET_SECONDS = 15 * 60;

export interface LiveDeps {
  /** Reaches the gateway. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Reaches Hetzner, only to list orphans after --cleanup. */
  hetznerFetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => Date;
  /** Aborted on Ctrl-C. The current step finishes first; nothing is torn down. */
  signal?: AbortSignal;
}

const TERMINAL = new Set<RunState['status']>(['DEPLOYED', 'CUTOVER', 'FAILED', 'ROLLED_BACK']);
const EXIT_INTERRUPTED = 130;

const USAGE = `Usage:
  npm run live -- --mandate <file> [--run-id <id>] [--poll-seconds 10] [--max-polls <n>]
                  [--stop-after boot|deploy] [--resume] [--yes]
  npm run live -- --cutover --mandate <file> --auditor-token <file> --run-id <id> [--yes]
  npm run live -- --cleanup --mandate <file> --run-id <id> [--yes]

Runs the REAL runbook against the REAL gateway (GATEWAY_URL), bypassing Nasiko, so provider
problems can be told apart from Nasiko problems. It spends money and can change DNS.

  --stop-after boot     stop once Coolify is healthy, to inspect the box by hand
  --stop-after deploy   stop once the deployment is queued (before verification polling)
  --resume              continue a saved run (state in .local/runs/<id>.json)
  --cleanup             delete the server this run bought (and revert its DNS record)
  --cutover             point the domain at the deployed server (needs an Auditor token)
  --max-polls <n>       give up on boot/deploy after n polls, then destroy the server
                        (default: about 15 minutes' worth at --poll-seconds)
  --local-dir <dir>     default ${DEFAULT_LOCAL_DIR}

Exit codes: 0 deployed/cut over/stopped, 1 failed/rolled back, 2 usage or declined,
3 needs approval, 130 interrupted.`;

const runFile = (local: string, id: string) => join(local, 'runs', `${id}.json`);

async function loadState(local: string, id: string): Promise<RunState | null> {
  try {
    return JSON.parse(await readFile(runFile(local, id), 'utf8')) as RunState;
  } catch {
    return null;
  }
}

async function saveState(local: string, s: RunState): Promise<void> {
  await mkdir(join(local, 'runs'), { recursive: true });
  await writeFile(runFile(local, s.run_id), JSON.stringify(s, null, 2));
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

export async function liveCommand(argv: string[], io: CliIo, deps: LiveDeps = {}): Promise<number> {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      mandate: { type: 'string' },
      'run-id': { type: 'string' },
      'poll-seconds': { type: 'string', default: '10' },
      'max-polls': { type: 'string' },
      'stop-after': { type: 'string' },
      'auditor-token': { type: 'string' },
      'local-dir': { type: 'string', default: DEFAULT_LOCAL_DIR },
      resume: { type: 'boolean', default: false },
      cutover: { type: 'boolean', default: false },
      cleanup: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (v.help) {
    io.out(USAGE);
    return 0;
  }

  // ---- inputs ------------------------------------------------------------------------
  if (!v.mandate) throw new UsageError('--mandate <file> is required (see --help)');
  if (v.cutover && v.cleanup) throw new UsageError('--cutover and --cleanup are separate modes');
  if (v['stop-after'] && !['boot', 'deploy'].includes(v['stop-after'])) throw new UsageError('--stop-after must be boot or deploy');
  const pollSeconds = Number(v['poll-seconds']);
  if (!Number.isFinite(pollSeconds) || pollSeconds < 0) throw new UsageError('--poll-seconds must be a number >= 0');
  const local = v['local-dir']!;

  const env = io.env;
  const bearer = env.GATEWAY_BEARER_TOKEN;
  if (!bearer) throw new UsageError('GATEWAY_BEARER_TOKEN is not set (it must match the gateway .env)');
  if (!env.MANDATE_PUBLIC_KEY_FILE) throw new UsageError('MANDATE_PUBLIC_KEY_FILE is not set');
  const publicKey = await readFile(env.MANDATE_PUBLIC_KEY_FILE, 'utf8').catch(() => {
    throw new UsageError(`cannot read ${env.MANDATE_PUBLIC_KEY_FILE}`);
  });

  const file = JSON.parse(
    await readFile(v.mandate, 'utf8').catch(() => {
      throw new UsageError(`cannot read ${v.mandate}`);
    }),
  ) as { mandate?: Mandate; token?: string };
  if (!file.mandate || !file.token) throw new UsageError(`${v.mandate} is not a { mandate, token } file (see npm run mandate)`);
  const token = file.token;
  const mandate = file.mandate;
  const checked = verifyMandate(token, { publicKey, allowExpired: true, now: deps.now?.() });
  if (!checked.ok) throw new UsageError(`the mandate does not verify against MANDATE_PUBLIC_KEY_FILE: ${checked.code}`);

  // Belt and braces: nothing sensitive may reach the screen even by accident.
  const secrets = [bearer, token, env.HETZNER_TOKEN, env.VAULT_KEY, env.CLOUDFLARE_TOKEN, env.VERCEL_TOKEN, env.ANAKIN_API_KEY].filter(
    (s): s is string => Boolean(s) && s!.length >= 8,
  );
  const out = (line: string) => io.out(secrets.reduce((l, s) => l.split(s).join('[redacted]'), line));

  const mode = v.cleanup ? 'cleanup' : v.cutover ? 'cutover' : 'run';
  if ((mode === 'cutover' || mode === 'cleanup') && !v['run-id']) throw new UsageError(`--${mode} needs --run-id`);
  if (v.resume && !v['run-id']) throw new UsageError('--resume needs --run-id');
  if (mode === 'cutover' && !v['auditor-token']) throw new UsageError('--cutover needs --auditor-token <file>');
  const runId = v['run-id'] ?? `run_${(deps.now ?? (() => new Date()))().getTime()}`;
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(runId)) throw new UsageError('--run-id may only contain letters, digits, . _ -');

  // ---- gateway reachability, before anything else -------------------------------------
  const url = env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL;
  const baseFetch = deps.fetch ?? fetch;
  const authFetch: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${bearer}`);
    return baseFetch(input, { ...init, headers });
  };
  try {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) throw new UsageError('the gateway rejected GATEWAY_BEARER_TOKEN (401): it must match the gateway\'s .env');
    if (!res.ok) throw new UsageError(`the gateway answered ${res.status} at ${url}`);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`cannot reach the gateway at ${url}: start it with npm run gateway`);
  }

  const gw = new NasikoGateway({ url, token: 'direct', fetch: authFetch });
  const baseProviders = (auditorToken?: string): Providers => nasikoProviders(gw, { mandate: token, runId, auditorToken });

  // ---- shared pieces -------------------------------------------------------------------
  const pinned = PINNED_PRICES_USD_MONTH[mandate.provision.server_type];
  const dnsAllowed = mandate.scope.some((s) => s === 'cloudflare:*' || s === 'cloudflare:dns.upsert');
  const expired = Date.parse(mandate.exp) < (deps.now ?? (() => new Date()))().getTime();
  const maxPolls = v['max-polls'] ? Number(v['max-polls']) : Math.max(20, pollSeconds > 0 ? Math.ceil(BOOT_BUDGET_SECONDS / pollSeconds) : 20);
  if (!Number.isInteger(maxPolls) || maxPolls < 1) throw new UsageError('--max-polls must be a positive integer');

  const banner = (title: string, extra: string[]) => {
    out('='.repeat(72));
    out(`  ${title}`);
    out('='.repeat(72));
    out(`  DIRECT MODE: Nasiko is bypassed, so no Nasiko approval or audit applies`);
    out(`  run id        ${runId}     mandate ${mandate.mandate_id}`);
    out(`  server        1 x ${mandate.provision.server_type} in ${mandate.provision.location}   cap $${mandate.budget.max_monthly_usd}/mo` +
      (pinned ? `   (~$${(pinned / 730).toFixed(3)}/hour at the pinned $${pinned}/mo)` : ''));
    out(`  repository    ${mandate.migration.git_repository}@${mandate.migration.git_branch}`);
    out(`  DNS           ${dnsAllowed ? `ENABLED for ${mandate.migration.domain} (only via --cutover)` : 'disabled (cloudflare not in scope)'}`);
    for (const l of extra) out(`  ${l}`);
    out('='.repeat(72));
  };
  const confirmed = async (question: string) => {
    if (v.yes) return true;
    if (await io.confirm(question)) return true;
    out('Not confirmed; nothing was done.');
    return false;
  };
  const commands = () =>
    [
      `  Continue:  npm run live -- --mandate ${v.mandate} --run-id ${runId} --resume`,
      `  Clean up:  npm run live -- --mandate ${v.mandate} --run-id ${runId} --cleanup`,
    ].join('\n');

  const listOrphans = async () => {
    if (!env.HETZNER_TOKEN) return out('  (set HETZNER_TOKEN to list remaining managed_by=varsiko-pilot servers, or check the Hetzner console)');
    try {
      const left = await new HetznerClient(env.HETZNER_TOKEN, { fetch: deps.hetznerFetch }).findByLabel('managed_by', 'varsiko-pilot');
      out(left.length ? `  ${left.length} server(s) labelled managed_by=varsiko-pilot still exist:` : '  no servers labelled managed_by=varsiko-pilot remain');
      for (const s of left) out(`    id ${s.id}  ${s.name}  mandate ${s.labels.mandate_id ?? '?'}`);
    } catch {
      out('  could not list servers; check the Hetzner console');
    }
  };

  // ---- cleanup -------------------------------------------------------------------------
  if (mode === 'cleanup') {
    const state = await loadState(local, runId);
    if (!state) throw new UsageError(`no saved state for ${runId} (${runFile(local, runId)}); check the Hetzner console for managed_by=varsiko-pilot servers`);
    const { server_id, ip, dns_record_id } = state.artifacts;
    if (!server_id && !dns_record_id) {
      out(`Nothing to clean up: ${runId} never bought a server.`);
      await listOrphans();
      return 0;
    }
    banner('CLEANUP', [
      `will delete    server ${server_id ?? '(none)'}${ip ? ` (${ip})` : ''}`,
      ...(dns_record_id ? [`will revert     DNS record ${dns_record_id} to its previous value first`] : []),
    ]);
    if (!(await confirmed('Delete it?'))) return 2;

    const p = baseProviders();
    try {
      if (dns_record_id) {
        await p.cloudflare.rollback(dns_record_id);
        out('  DNS record reverted');
      }
      if (server_id) {
        try {
          await p.hetzner.deleteServer(server_id);
          out(`  destroyed server ${server_id}`);
        } catch (e) {
          if (!/\b404\b/.test((e as Error).message)) throw e;
          out(`  server ${server_id} was already gone (404)`);
        }
      }
    } catch (e) {
      out(`Cleanup FAILED: ${(e as Error).message}`);
      out('  Check the Hetzner console by hand.');
      return 1;
    }
    const cleaned: RunState = {
      ...state,
      status: 'ROLLED_BACK',
      cost_committed_usd: 0,
      error: 'cleaned up by operator (--cleanup)',
      next_owner: 'operator',
      log: [...state.log, `CLEANUP      destroyed ${server_id ?? '(no server)'}${dns_record_id ? ', reverted DNS' : ''}`],
    };
    await saveState(local, cleaned);
    await listOrphans();
    return 0;
  }

  // ---- run / resume / cutover: load or create state ------------------------------------
  const ledger = new FileLedger(join(local, 'pilot-ledger.jsonl'), deps.now);
  let state: RunState;
  const saved = await loadState(local, runId);

  if (mode === 'cutover') {
    if (!saved) throw new UsageError(`no saved state for ${runId}; deploy it first`);
    const deployed = saved.status === 'DEPLOYED' || saved.step === 'P8_CUTOVER';
    if (!deployed || !saved.artifacts.ip) throw new UsageError(`${runId} is ${saved.status} at ${saved.step}: cutover needs a DEPLOYED run`);
    state = { ...saved, step: 'P8_CUTOVER', status: 'RUNNING', error: undefined, next_owner: 'Pilot' };
  } else if (v.resume) {
    if (!saved) throw new UsageError(`no saved state for ${runId} (${runFile(local, runId)})`);
    state = saved;
    // An unknown purchase outcome is exactly what --resume is for: the gateway reconciles by
    // Hetzner label. Reopen the run, and release THIS run's open agent-side INTENT (the gateway's
    // own ledger stays authoritative and never re-buys).
    if (state.status === 'FAILED' && state.step === 'P2_PROVISION' && /outcome unknown|IN_FLIGHT/.test(state.error ?? '')) {
      state = { ...state, status: 'RUNNING', error: undefined, next_owner: 'Pilot' };
    }
    const key = `${state.mandate_id}:P2`;
    const last = (await ledger.rows()).findLast((r) => r.key === key);
    if (last?.state === 'INTENT' && last.run_id === runId) {
      await settle(ledger, { run_id: runId, mandate_id: last.mandate_id, nonce: last.nonce, step: 'P2', key }, 'FAILED');
      out('  released this run\'s open purchase INTENT; the gateway will reconcile by label and will not buy twice');
    }
  } else {
    if (saved) throw new UsageError(`${runId} already exists (${runFile(local, runId)}). Use --resume, or pick a new --run-id.`);
    state = newRun(runId);
  }

  const auditorToken = v['auditor-token']
    ? (await readFile(v['auditor-token'], 'utf8').catch(() => {
        throw new UsageError(`cannot read ${v['auditor-token']}`);
      })).trim()
    : undefined;

  const ctx: RunContext = {
    mandateToken: token,
    publicKey,
    providers: baseProviders(auditorToken),
    ledger,
    auditorPassToken: auditorToken,
    now: deps.now,
    maxPolls,
    maxPricePolls: Math.max(30, maxPolls),
  };

  // ---- banner and confirmation ---------------------------------------------------------
  if (mode === 'cutover') {
    banner('CUTOVER (changes DNS)', [
      `will point      ${mandate.migration.domain} -> ${state.artifacts.ip} (A record, TTL 60)`,
      'evidence        Auditor PASS token, checked by the gateway',
    ]);
    if (!(await confirmed('Change DNS?'))) return 2;
  } else {
    banner(v.resume ? 'RESUME (may spend)' : 'LIVE RUN (spends real money)', [
      `mandate valid   until ${mandate.exp}${expired && !state.artifacts.server_id ? '  ** EXPIRED: the gateway will refuse to start spending **' : ''}`,
      `after purchase  ${mandate.run_window_minutes ?? 120} min window; gives up after ${maxPolls} polls (~${Math.round((maxPolls * pollSeconds) / 60)} min) and destroys the server`,
      ...(v['stop-after'] ? [`stops after     ${v['stop-after']}`] : []),
    ]);
    if (!(await confirmed(v.resume ? 'Resume this run?' : 'Buy a server and start the migration?'))) return 2;
  }

  // ---- the loop ------------------------------------------------------------------------
  const sleep = deps.sleep ?? defaultSleep;
  const reached = (s: RunState) =>
    v['stop-after'] === 'boot'
      ? ['P4_PROJECT', 'P5_ENVS', 'P6_DEPLOY', 'P7_VERIFY', 'DONE'].includes(s.step) && Boolean(s.artifacts.ip)
      : v['stop-after'] === 'deploy'
        ? ['P7_VERIFY', 'DONE'].includes(s.step)
        : false;

  let printed = state.log.length;
  if (v.resume) out(`Resuming ${runId} at ${state.step} (${state.status}).`);
  let stopped = false;
  let interrupted = false;

  while (!TERMINAL.has(state.status) && state.status !== 'NEEDS_APPROVAL') {
    if (reached(state)) {
      stopped = true;
      break;
    }
    if (deps.signal?.aborted) {
      interrupted = true;
      break;
    }
    const before = state.log.length;
    state = await advance(state, ctx);
    await saveState(local, state);
    for (const line of state.log.slice(printed)) out(`  ${line}`);
    printed = state.log.length;
    if (state.log.length === before && !TERMINAL.has(state.status) && state.status !== 'NEEDS_APPROVAL') {
      out(`No progress at ${state.step}; stopping. State saved.`);
      return 1;
    }
    if (state.status === 'WAITING' && !reached(state)) await sleep(pollSeconds * 1000, deps.signal);
  }

  // ---- report --------------------------------------------------------------------------
  const bought = state.artifacts.server_id ? 1 : 0;
  if (state.error) out(`  error: ${state.error}`);
  out(
    `${state.status}  step=${state.step}  servers_bought=${bought}  dns_writes=${state.artifacts.dns_record_id ? 1 : 0}  ` +
      `committed=$${state.cost_committed_usd}/mo  next=${state.next_owner}`,
  );
  if (state.artifacts.ip) out(`  server ${state.artifacts.server_id} at ${state.artifacts.ip}  (Coolify: http://${state.artifacts.ip}:8000)`);
  if (state.env_skipped?.length) out(`  re-enter by hand: ${state.env_skipped.join(', ')}`);
  out(`  state: ${runFile(local, runId).replace(/\\/g, '/')}`);

  if (interrupted) {
    out(`Interrupted at ${state.step}. Nothing was deleted.`);
    out(commands());
    return EXIT_INTERRUPTED;
  }
  if (stopped) {
    out(`Stopped after ${v['stop-after']} as requested.`);
    out(commands());
    return 0;
  }
  if (state.status === 'NEEDS_APPROVAL') return 3;
  return state.status === 'DEPLOYED' || state.status === 'CUTOVER' ? 0 : 1;
}

if (import.meta.main) {
  const ac = new AbortController();
  process.on('SIGINT', () => {
    if (ac.signal.aborted) process.exit(EXIT_INTERRUPTED); // second Ctrl-C: leave now
    console.log('\nCtrl-C: finishing the current step, then stopping (press again to exit immediately).');
    ac.abort();
  });
  await runMain((argv, io) => liveCommand(argv, io, { signal: ac.signal }));
}

