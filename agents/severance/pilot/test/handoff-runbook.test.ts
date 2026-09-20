import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { MemoryLedger } from '../src/pilot/ledger.ts';
import { signMandate, type Mandate } from '../src/pilot/mandate.ts';
import { FakeProviders, McpError, type FakeOptions } from '../src/pilot/providers.ts';
import { advance, newRun, run, type RunContext, type RunState } from '../src/pilot/runbook.ts';
import { SERVER_IP } from './helpers/fake-internet.ts';
import { handoffMandate } from './helpers/handoff.ts';
import { withHarness } from './helpers/harness.ts';

const keys = generateKeyPairSync('ed25519');
const NOW = new Date('2026-09-20T15:00:00Z');

function rig(o: { fake?: FakeOptions; mandate?: Mandate; now?: () => Date; ctx?: Partial<RunContext> } = {}) {
  const providers = new FakeProviders(o.fake);
  const mandate = o.mandate ?? handoffMandate();
  const ctx: RunContext = {
    mandateToken: signMandate(mandate, keys.privateKey),
    publicKey: keys.publicKey,
    providers,
    ledger: new MemoryLedger(),
    now: o.now ?? (() => NOW),
    ...o.ctx,
  };
  return { providers, mandate, ctx };
}
const tools = (p: FakeProviders) => p.calls.map((c) => c.tool);
const dump = (s: RunState) => `${s.status} ${s.error ?? ''}\n${s.log.join('\n')}`;

describe('handoff runbook (fakes)', () => {
  it('parks at AWAITING_HUMAN_PURCHASE having bought nothing and scraped nothing', async () => {
    const { providers, ctx } = rig({ fake: { neverRegister: true } });
    const s = await run(newRun('run_1'), ctx);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE', dump(s));
    assert.equal(s.step, 'P2H_AWAIT_PURCHASE');
    assert.equal(s.lane, 'handoff');
    assert.equal(s.cost_committed_usd, 0);
    assert.match(s.next_owner, /^human: buy cloud-vps-10 at contabo/);
    assert.ok(tools(providers).every((t) => t === 'handoff__status'), tools(providers).join());
  });

  it('a parked run polls again on the next advance (does not spin, does not stall)', async () => {
    const { providers, ctx } = rig({ fake: { neverRegister: true } });
    let s = await run(newRun('run_1'), ctx);
    const calls = tools(providers).length;
    s = await advance(s, ctx);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE');
    assert.equal(tools(providers).length, calls + 1);
    assert.equal(s.log.filter((l) => l.includes('AWAITING_HUMAN_PURCHASE')).length, 1, 'logged once, not on every poll');
  });

  it('resumes after registration and reaches DEPLOYED with next_owner Auditor, buying nothing', async () => {
    const { providers, ctx } = rig({ fake: { neverRegister: true } });
    let s = await run(newRun('run_1'), ctx);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE');
    providers.registerNow(SERVER_IP);
    s = await run(s, ctx, 60);
    assert.equal(s.status, 'DEPLOYED', dump(s));
    assert.equal(s.next_owner, 'Auditor');
    assert.equal(s.cost_committed_usd, 0);
    assert.equal(s.artifacts.ip, SERVER_IP);
    assert.equal(s.artifacts.server_id, `handoff:${SERVER_IP}`);
    assert.ok(!tools(providers).some((t) => t.startsWith('hetzner__') || t.startsWith('anakin__') || t === 'cloudflare__dns_upsert'));
  });

  it('registers on its own after a few polls when the operator is quick', async () => {
    const { ctx } = rig({ fake: { registerAfterPolls: 3 } });
    const s = await run(newRun('run_1'), ctx, 100);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE');
    const done = await run(await advance(await advance(s, ctx), ctx), ctx, 100);
    assert.equal(done.status, 'DEPLOYED', dump(done));
  });

  it('fails without destroying anything when boot never turns healthy', async () => {
    const { providers, ctx } = rig({ fake: { failAt: 'boot' }, ctx: { maxPolls: 3 } });
    providers.registerNow();
    const s = await run(newRun('run_1'), ctx, 100);
    assert.equal(s.status, 'FAILED', dump(s));
    assert.match(s.error!, /never became healthy/);
    assert.equal(s.cost_committed_usd, 0);
    assert.equal(s.next_owner, 'operator: cancel the server at contabo');
    assert.ok(!tools(providers).includes('hetzner__server_delete'), 'a human-bought server is never deleted');
  });

  it('fails without destroying anything when the deploy fails, and reverts DNS only if it had changed it', async () => {
    const { providers, ctx } = rig({ fake: { failAt: 'deploy' } });
    providers.registerNow();
    const s = await run(newRun('run_1'), ctx, 100);
    assert.equal(s.status, 'FAILED');
    assert.match(s.next_owner, /cancel the server at contabo/);
    assert.ok(!tools(providers).includes('hetzner__server_delete'));
    assert.ok(!tools(providers).includes('cloudflare__dns_rollback'), 'no DNS was written, so none is reverted');

    // A run that already cut over and then fails still reverts DNS.
    const b = rig({ fake: { deployPolls: 1 } });
    b.providers.registerNow();
    let d = await run(newRun('run_2'), b.ctx, 100);
    assert.equal(d.status, 'DEPLOYED');
    d = { ...d, status: 'RUNNING', step: 'P7_VERIFY', artifacts: { ...d.artifacts, dns_record_id: 'rec_f001' } };
    const failing = new FakeProviders({ failAt: 'deploy' });
    failing.registerNow();
    const s2 = await run(d, { ...b.ctx, providers: failing }, 100);
    assert.equal(s2.status, 'FAILED');
    assert.ok(tools(failing).includes('cloudflare__dns_rollback'));
    assert.ok(!tools(failing).includes('hetzner__server_delete'));
  });

  it('expires cleanly when the human never registers: nothing bought, nothing to clean up', async () => {
    let t = NOW;
    const { providers, ctx } = rig({ fake: { neverRegister: true }, now: () => t });
    let s = await run(newRun('run_1'), ctx);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE');
    t = new Date('2026-09-21T15:00:00Z'); // past exp
    s = await advance(s, ctx);
    assert.equal(s.status, 'FAILED');
    assert.match(s.error!, /^EXPIRED/);
    assert.match(s.error!, /nothing was bought/);
    assert.ok(tools(providers).every((x) => x === 'handoff__status'));
  });

  it('honours a registration made just before `exp` even if the poll lands just after', async () => {
    let t = NOW;
    const { providers, ctx } = rig({ fake: { neverRegister: true }, now: () => t });
    let s = await run(newRun('run_1'), ctx);
    providers.registerNow();
    t = new Date('2026-09-21T15:00:00Z'); // the poll arrives after exp
    s = await advance(s, ctx);
    assert.equal(s.step, 'P3_BOOT', dump(s));
  });

  it('a status blip while parked does not end the run', async () => {
    const { providers, ctx } = rig({ fake: { neverRegister: true } });
    let s = await run(newRun('run_1'), ctx);
    providers.handoff.status = async () => {
      throw new McpError(-32603, 'gateway hiccup');
    };
    s = await advance(s, ctx);
    assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE', dump(s));
    assert.match(s.log.join('\n'), /WARN status check error/);
  });

  it('a hijacked proposeArgs cannot make a handoff run buy a Hetzner server', async () => {
    const { providers, ctx } = rig({
      fake: { registerAfterPolls: 1 },
      ctx: { proposeArgs: (_s, fm) => ({ ...fm, server_type: 'cpx51', count: 50, cloud_init_sha256: 'deadbeef' }) },
    });
    const s = await run(newRun('run_1'), ctx, 100);
    assert.equal(s.status, 'DEPLOYED', dump(s));
    assert.ok(!tools(providers).includes('hetzner__server_create'));
    // And forcing the buy step directly is refused, not executed.
    const forced = await advance({ ...newRun('run_2'), step: 'P2_PROVISION' }, ctx);
    assert.equal(forced.status, 'FAILED');
    assert.match(forced.error!, /^WRONG_PROVIDER/);
    assert.ok(!tools(providers).includes('hetzner__server_create'));
  });

  it('refuses a second run for the same mandate (REPLAY)', async () => {
    const { ctx } = rig({ fake: { neverRegister: true } });
    await run(newRun('run_1'), ctx);
    const second = await run(newRun('run_2'), ctx);
    assert.equal(second.status, 'FAILED');
    assert.match(second.error!, /^REPLAY/);
  });

  it('gives a handoff box more boot patience than an automated one', async () => {
    const { providers, ctx } = rig({ fake: { bootPolls: 30 } });
    providers.registerNow();
    const s = await run(newRun('run_1'), ctx, 200);
    assert.equal(s.status, 'DEPLOYED', dump(s)); // 30 polls > the automated default of 20
  });
});

describe('handoff run, end to end (real runbook -> Nasiko -> gateway -> fake internet)', () => {
  it('parks, waits for the operator, then deploys: zero servers bought, zero DNS writes, no secret seen by the agent', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token } = h.issueHandoff();
      const ctx = h.pilot(token, 'run_1');

      let s = await run(newRun('run_1'), ctx);
      assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE', dump(s));
      assert.equal(h.net.requests.filter((r) => r.host === 'api.hetzner.cloud' || r.host === 'api.anakin.io').length, 0);

      // The operator: prepare, the human buys and boots, the operator registers.
      const prep = await h.direct('operator', 'handoff_prepare', { mandate: token });
      const cloudInit = prep.data.cloud_init as string;
      h.net.humanBuys(cloudInit);
      const reg = await h.direct('operator', 'handoff_register', { mandate: token, run_id: 'run_1', ip: SERVER_IP, port_8000_restricted: true });
      assert.equal(reg.isError, false, reg.raw);

      s = await run(s, ctx, 300);
      assert.equal(s.status, 'DEPLOYED', dump(s));
      assert.equal(s.next_owner, 'Auditor');
      assert.equal(s.artifacts.ip, SERVER_IP);
      assert.equal(h.net.requests.filter((r) => r.method === 'POST' && r.path === '/v1/servers').length, 0, 'servers_bought=0');
      assert.equal(h.net.dns.size, 0, 'dns_writes=0');
      assert.equal(h.net.appBodies[0]?.git_repository, mandate.migration.git_repository);

      const secrets = (await h.deps.vault.get<{ api_token: string; root_password: string }>('coolify', `coolify:${mandate.mandate_id}`))!;
      const seenByAgent = h.nasiko.traffic.join('\n') + JSON.stringify(s) + s.log.join('\n');
      for (const secret of [secrets.api_token, secrets.root_password, 'forceFill', 's3cr3t-db-pass', 'o'.repeat(40)]) {
        assert.ok(!seenByAgent.includes(secret), `the agent saw: ${secret.slice(0, 6)}...`);
      }
      const auditText = JSON.stringify(h.audit);
      for (const secret of [secrets.api_token, secrets.root_password, 'forceFill', token]) assert.ok(!auditText.includes(secret), 'audit log leaked');
    });
  });

  it('stays parked when the operator registers a private address, and never talks to it', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issueHandoff();
      const ctx = h.pilot(token, 'run_1');
      await h.direct('operator', 'handoff_prepare', { mandate: token });
      let s = await run(newRun('run_1'), ctx);
      const reg = await h.direct('operator', 'handoff_register', { mandate: token, run_id: 'run_1', ip: '169.254.169.254', port_8000_restricted: true });
      assert.equal(reg.error, 'BAD_IP');
      s = await advance(s, ctx);
      assert.equal(s.status, 'AWAITING_HUMAN_PURCHASE');
      assert.equal(h.net.requests.filter((r) => r.host.startsWith('169.254')).length, 0);
    });
  });

  it('expires with FAILED (EXPIRED) if the human never registers', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issueHandoff();
      const ctx = h.pilot(token, 'run_1');
      let s = await run(newRun('run_1'), ctx);
      h.clock.t = new Date('2026-09-22T00:00:00Z');
      s = await advance(s, ctx);
      assert.equal(s.status, 'FAILED');
      assert.match(s.error!, /^EXPIRED/);
    });
  });
});
