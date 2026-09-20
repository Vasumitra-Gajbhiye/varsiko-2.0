import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { devKeys, devMandate, SCENARIOS } from '../src/pilot/demo.ts';
import { MemoryLedger } from '../src/pilot/ledger.ts';
import { signMandate } from '../src/pilot/mandate.ts';
import { FakeProviders, McpError, NasikoGateway } from '../src/pilot/providers.ts';
import { advance, newRun, run } from '../src/pilot/runbook.ts';

const keys = devKeys();
const NOW = () => new Date('2026-09-20T15:00:00Z');

describe('demo scenarios (each is a rubric claim)', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.id}: ${sc.proves}`, async () => {
      const { state, providers, expect } = await sc.run(keys);
      assert.equal(expect(state, providers), null);
    });
  }
});

describe('runbook mechanics', () => {
  const ctx = () => ({
    mandateToken: signMandate(devMandate(), keys.privateKey),
    publicKey: keys.publicKey,
    providers: new FakeProviders({ bootPolls: 3 }),
    ledger: new MemoryLedger(),
    now: NOW,
  });

  const purchases = (c: ReturnType<typeof ctx>) =>
    c.providers.calls.filter((x) => x.tool === 'hetzner__server_create').length;

  it('advances one step per call and buys nothing until the price check settles', async () => {
    const c = ctx();
    let s = newRun('run_x');
    const seen: string[] = [];
    while (s.step !== 'P3_BOOT' && seen.length < 20) {
      s = await advance(s, c);
      seen.push(s.step);
      if (s.step !== 'P2_PROVISION' && s.step !== 'P3_BOOT') assert.equal(purchases(c), 0);
    }
    assert.deepEqual(seen.slice(0, 3), ['P1_PREFLIGHT', 'P1B_PRICE_SUBMIT', 'P1C_PRICE_POLL']);
    assert.ok(seen.filter((x) => x === 'P1C_PRICE_POLL').length >= 2, 'scrape should take multiple polls');
    assert.equal(purchases(c), 1);
  });

  it('reports WAITING while polling so a caller can resume later', async () => {
    const c = ctx();
    let s = newRun('run_w');
    const waiting: string[] = [];
    for (let i = 0; i < 12; i++) {
      s = await advance(s, c);
      if (s.status === 'WAITING') waiting.push(s.step);
    }
    assert.ok(waiting.includes('P1C_PRICE_POLL'), 'scrape polling reports WAITING');
    assert.ok(waiting.includes('P3_BOOT'), 'boot polling reports WAITING');
  });

  it('is resumable from a serialized state', async () => {
    const c = ctx();
    let s = newRun('run_r');
    for (let i = 0; i < 4; i++) s = await advance(s, c);
    const revived = JSON.parse(JSON.stringify(s)) as typeof s;
    const finished = await run(revived, c);
    assert.equal(finished.status, 'DEPLOYED');
  });

  it('gives up and rolls back if boot never completes', async () => {
    const c = { ...ctx(), providers: new FakeProviders({ failAt: 'boot' }), maxPolls: 3 };
    const s = await run(newRun('run_b'), c);
    assert.equal(s.status, 'ROLLED_BACK');
    assert.equal(c.providers.live.size, 0);
  });

  it('never logs an environment variable value', async () => {
    const c = ctx();
    const s = await run(newRun('run_e'), c);
    const joined = s.log.join('\n');
    assert.match(joined, /14 env vars/);
    assert.ok(!/sk_live|password|secret=/i.test(joined));
  });

  it('records committed cost only after the purchase settles', async () => {
    const c = ctx();
    let s = newRun('run_c');
    while (s.step !== 'P3_BOOT') {
      assert.equal(s.cost_committed_usd, 0);
      s = await advance(s, c);
    }
    assert.equal(s.cost_committed_usd, 15.5);
  });
});

describe('NasikoGateway', () => {
  const gw = (impl: typeof fetch) => new NasikoGateway({ url: 'https://cp/api/mcp', token: 'tok_x', fetch: impl });

  it('sends the delegation token header and JSON-RPC tools/call', async () => {
    let seen: { headers: Headers; body: Record<string, unknown> } | null = null;
    const g = gw(async (_u, init) => {
      seen = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({ jsonrpc: '2.0', result: { content: [{ text: '{"server_id":"srv_1"}' }] } });
    });
    const out = await g.call<{ server_id: string }>('hetzner__server_create', { server_type: 'cpx31' });
    assert.equal(out.server_id, 'srv_1');
    assert.equal(seen!.headers.get('x-nasiko-agent-token'), 'tok_x');
    assert.equal(seen!.body.method, 'tools/call');
    assert.deepEqual(seen!.body.params, { name: 'hetzner__server_create', arguments: { server_type: 'cpx31' } });
  });

  it('surfaces -32001 as needing human approval', async () => {
    const g = gw(async () => Response.json({ jsonrpc: '2.0', error: { code: -32001, message: 'approval required' } }));
    await assert.rejects(g.call('cloudflare__dns_upsert', {}), (e: McpError) => e.needsApproval && !e.blocked);
  });

  it('surfaces -32000 as blocked by permission rules', async () => {
    const g = gw(async () => Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'blocked' } }));
    await assert.rejects(g.call('shell__exec', {}), (e: McpError) => e.blocked);
  });

  it('keeps the delegation token out of inspect output', () => {
    const g = gw(fetch);
    assert.ok(!inspect(g).includes('tok_x'));
  });
});
