import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import { authorize } from '../src/pilot/guard.ts';
import { claim, MemoryLedger, nonceSpent, settle } from '../src/pilot/ledger.ts';
import { canonicalize, signMandate, verifyMandate, type HetznerMandate, type Mandate } from '../src/pilot/mandate.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const NOW = new Date('2026-09-20T15:00:00Z');

function mandate(over: Partial<HetznerMandate> = {}): HetznerMandate {
  return {
    mandate_id: 'mdt_8891',
    nonce: 'b7f3a1',
    iat: '2026-09-20T14:55:00Z',
    exp: '2026-09-20T15:05:00Z',
    approved_by: 'operator@varsiko.dev',
    scope: ['hetzner:server.create', 'coolify:*', 'cloudflare:dns.upsert'],
    budget: { max_monthly_usd: 60, max_hourly_usd: 0.12 },
    provision: {
      provider: 'hetzner',
      server_type: 'cpx31',
      image: 'ubuntu-24.04',
      location: 'nbg1',
      count: 1,
      cloud_init_sha256: '9c1e',
    },
    migration: {
      vercel_project_id: 'prj_1',
      git_repository: 'varsiko/shop',
      git_branch: 'migrate/severance',
      domain: 'app.example.com',
    },
    surveyor_prediction_sha256: '4af2',
    ...over,
  };
}

const provisionArgs = (over: Record<string, unknown> = {}) => ({
  server_type: 'cpx31',
  image: 'ubuntu-24.04',
  location: 'nbg1',
  count: 1,
  cloud_init_sha256: '9c1e',
  ...over,
});

describe('canonicalize', () => {
  it('is key-order independent and stable', () => {
    assert.equal(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  });
});

describe('verifyMandate', () => {
  it('accepts a freshly signed mandate', () => {
    const r = verifyMandate(signMandate(mandate(), privateKey), { publicKey, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.mandate.mandate_id, 'mdt_8891');
  });

  it('rejects a tampered payload', () => {
    const token = signMandate(mandate(), privateKey);
    const [p, s] = token.split('.') as [string, string];
    const evil = JSON.parse(Buffer.from(p, 'base64url').toString()) as HetznerMandate;
    evil.provision.server_type = 'cpx51';
    const forged = `${Buffer.from(canonicalize(evil)).toString('base64url')}.${s}`;
    const r = verifyMandate(forged, { publicKey, now: NOW });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, 'BAD_SIGNATURE');
  });

  it('rejects a mandate signed by the wrong key', () => {
    const other = generateKeyPairSync('ed25519');
    const r = verifyMandate(signMandate(mandate(), other.privateKey), { publicKey, now: NOW });
    assert.equal(!r.ok && r.code, 'BAD_SIGNATURE');
  });

  it('rejects an expired mandate', () => {
    const r = verifyMandate(signMandate(mandate(), privateKey), {
      publicKey,
      now: new Date('2026-09-20T15:20:00Z'),
    });
    assert.equal(!r.ok && r.code, 'EXPIRED');
  });

  it('rejects a mandate with no budget', () => {
    const m = mandate({ budget: { max_monthly_usd: 0, max_hourly_usd: 0 } });
    const r = verifyMandate(signMandate(m, privateKey), { publicKey, now: NOW });
    assert.equal(!r.ok && r.code, 'NO_BUDGET');
  });

  it('rejects a malformed token', () => {
    assert.equal(verifyMandate('garbage', { publicKey, now: NOW }).ok, false);
  });
});

describe('guard.authorize', () => {
  it('allows a provision that matches the mandate exactly', () => {
    const d = authorize(mandate(), 'hetzner:server.create', provisionArgs());
    assert.equal(d.allow, true);
    assert.equal(d.allow && d.estimated_monthly_usd, 15.5);
  });

  it('blocks an upsized server type', () => {
    const d = authorize(mandate(), 'hetzner:server.create', provisionArgs({ server_type: 'cpx51' }));
    assert.equal(d.allow, false);
    assert.equal(!d.allow && d.code, 'PARAM_SUBSTITUTION');
  });

  it('blocks a count increase (the injection payload)', () => {
    const d = authorize(mandate(), 'hetzner:server.create', provisionArgs({ count: 50 }));
    assert.equal(!d.allow && d.code, 'PARAM_SUBSTITUTION');
  });

  it('blocks a swapped cloud-init template', () => {
    const d = authorize(mandate(), 'hetzner:server.create', provisionArgs({ cloud_init_sha256: 'deadbeef' }));
    assert.equal(!d.allow && d.code, 'PARAM_SUBSTITUTION');
  });

  it('blocks a mandate whose own pinned type exceeds its cap', () => {
    const m = mandate({
      provision: { ...mandate().provision, server_type: 'cpx51' },
      budget: { max_monthly_usd: 30, max_hourly_usd: 0.1 },
    });
    const d = authorize(m, 'hetzner:server.create', provisionArgs({ server_type: 'cpx51' }));
    assert.equal(!d.allow && d.code, 'OVER_BUDGET');
  });

  it('rejects an out-of-band price even when the call is otherwise valid', () => {
    const d = authorize(mandate(), 'hetzner:server.create', provisionArgs(), { priceTable: { cpx31: 9999 } });
    assert.equal(!d.allow && d.code, 'PRICE_INSANE');
  });

  it('refuses DNS without an Auditor pass token', () => {
    const d = authorize(mandate(), 'cloudflare:dns.upsert', { name: 'app.example.com' });
    assert.equal(!d.allow && d.code, 'NO_AUDITOR_TOKEN');
  });

  it('allows DNS with an Auditor pass token', () => {
    const d = authorize(mandate(), 'cloudflare:dns.upsert', { name: 'app.example.com' }, { auditorPassToken: 'apt_44' });
    assert.equal(d.allow, true);
  });

  it('refuses DNS for a domain the mandate does not name', () => {
    const d = authorize(mandate(), 'cloudflare:dns.upsert', { name: 'evil.example.com' }, { auditorPassToken: 'apt_44' });
    assert.equal(!d.allow && d.code, 'PARAM_SUBSTITUTION');
  });

  it('expands coolify:* scope but still default-denies unknown tools', () => {
    assert.equal(authorize(mandate(), 'coolify:application.deploy', {}).allow, true);
    assert.equal(authorize(mandate(), 'hetzner:server.delete', {}).allow, false);
    assert.equal(authorize(mandate(), 'shell:exec', {}).allow, false);
  });

  it('honours a narrowed scope', () => {
    const m = mandate({ scope: ['coolify:deployment.status'] });
    assert.equal(authorize(m, 'hetzner:server.create', provisionArgs()).allow, false);
    assert.equal(authorize(m, 'coolify:deployment.status', {}).allow, true);
  });
});

describe('write-ahead ledger (MAF retry / 120s timeout defence)', () => {
  const base = { run_id: 'run_1', mandate_id: 'mdt_8891', nonce: 'b7f3a1', step: 'P2', key: 'mdt_8891:P2:provision' };

  it('allows the first claim', async () => {
    const l = new MemoryLedger();
    assert.equal((await claim(l, base)).ok, true);
  });

  it('refuses a retry while an INTENT is unresolved', async () => {
    const l = new MemoryLedger();
    await claim(l, base);
    const second = await claim(l, base); // MAF attempt 2 after a 120s flow-guard kill
    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.code, 'IN_FLIGHT');
  });

  it('refuses a third attempt after commit', async () => {
    const l = new MemoryLedger();
    await claim(l, base);
    await settle(l, base, 'COMMITTED');
    const third = await claim(l, base);
    assert.equal(!third.ok && third.code, 'ALREADY_COMMITTED');
  });

  it('detects a replayed nonce across a different run', async () => {
    const l = new MemoryLedger();
    await claim(l, base);
    assert.ok(await nonceSpent(l, 'b7f3a1'));
    assert.equal(await nonceSpent(l, 'unseen'), null);
  });

  it('lets an unrelated step proceed', async () => {
    const l = new MemoryLedger();
    await claim(l, base);
    const other = await claim(l, { ...base, step: 'P4', key: 'mdt_8891:P4:coolify-project' });
    assert.equal(other.ok, true);
  });
});
