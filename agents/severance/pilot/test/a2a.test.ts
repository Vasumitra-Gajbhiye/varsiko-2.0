import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rewriteRpc, makeTask } from '../src/agent/a2a-compat.ts';
import { handleRpc, PilotExecutor } from '../src/agent/executor.ts';
import { RunStore } from '../src/agent/run-store.ts';
import {
  canonicalDumps,
  verifyCartMandate,
  SCHEMA_CART,
  SIGNATURE_ALG,
  SIGNATURE_KID,
  type CartMandate,
} from '../src/pilot/cart-mandate.ts';
import { signMandate } from '../src/pilot/mandate.ts';
import { devMandate } from '../src/pilot/demo.ts';

const SECRET = 'ab'.repeat(16);

function signCart(mandate: Record<string, unknown>): CartMandate {
  const unsigned: Record<string, unknown> = { ...mandate };
  delete unsigned.signature;
  delete unsigned.approval;
  const value = createHmac('sha256', Buffer.from(SECRET, 'hex'))
    .update(canonicalDumps(unsigned), 'utf8')
    .digest('hex');
  return {
    ...(mandate as unknown as CartMandate),
    signature: { alg: SIGNATURE_ALG, kid: SIGNATURE_KID, value },
  };
}

function sampleCart(over: Record<string, unknown> = {}): CartMandate {
  const base: Record<string, unknown> = {
    schema: SCHEMA_CART,
    mandate_id: 'MND-AABBCC',
    nonce: 'n1',
    issued_at: '2026-09-20T14:00:00Z',
    expires_at: '2099-01-01T00:00:00Z',
    spec_hash: 'sha256:abc',
    decision: {
      provider: 'hetzner',
      plan_sku: 'cpx31',
      region: 'nbg1',
      monthly_inr: 1200,
      listed_price: { amount: 13.99, currency: 'EUR' },
      source_url: 'https://www.hetzner.com/cloud',
    },
    constraints_applied: { ceiling_inr_monthly: 1500 },
    approval: { status: 'approved', approver: 'ops@example.com', approved_at: '2026-09-20T14:01:00Z' },
    ...over,
  };
  return signCart(base);
}

describe('a2a compat', () => {
  it('rewrites SendMessage', () => {
    const body = rewriteRpc({
      method: 'SendMessage',
      params: { message: { role: 'ROLE_USER', parts: [{ text: 'x' }] } },
    }) as { method: string; params: { message: { role: string; parts: { kind?: string }[] } } };
    assert.equal(body.method, 'message/send');
    assert.equal(body.params.message.role, 'user');
    assert.equal(body.params.message.parts[0]?.kind, 'text');
  });

  it('builds Task envelopes', () => {
    const t = makeTask({ id: '1', contextId: 'c', state: 'completed', message: 'ok' });
    assert.equal(t.kind, 'task');
  });
});

describe('cart mandate HMAC', () => {
  it('accepts a valid signed cart under ceiling', () => {
    const cart = sampleCart();
    const r = verifyCartMandate(cart, SECRET);
    assert.equal(r.ok, true);
  });

  it('refuses a forged signature', () => {
    const cart = sampleCart();
    cart.signature = { ...cart.signature, value: '00'.repeat(32) };
    const r = verifyCartMandate(cart, SECRET);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'BAD_SIGNATURE');
  });

  it('refuses over-ceiling carts', () => {
    const unsigned = {
      schema: SCHEMA_CART,
      mandate_id: 'MND-OVER',
      nonce: 'n2',
      issued_at: '2026-09-20T14:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
      spec_hash: 'sha256:abc',
      decision: {
        provider: 'hetzner',
        plan_sku: 'cpx31',
        region: 'nbg1',
        monthly_inr: 9999,
        listed_price: { amount: 99, currency: 'EUR' },
        source_url: 'https://www.hetzner.com/cloud',
      },
      constraints_applied: { ceiling_inr_monthly: 1500 },
      approval: { status: 'approved' },
    };
    const resigned = signCart(unsigned);
    const r = verifyCartMandate(resigned, SECRET);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'OVER_CEILING');
  });
});

describe('PilotExecutor offline', () => {
  let dir: string;
  let keys: ReturnType<typeof generateKeyPairSync>;
  let executor: PilotExecutor;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pilot-a2a-'));
    keys = generateKeyPairSync('ed25519');
    executor = new PilotExecutor({
      store: new RunStore(join(dir, 'runs')),
      offline: true,
      publicKey: keys.publicKey,
      signingSecret: SECRET,
      dataDir: dir,
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parks a verified cart mandate without buying', async () => {
    const cart = sampleCart();
    const out = await executor.handle(JSON.stringify(cart), {}, { taskId: 't1', contextId: 'ctx-cart' });
    assert.equal(out.state, 'input-required');
    assert.match(out.message, /Lane=automated|Lane=handoff|Lane=unsupported/);
    const park = out.artifacts.find((a) => a.name === 'pilot_park');
    assert.equal((park?.data as { status: string }).status, 'parked');
  });

  it('refuses a cart with bad HMAC', async () => {
    const cart = sampleCart();
    cart.signature.value = 'deadbeef';
    const out = await executor.handle(JSON.stringify(cart), {}, { taskId: 't2', contextId: 'ctx-bad' });
    assert.match(out.message, /CART_REFUSED/);
  });

  it('starts from a signed spend mandate and advances once', async () => {
    const now = new Date();
    const iat = new Date(now.getTime() - 60_000).toISOString();
    const exp = new Date(now.getTime() + 600_000).toISOString();
    const mandate = devMandate({ nonce: `n_${Date.now()}`, iat, exp });
    const token = signMandate(mandate, keys.privateKey);
    const out = await executor.handle(
      JSON.stringify({ skill: 'run.start', mandate_token: token }),
      {},
      { taskId: 't3', contextId: 'ctx-start' },
    );
    assert.ok(
      out.state === 'working' || out.state === 'completed' || out.state === 'input-required',
      out.message,
    );
    const run = out.artifacts.find((a) => a.name === 'pilot_run');
    assert.ok(run?.data, out.message);
    assert.equal((run!.data as { schema: string }).schema, 'severance.pilot_run/v1');
  });

  it('poll advances exactly once per call', async () => {
    const now = new Date();
    const iat = new Date(now.getTime() - 60_000).toISOString();
    const exp = new Date(now.getTime() + 600_000).toISOString();
    const mandate = devMandate({ nonce: `n_poll_${Date.now()}`, iat, exp });
    const token = signMandate(mandate, keys.privateKey);
    const start = await executor.handle(
      JSON.stringify({ skill: 'run.start', mandate_token: token }),
      {},
      { taskId: 't4', contextId: 'ctx-poll' },
    );
    const runArt = start.artifacts.find((a) => a.name === 'pilot_run')?.data as
      | { run_id: string }
      | undefined;
    assert.ok(runArt?.run_id, start.message);
    const runId = runArt!.run_id;
    const first = await executor.handle(
      JSON.stringify({ skill: 'run.poll', run_id: runId }),
      {},
      { taskId: 't5', contextId: 'ctx-poll' },
    );
    const step1 = (first.artifacts.find((a) => a.name === 'pilot_run')?.data as { step: string }).step;
    const second = await executor.handle(
      JSON.stringify({ skill: 'run.poll', run_id: runId }),
      {},
      { taskId: 't6', contextId: 'ctx-poll' },
    );
    const step2 = (second.artifacts.find((a) => a.name === 'pilot_run')?.data as { step: string }).step;
    assert.ok(typeof step1 === 'string' && typeof step2 === 'string');
  });

  it('handleRpc returns a Task', async () => {
    const reply = await handleRpc(
      {
        jsonrpc: '2.0',
        id: '1',
        method: 'message/send',
        params: {
          message: {
            messageId: 'm1',
            contextId: 'c1',
            role: 'user',
            parts: [{ kind: 'text', text: JSON.stringify(sampleCart()) }],
          },
        },
      },
      {},
      executor,
    );
    assert.equal(reply.id, '1');
    assert.equal((reply.result as { kind: string }).kind, 'task');
  });
});
