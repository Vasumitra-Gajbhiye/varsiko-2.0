import { authorize } from './guard.ts';
import { claim, settle, nonceSpent, type Ledger } from './ledger.ts';
import { verifyMandate, type Mandate } from './mandate.ts';
import { PINNED_PRICES_USD_MONTH } from './guard.ts';
import { assessPrice, PRICE_SOURCE_URL, type PriceCheck } from './pricing.ts';
import { McpError, ToolRefusal, type Providers, type ProvisionArgs } from './providers.ts';

export type Step =
  | 'P0_MANDATE'
  | 'P1_PREFLIGHT'
  | 'P1B_PRICE_SUBMIT'
  | 'P1C_PRICE_POLL'
  | 'P2_PROVISION'
  | 'P2H_AWAIT_PURCHASE'
  | 'P3_BOOT'
  | 'P4_PROJECT'
  | 'P5_ENVS'
  | 'P6_DEPLOY'
  | 'P7_VERIFY'
  | 'P8_CUTOVER'
  | 'DONE';

export type RunStatus =
  | 'RUNNING'
  | 'WAITING'
  | 'AWAITING_HUMAN_PURCHASE'
  | 'DEPLOYED'
  | 'CUTOVER'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'NEEDS_APPROVAL';

export interface RunState {
  run_id: string;
  mandate_id: string;
  step: Step;
  status: RunStatus;
  /** Which path this run takes; set at preflight. */
  lane?: 'automated' | 'handoff';
  /** Where the operator's task card was written (a path, never its contents). */
  handoff_card_ref?: string;
  cost_committed_usd: number;
  artifacts: {
    server_id?: string;
    ip?: string;
    project_uuid?: string;
    app_uuid?: string;
    deployment_uuid?: string;
    sealed_ref?: string;
    dns_record_id?: string;
    price_job_id?: string;
  };
  /** Vercel variables that could not be exported (names only). Must be re-entered by hand. */
  env_skipped?: string[];
  /** Result of the Anakin cross-check. Feeds the budget check in P2. */
  pricing?: PriceCheck;
  polls: number;
  log: string[];
  error?: string;
  next_owner: string;
}

export interface RunContext {
  mandateToken: string;
  publicKey: string | import('node:crypto').KeyObject;
  providers: Providers;
  ledger: Ledger;
  now?: () => Date;
  auditorPassToken?: string;
  /**
   * Simulates what a compromised or prompt-injected agent would propose. An honest
   * Pilot passes mandate values through unchanged; the guard is what makes that
   * non-negotiable rather than a promise.
   */
  proposeArgs?: (step: Step, fromMandate: ProvisionArgs) => ProvisionArgs;
  maxPolls?: number;
  /** Poll budget for the Anakin scrape. Each poll is its own short call. */
  maxPricePolls?: number;
  /**
   * If true, a missing or unusable price cross-check halts the run. Default false:
   * the cross-check only ever tightens the budget, so its absence is a warning, not
   * a hazard.
   */
  requirePriceCheck?: boolean;
}

const MAX_POLLS_DEFAULT = 20;
/**
 * A handoff box is provisioned by a person, on a vendor whose boot time we have never
 * measured, and Pilot may resume the moment the operator registers it. Be more patient
 * than for a box we just created ourselves.
 */
const MAX_POLLS_HANDOFF = 60;

export function newRun(runId: string): RunState {
  return {
    run_id: runId,
    mandate_id: '(unverified)',
    step: 'P0_MANDATE',
    status: 'RUNNING',
    cost_committed_usd: 0,
    artifacts: {},
    polls: 0,
    log: [],
    next_owner: 'Pilot',
  };
}

const say = (s: RunState, line: string) => {
  s.log.push(`${s.step.padEnd(12)} ${line}`);
};

function fail(s: RunState, reason: string): RunState {
  s.status = 'FAILED';
  s.error = reason;
  s.next_owner = 'operator';
  say(s, `FAILED ${reason}`);
  return s;
}

/**
 * Advances the run by exactly one step, then returns.
 *
 * Never loops internally. Nasiko's flow guard kills any call at 120s wall clock and
 * MAF retries a failed step up to 3 times by default, so a synchronous runbook would
 * be killed mid-provision and then retried into a double purchase. Callers poll this
 * the same way you poll a scrape job.
 */
export async function advance(state: RunState, ctx: RunContext): Promise<RunState> {
  const s: RunState = { ...state, artifacts: { ...state.artifacts }, log: [...state.log] };
  const now = ctx.now ?? (() => new Date());
  const maxPolls = ctx.maxPolls ?? (s.lane === 'handoff' ? MAX_POLLS_HANDOFF : MAX_POLLS_DEFAULT);

  if (s.status === 'DEPLOYED' || s.status === 'CUTOVER' || s.status === 'FAILED' || s.status === 'ROLLED_BACK') {
    return s;
  }

  // Every step re-verifies rather than trusting state carried between calls: the run
  // may resume in a different container, minutes later, after an expiry.
  // `exp` only bounds authority to START spending. Once a server exists the run window
  // (enforced by the gateway, measured from the purchase) governs instead.
  const verified = verifyMandate(ctx.mandateToken, {
    publicKey: ctx.publicKey,
    now: now(),
    // A parked handoff run checks expiry itself, AFTER reading the registration, so a
    // server registered just before `exp` is not lost to a poll that lands just after.
    allowExpired: Boolean(s.artifacts.server_id) || s.step === 'P2H_AWAIT_PURCHASE',
  });
  if (!verified.ok) return fail(s, `${verified.code}: ${verified.reason}`);
  const m: Mandate = verified.mandate;
  s.mandate_id = m.mandate_id;

  const key = (step: string) => `${m.mandate_id}:${step}`;
  const ledgerRow = (step: string) => ({
    run_id: s.run_id,
    mandate_id: m.mandate_id,
    nonce: m.nonce,
    step,
    key: key(step),
  });

  try {
    switch (s.step) {
      case 'P0_MANDATE': {
        say(s, `verified mandate ${m.mandate_id}, exp ${m.exp}, cap $${m.budget.max_monthly_usd}/mo`);
        s.step = 'P1_PREFLIGHT';
        return s;
      }

      case 'P1_PREFLIGHT': {
        const spent = await nonceSpent(ctx.ledger, m.nonce);
        if (spent && spent.run_id !== s.run_id) {
          return fail(s, `REPLAY: nonce ${m.nonce} already spent by ${spent.run_id} at ${spent.ts}`);
        }
        say(s, 'ledger clean, no prior run for this nonce');
        if (m.provision.provider === 'handoff') {
          // No price scrape and no purchase: a human buys, so nothing here can be budgeted.
          s.lane = 'handoff';
          const c = await claim(ctx.ledger, ledgerRow('P2H'));
          if (c.ok) await settle(ctx.ledger, ledgerRow('P2H'), 'COMMITTED');
          say(s, `handoff lane: a human buys ${m.provision.plan} at ${m.provision.vendor}; expected $${m.provision.expected_monthly_usd}/mo (unverified)`);
          s.step = 'P2H_AWAIT_PURCHASE';
          return s;
        }
        s.lane = 'automated';
        s.step = ctx.providers.pricing ? 'P1B_PRICE_SUBMIT' : 'P2_PROVISION';
        return s;

      }

      case 'P2H_AWAIT_PURCHASE': {
        if (m.provision.provider !== 'handoff') return fail(s, 'WRONG_PROVIDER: P2H_AWAIT_PURCHASE needs a handoff mandate');
        let st;
        try {
          st = await ctx.providers.handoff.status();
        } catch (e) {
          // A blip while parked must not end the run.
          if (!isTransient(e)) throw e;
          say(s, `WARN status check error (${(e as Error).message}); will poll again`);
          s.status = 'AWAITING_HUMAN_PURCHASE';
          return s;
        }
        if (!st.registered || !st.ip || !st.server_id) {
          if (now().getTime() > Date.parse(m.exp)) {
            return fail(s, `EXPIRED: mandate expired at ${m.exp} before a server was registered; nothing was bought`);
          }
          if (s.status !== 'AWAITING_HUMAN_PURCHASE') {
            say(s, `AWAITING_HUMAN_PURCHASE until ${m.exp}: buy the server, then register its IP`);
          }
          s.status = 'AWAITING_HUMAN_PURCHASE';
          s.next_owner = `human: buy ${m.provision.plan} at ${m.provision.vendor}, then register its IP`;
          return s;
        }
        s.artifacts.server_id = st.server_id;
        s.artifacts.ip = st.ip;
        s.cost_committed_usd = 0; // Pilot spent nothing; the human pays
        s.polls = 0;
        s.status = 'RUNNING';
        s.next_owner = 'Pilot';
        say(s, `server registered by the operator: ${st.server_id}`);
        s.step = 'P3_BOOT';
        return s;
      }

      case 'P1B_PRICE_SUBMIT': {
        if (m.provision.provider !== 'hetzner') return fail(s, 'WRONG_PROVIDER: price scrape applies to hetzner mandates only');
        const d = authorize(m, 'anakin:scrape.submit', { url: PRICE_SOURCE_URL });
        if (!d.allow) return fail(s, `${d.code}: ${d.reason}`);
        try {
          const { job_id } = await ctx.providers.pricing!.submit(PRICE_SOURCE_URL);
          s.artifacts.price_job_id = job_id;
          s.polls = 0;
          say(s, `price scrape ${job_id} submitted`);
          s.step = 'P1C_PRICE_POLL';
          return s;
        } catch (e) {
          return priceUnavailable(s, m, ctx, `submit failed: ${(e as Error).message}`);
        }
      }

      case 'P1C_PRICE_POLL': {
        const limit = ctx.maxPricePolls ?? 30;
        let job;
        try {
          job = await ctx.providers.pricing!.poll(s.artifacts.price_job_id!);
        } catch (e) {
          return priceUnavailable(s, m, ctx, `poll failed: ${(e as Error).message}`);
        }
        s.polls++;
        if (job.status === 'completed') {
          if (m.provision.provider !== 'hetzner') return fail(s, 'WRONG_PROVIDER: price scrape applies to hetzner mandates only');
          const pinned = PINNED_PRICES_USD_MONTH[m.provision.server_type];
          if (pinned === undefined) return priceUnavailable(s, m, ctx, `no pinned price for ${m.provision.server_type}`);
          const check = assessPrice(m.provision.server_type, pinned, job.markdown ?? null);
          s.pricing = check;
          say(s, `price ${check.verdict}: ${check.reason}`);
          if (check.evidence) say(s, `  row: ${check.evidence}`);
          if (check.verdict === 'UNVERIFIED' && ctx.requirePriceCheck) {
            return fail(s, `PRICE_UNVERIFIED: ${check.reason}`);
          }
          s.polls = 0;
          s.status = 'RUNNING';
          s.step = 'P2_PROVISION';
          return s;
        }
        if (job.status === 'failed') return priceUnavailable(s, m, ctx, `scrape failed: ${job.error ?? 'unknown'}`);
        if (s.polls >= limit) return priceUnavailable(s, m, ctx, 'scrape timed out');
        s.status = 'WAITING';
        say(s, `scraping ${job.status}, poll ${s.polls}/${limit}`);
        return s;
      }

      case 'P2_PROVISION': {
        const prov = m.provision;
        // A handoff run never buys, whatever a hijacked caller proposes.
        if (prov.provider !== 'hetzner') return fail(s, 'WRONG_PROVIDER: this mandate authorises a human purchase, not hetzner:server.create');
        const fromMandate: ProvisionArgs = {
          server_type: prov.server_type,
          image: prov.image,
          location: prov.location,
          count: prov.count,
          cloud_init_sha256: prov.cloud_init_sha256,
        };
        const args = ctx.proposeArgs ? ctx.proposeArgs('P2_PROVISION', fromMandate) : fromMandate;

        // The scrape can only raise the price we budget against, never lower it.
        const priceTable = s.pricing
          ? { ...PINNED_PRICES_USD_MONTH, [prov.server_type]: s.pricing.effective_usd }
          : undefined;
        const decision = authorize(m, 'hetzner:server.create', { ...args }, { priceTable });
        if (!decision.allow) return fail(s, `${decision.code}: ${decision.reason}`);

        // Write-ahead: the claim lands before any money moves.
        const c = await claim(ctx.ledger, ledgerRow('P2'));
        if (!c.ok) return fail(s, `${c.code}: ${c.reason}`);

        try {
          const res = await ctx.providers.hetzner.createServer(args);
          await settle(ctx.ledger, ledgerRow('P2'), 'COMMITTED');
          s.artifacts.server_id = res.server_id;
          s.artifacts.ip = res.ip;
          s.cost_committed_usd = decision.estimated_monthly_usd;
          say(s, `bought ${args.server_type}/${args.location} -> ${res.server_id} @ $${decision.estimated_monthly_usd}/mo`);
          s.step = 'P3_BOOT';
          return s;
        } catch (e) {
          // If the outcome is unknown the purchase may have happened. Leave the INTENT row
          // open so nothing retries blindly; the gateway reconciles against the provider.
          if (e instanceof ToolRefusal && e.ambiguous) {
            return fail(s, `provision outcome unknown (${e.code}); not retrying. ${e.message}`);
          }
          await settle(ctx.ledger, ledgerRow('P2'), 'FAILED');
          return fail(s, `provision failed: ${(e as Error).message}`);
        }
      }

      case 'P3_BOOT': {
        let ready = false;
        try {
          ready = await ctx.providers.coolify.health(s.artifacts.ip!);
        } catch (e) {
          // A blip while polling must not destroy a healthy, paid-for server.
          if (!isTransient(e)) throw e;
          say(s, `WARN health check error (${(e as Error).message}); will poll again`);
        }
        s.polls++;
        if (ready) {
          say(s, `coolify healthy after ${s.polls} poll(s)`);
          s.polls = 0;
          s.step = 'P4_PROJECT';
          return s;
        }
        if (s.polls >= maxPolls) return await rollback(s, ctx, 'coolify never became healthy', m);
        s.status = 'WAITING';
        say(s, `booting, poll ${s.polls}/${maxPolls}`);
        return s;
      }

      case 'P4_PROJECT': {
        s.status = 'RUNNING';
        const proj = await ctx.providers.coolify.createProject(s.artifacts.ip!, m.migration.vercel_project_id);
        const app = await ctx.providers.coolify.createApplication(s.artifacts.ip!, {
          project_uuid: proj.project_uuid,
          git_repository: m.migration.git_repository,
          git_branch: m.migration.git_branch,
          build_pack: 'nixpacks',
        });
        s.artifacts.project_uuid = proj.project_uuid;
        s.artifacts.app_uuid = app.app_uuid;
        say(s, `project ${proj.project_uuid}, app ${app.app_uuid}`);
        s.polls = 0;
        s.step = 'P5_ENVS';
        return s;
      }

      case 'P5_ENVS': {
        const exported = await ctx.providers.vercel.exportEnvs(m.migration.vercel_project_id);
        const loaded = await ctx.providers.coolify.bulkEnvs(
          s.artifacts.ip!,
          s.artifacts.app_uuid!,
          exported.sealed_ref,
        );
        s.artifacts.sealed_ref = exported.sealed_ref;
        // Count is loggable, and so are the NAMES of vars we could not move: a migration that
        // silently drops STRIPE_SECRET_KEY yields an app that boots and fails at runtime.
        say(s, `moved ${loaded.count} env vars as ${exported.sealed_ref} (values never read)`);
        if (exported.skipped?.length) {
          s.env_skipped = exported.skipped;
          say(s, `WARN ${exported.skipped.length} var(s) NOT moved, re-enter by hand: ${exported.skipped.join(', ')}`);
        }
        if (exported.truncated) say(s, 'WARN Vercel reported more env pages than were read; the export may be incomplete');
        s.polls = 0;
        s.step = 'P6_DEPLOY';
        return s;
      }

      case 'P6_DEPLOY': {
        // No agent-side claim here: deploy costs nothing, and the gateway records the result
        // write-ahead, so a retry returns the same deployment instead of starting another.
        const dep = await ctx.providers.coolify.deploy(s.artifacts.ip!, s.artifacts.app_uuid!);
        s.artifacts.deployment_uuid = dep.deployment_uuid;
        say(s, `deployment ${dep.deployment_uuid} queued`);
        s.polls = 0;
        s.step = 'P7_VERIFY';
        return s;
      }

      case 'P7_VERIFY': {
        let status: Awaited<ReturnType<Providers['coolify']['deploymentStatus']>> = 'running';
        try {
          status = await ctx.providers.coolify.deploymentStatus(s.artifacts.ip!, s.artifacts.deployment_uuid!);
        } catch (e) {
          if (!isTransient(e)) throw e;
          say(s, `WARN status check error (${(e as Error).message}); will poll again`);
        }
        s.polls++;
        if (status === 'success') {
          s.status = 'DEPLOYED';
          s.step = 'DONE';
          s.next_owner = 'Auditor';
          say(s, 'deployment succeeded — halting. DNS untouched until Auditor passes.');
          return s;
        }
        if (status === 'failed') return await rollback(s, ctx, 'deployment failed', m);
        if (s.polls >= maxPolls) return await rollback(s, ctx, 'deployment timed out', m);
        s.status = 'WAITING';
        say(s, `deploying, poll ${s.polls}/${maxPolls}`);
        return s;
      }

      case 'P8_CUTOVER': {
        const decision = authorize(
          m,
          'cloudflare:dns.upsert',
          { name: m.migration.domain },
          { auditorPassToken: ctx.auditorPassToken },
        );
        if (!decision.allow) {
          s.status = decision.code === 'NO_AUDITOR_TOKEN' ? 'NEEDS_APPROVAL' : 'FAILED';
          s.error = `${decision.code}: ${decision.reason}`;
          say(s, `refused — ${decision.reason}`);
          return s;
        }
        try {
          const rec = await ctx.providers.cloudflare.upsert(m.migration.domain, s.artifacts.ip!);
          s.artifacts.dns_record_id = rec.record_id;
          s.status = 'CUTOVER';
          s.step = 'DONE';
          s.next_owner = 'operator';
          say(s, `${m.migration.domain} -> ${s.artifacts.ip} (${rec.record_id})`);
          return s;
        } catch (e) {
          // The deployed server is healthy and DNS is untouched. Never destroy it because
          // the last, optional step could not complete: stop and hand back to a human.
          if (e instanceof McpError && e.needsApproval) {
            s.status = 'NEEDS_APPROVAL';
            s.error = 'cutover is waiting for human approval in Nasiko (-32001)';
            say(s, 'cutover awaiting human approval; DNS untouched');
            return s;
          }
          s.status = 'FAILED';
          s.error = `cutover failed: ${(e as Error).message}`;
          s.step = 'P8_CUTOVER';
          s.next_owner = 'operator';
          say(s, `cutover failed, server left running and DNS untouched: ${(e as Error).message}`);
          return s;
        }
      }

      default:
        return s;
    }
  } catch (e) {
    // The setup steps are idempotent at the gateway, so a transient failure (network,
    // provider 5xx) is retried a few times before we give up and clean up.
    if (RETRYABLE_STEPS.includes(s.step) && isTransient(e) && s.polls < MAX_STEP_RETRIES) {
      s.polls++;
      s.status = 'WAITING';
      say(s, `WARN transient error (${(e as Error).message}); retry ${s.polls}/${MAX_STEP_RETRIES}`);
      return s;
    }
    return await rollback(s, ctx, (e as Error).message, m);
  }
}

const RETRYABLE_STEPS: Step[] = ['P4_PROJECT', 'P5_ENVS', 'P6_DEPLOY'];
const MAX_STEP_RETRIES = 3;

/**
 * Errors worth retrying: network/timeouts/parse failures, and a gateway report that the
 * provider's outcome was unknown. A ToolRefusal (bad mandate, substitution, expired
 * window...) is a decision, not a glitch, and is never retried.
 */
function isTransient(e: unknown): boolean {
  if (e instanceof ToolRefusal) return e.code === 'PROVIDER_AMBIGUOUS';
  if (e instanceof McpError) return !e.blocked && !e.needsApproval;
  return true;
}

/** Anakin is advisory: outage is a warning unless the operator required the check. */
function priceUnavailable(s: RunState, m: Mandate, ctx: RunContext, reason: string): RunState {
  s.status = 'RUNNING';
  if (m.provision.provider !== 'hetzner') return fail(s, 'WRONG_PROVIDER: price scrape applies to hetzner mandates only');
  const pinned = PINNED_PRICES_USD_MONTH[m.provision.server_type];
  if (ctx.requirePriceCheck || pinned === undefined) {
    return fail(s, `PRICE_UNVERIFIED: ${reason}`);
  }
  s.pricing = { verdict: 'UNVERIFIED', pinned_usd: pinned, effective_usd: pinned, reason };
  say(s, `WARN price cross-check unavailable (${reason}); budgeting against pinned $${pinned}`);
  s.polls = 0;
  s.step = 'P2_PROVISION';
  return s;
}

/**
 * Destroys anything bought under this run, then reports. Never touches DNS.
 *
 * A handoff run destroys NOTHING: Pilot did not buy the server, and deleting a human's
 * purchase is not ours to do. It reverts DNS if it changed any, stops, and tells the
 * operator to cancel the server at the vendor.
 */
async function rollback(s: RunState, ctx: RunContext, reason: string, m: Mandate): Promise<RunState> {
  if (m.provision.provider === 'handoff') {
    say(s, `stopping: ${reason}`);
    try {
      if (s.artifacts.dns_record_id) {
        await ctx.providers.cloudflare.rollback(s.artifacts.dns_record_id);
        say(s, 'dns reverted');
      }
      s.status = 'FAILED';
      s.error = reason;
      s.cost_committed_usd = 0;
      s.next_owner = `operator: cancel the server at ${m.provision.vendor}`;
    } catch (e) {
      s.status = 'FAILED';
      s.error = `${reason}; dns revert also failed: ${(e as Error).message}`;
      s.next_owner = `operator — MANUAL CLEANUP REQUIRED (dns, and cancel the server at ${m.provision.vendor})`;
      say(s, s.error);
    }
    return s;
  }
  say(s, `rolling back: ${reason}`);
  try {
    if (s.artifacts.dns_record_id) {
      await ctx.providers.cloudflare.rollback(s.artifacts.dns_record_id);
      say(s, 'dns reverted');
    }
    if (s.artifacts.server_id) {
      await ctx.providers.hetzner.deleteServer(s.artifacts.server_id);
      say(s, `destroyed ${s.artifacts.server_id}`);
      s.cost_committed_usd = 0;
    }
    s.status = 'ROLLED_BACK';
    s.error = reason;
    s.next_owner = 'operator';
  } catch (e) {
    s.status = 'FAILED';
    s.error = `${reason}; rollback also failed: ${(e as Error).message}`;
    s.next_owner = 'operator — MANUAL CLEANUP REQUIRED';
    say(s, s.error);
  }
  return s;
}

/** Drives a run to a terminal state. Each iteration is one short, resumable call. */
export async function run(state: RunState, ctx: RunContext, maxSteps = 60): Promise<RunState> {
  let s = state;
  for (let i = 0; i < maxSteps; i++) {
    const before = `${s.step}:${s.polls}`;
    s = await advance(s, ctx);
    const terminal = ['DEPLOYED', 'CUTOVER', 'FAILED', 'ROLLED_BACK', 'NEEDS_APPROVAL', 'AWAITING_HUMAN_PURCHASE'];
    if (terminal.includes(s.status)) return s;
    if (`${s.step}:${s.polls}` === before) return s;
  }
  return s;
}

export { PINNED_PRICES_USD_MONTH };
