import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';
import { AnakinClient } from '../src/gateway/clients/anakin.ts';
import { CloudflareClient } from '../src/gateway/clients/cloudflare.ts';
import { CoolifyClient, mapDeployStatus } from '../src/gateway/clients/coolify.ts';
import { HetznerClient, safeLabel } from '../src/gateway/clients/hetzner.ts';
import { ProviderError, requestJson } from '../src/gateway/clients/http.ts';
import { VercelClient } from '../src/gateway/clients/vercel.ts';
import { renderCloudInit, sha256Hex, ALLOWED_PLACEHOLDERS } from '../src/gateway/cloudinit.ts';
import { loadConfig } from '../src/gateway/config.ts';
import { Vault } from '../src/gateway/vault.ts';
import { generateKeyPairSync } from 'node:crypto';
import { signAuditorToken, verifyAuditorToken } from '../src/pilot/auditor.ts';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const KEY = 'cd'.repeat(32);

describe('Vault', () => {
  const make = async () => new Vault(await mkdtemp(join(tmpdir(), 'vault-')), KEY);

  it('round-trips a value and never stores plaintext', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'));
    const v = new Vault(dir, KEY);
    await v.put('env', 'env:m1', [{ key: 'A', value: 'plaintext-secret' }], 60_000);
    assert.deepEqual(await v.get('env', 'env:m1'), [{ key: 'A', value: 'plaintext-secret' }]);
    assert.ok(!(await readFile(join(dir, 'env_m1.json'), 'utf8')).includes('plaintext-secret'));
  });

  it('will not open a blob as a different kind (AAD binding)', async () => {
    const v = await make();
    await v.put('env', 'x', { a: 1 }, 60_000);
    assert.equal(await v.get('coolify', 'x'), null);
  });

  it('expires entries', async () => {
    const v = await make();
    await v.put('env', 'x', { a: 1 }, 1000, 1_000);
    assert.deepEqual(await v.get('env', 'x', 1_500), { a: 1 });
    assert.equal(await v.get('env', 'x', 3_000), null);
  });

  it('treats a tampered file and a wrong key as absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vault-'));
    const v = new Vault(dir, KEY);
    await v.put('env', 'x', { a: 1 }, 60_000);
    assert.equal(await new Vault(dir, 'ef'.repeat(32)).get('env', 'x'), null);
    const f = JSON.parse(await readFile(join(dir, 'x.json'), 'utf8')) as { ct: string };
    f.ct = Buffer.from('tampered').toString('base64');
    await writeFile(join(dir, 'x.json'), JSON.stringify(f));
    assert.equal(await v.get('env', 'x'), null);
  });

  it('rejects path-traversal names and short keys', async () => {
    const v = await make();
    await assert.rejects(v.put('env', '../../etc/passwd', {}, 1000));
    assert.throws(() => new Vault('/tmp/x', 'abcd'), /64 hex/);
  });
});

describe('cloud-init renderer', () => {
  const tpl = `#cloud-config\nuser: __COOLIFY_ROOT_USER__\nemail: __COOLIFY_ROOT_EMAIL__\npw: __COOLIFY_ROOT_PASSWORD__\nh: __API_TOKEN_SHA256__\nips: __ALLOWED_IPS__\n`;
  const ok = { COOLIFY_ROOT_USER: 'varsiko', COOLIFY_ROOT_EMAIL: 'a@b.c', COOLIFY_ROOT_PASSWORD: 'abc123', API_TOKEN_SHA256: 'f'.repeat(64), ALLOWED_IPS: '' };

  it('substitutes only whitelisted placeholders and reports the TEMPLATE hash', () => {
    const r = renderCloudInit(tpl, ok);
    assert.ok(r.userData.includes('user: varsiko'));
    assert.equal(r.templateSha256, sha256Hex(tpl));
  });

  it('rejects a template with a placeholder that is not whitelisted', () => {
    assert.throws(() => renderCloudInit(tpl + 'x: __EVIL__\n', ok), /not whitelisted/);
  });

  it('rejects values that could carry shell syntax', () => {
    for (const bad of ["a'; rm -rf /; '", 'a b', '$(id)', 'a`b`', 'a\nb', 'a"b', 'a;b']) {
      assert.throws(() => renderCloudInit(tpl, { ...ok, COOLIFY_ROOT_PASSWORD: bad }), /safe set/);
    }
  });

  it('the shipped template only uses whitelisted placeholders', async () => {
    const real = await readFile('cloud-init/coolify.yaml', 'utf8');
    const found = new Set((real.match(/__[A-Z0-9_]+__/g) ?? []).map((t) => t.slice(2, -2)));
    for (const f of found) assert.ok((ALLOWED_PLACEHOLDERS as readonly string[]).includes(f), f);
    assert.ok(found.size >= 4);
  });
});

/** Runs a request that is expected to fail and returns the ProviderError it threw. */
const failure = async (f: typeof fetch, init?: Parameters<typeof requestJson>[2]): Promise<ProviderError> => {
  try {
    await requestJson({ provider: 'x', fetch: f }, 'http://x', init);
  } catch (e) {
    assert.ok(e instanceof ProviderError, 'expected a ProviderError');
    return e;
  }
  assert.fail('expected the request to fail');
};

describe('http helper', () => {
  it('marks 4xx definitive and 5xx/429/network ambiguous', async () => {
    const codes = async (status: number) => (await failure(async () => json({ e: 1 }, status))).definitive;
    assert.equal(await codes(422), true);
    assert.equal(await codes(401), true);
    assert.equal(await codes(500), false);
    assert.equal(await codes(429), false);
    const net = await failure(async () => { throw new TypeError('fetch failed'); });
    assert.equal(net.definitive, false);
    assert.equal(net.status, 0);
  });

  it('never echoes the Authorization header and truncates provider bodies', async () => {
    const big = 'x'.repeat(5000);
    const e = await failure(async () => new Response(big, { status: 400 }), {
      headers: { authorization: 'Bearer SECRET-TOKEN' },
    });
    assert.ok(!e.message.includes('SECRET-TOKEN'));
    assert.ok(e.message.length < 250);
  });
});

describe('clients never leak their credential', () => {
  it('redacts under inspect', () => {
    for (const c of [
      new HetznerClient('SECRET-1'),
      new CloudflareClient('SECRET-2'),
      new VercelClient('SECRET-3'),
      new AnakinClient('SECRET-4'),
      new CoolifyClient('203.0.113.1', 'SECRET-5'),
    ]) {
      assert.ok(!inspect(c).includes('SECRET'), c.constructor.name);
      assert.ok(!JSON.stringify(c).includes('SECRET'), c.constructor.name);
    }
  });
});

describe('HetznerClient', () => {
  it('sends the firewall, labels and user_data, and returns the IPv4', async () => {
    let body: any;
    const c = new HetznerClient('t', {
      fetch: async (_u, init) => {
        body = JSON.parse(String(init?.body));
        return json({ server: { id: 7, name: 'n', status: 'initializing', labels: {}, public_net: { ipv4: { ip: '1.2.3.4' } } } }, 201);
      },
    });
    const s = await c.createServer({ name: 'n', server_type: 'cpx31', image: 'ubuntu-24.04', location: 'nbg1', ssh_keys: ['k'], user_data: '#cloud-config', labels: { a: 'b' }, firewall_id: 42 });
    assert.equal(s.ip, '1.2.3.4');
    assert.deepEqual(body.firewalls, [{ firewall: 42 }]);
    assert.equal(body.start_after_create, true);
    assert.deepEqual(body.ssh_keys, ['k']);
  });

  it('refuses unsafe label values (selectors are not escaped)', async () => {
    assert.throws(() => safeLabel('a,b=c'));
    assert.throws(() => safeLabel('x'.repeat(64)));
    assert.equal(safeLabel('mdt_8891'), 'mdt_8891');
    await assert.rejects(new HetznerClient('t', { fetch: async () => json({ servers: [] }) }).findByLabel('mandate_id', 'a,b'));
  });
});

describe('CoolifyClient', () => {
  it('only accepts an IPv4 address as its host', () => {
    assert.throws(() => new CoolifyClient('evil.example.com', 't'), /IPv4/);
    assert.throws(() => new CoolifyClient('1.2.3.4/../x', 't'), /IPv4/);
  });

  it('ready() is false on 401 (bootstrap not finished), true once authenticated', async () => {
    let n = 0;
    const c = new CoolifyClient('1.2.3.4', 't', { fetch: async () => (++n < 3 ? json({}, 401) : json({ id: 0 })) });
    assert.deepEqual([await c.ready(), await c.ready(), await c.ready()], [false, false, true]);
  });

  it('accepts both documented deploy response shapes', async () => {
    const a = new CoolifyClient('1.2.3.4', 't', { fetch: async () => json({ deployments: [{ deployment_uuid: 'd1' }] }) });
    const b = new CoolifyClient('1.2.3.4', 't', { fetch: async () => json([{ deployment_uuid: 'd2' }]) });
    assert.equal((await a.deploy('app')).deployment_uuid, 'd1');
    assert.equal((await b.deploy('app')).deployment_uuid, 'd2');
    await assert.rejects(new CoolifyClient('1.2.3.4', 't', { fetch: async () => json({}) }).deploy('app'), /deployment_uuid/);
  });

  it('maps Coolify status strings conservatively', () => {
    assert.equal(mapDeployStatus('finished'), 'success');
    assert.equal(mapDeployStatus('failed'), 'failed');
    assert.equal(mapDeployStatus('cancelled'), 'failed');
    assert.equal(mapDeployStatus('in_progress'), 'running');
    assert.equal(mapDeployStatus('some-new-status'), 'running', 'unknown must not read as success');
    assert.equal(mapDeployStatus(undefined), 'running');
  });
});

describe('CloudflareClient', () => {
  it('finds the zone by walking up to the parent domain', async () => {
    const seen: string[] = [];
    const c = new CloudflareClient('t', {
      fetch: async (u) => {
        const name = new URL(String(u)).searchParams.get('name')!;
        seen.push(name);
        return json({ success: true, result: name === 'example.com' ? [{ id: 'z', name }] : [] });
      },
    });
    assert.equal(await c.zoneIdFor('a.b.example.com'), 'z');
    assert.deepEqual(seen, ['a.b.example.com', 'b.example.com', 'example.com']);
  });

  it('fails clearly when no zone is visible, and on success:false', async () => {
    const none = new CloudflareClient('t', { fetch: async () => json({ success: true, result: [] }) });
    await assert.rejects(none.zoneIdFor('x.nope.io'), /no zone visible/);
    const bad = new CloudflareClient('t', { fetch: async () => json({ success: false, errors: [{ message: 'denied' }], result: null }) });
    await assert.rejects(bad.zoneIdFor('x.nope.io'), /denied/);
  });
});

describe('VercelClient', () => {
  const page = (envs: unknown[], next: number | null = null) => async () => json({ envs, pagination: { next } });

  it('skips sensitive, system, non-production and valueless vars but names them', async () => {
    const c = new VercelClient('t', {
      fetch: page([
        { key: 'A', value: '1', type: 'encrypted', target: ['production'] },
        { key: 'B', type: 'sensitive', target: ['production'] },
        { key: 'C', value: 'x', type: 'plain', target: ['preview'] },
        { key: 'D', value: 'x', type: 'system', target: ['production'] },
        { key: 'E', value: '', type: 'plain', target: 'production' },
      ]),
    });
    const r = await c.exportProductionEnvs('p');
    assert.deepEqual(r.vars, [{ key: 'A', value: '1' }]);
    assert.deepEqual(r.skipped.map((s) => s.key).sort(), ['B', 'E']);
  });

  it('flags a truncated export rather than presenting it as complete', async () => {
    const r = await new VercelClient('t', { fetch: page([{ key: 'A', value: '1', type: 'plain', target: ['production'] }], 1234) }).exportProductionEnvs('p');
    assert.equal(r.truncated, true);
  });

  it('sends decrypt=true and the team id', async () => {
    let url = '';
    await new VercelClient('t', { teamId: 'team_9', fetch: async (u) => { url = String(u); return json({ envs: [] }); } }).exportProductionEnvs('my proj');
    assert.match(url, /decrypt=true/);
    assert.match(url, /teamId=team_9/);
    assert.match(url, /my%20proj/);
  });
});

describe('AnakinClient', () => {
  it('requests markdown with a real browser and sends X-API-Key', async () => {
    let body: any;
    let key = '';
    const c = new AnakinClient('k', {
      fetch: async (_u, init) => {
        body = JSON.parse(String(init?.body));
        key = new Headers(init?.headers).get('x-api-key') ?? '';
        return json({ jobId: 'j1' }, 202);
      },
    });
    assert.deepEqual(await c.submit('https://example.com'), { jobId: 'j1' });
    assert.deepEqual(body.formats, ['markdown']);
    assert.equal(body.useBrowser, true);
    assert.equal(key, 'k');
  });

  it('errors if the submit response has no jobId', async () => {
    await assert.rejects(new AnakinClient('k', { fetch: async () => json({}) }).submit('https://x.io'), /jobId/);
  });
});

describe('Auditor token', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const claims = { mandate_id: 'm1', server_ip: '1.2.3.4', verdict: 'PASS' as const, iat: '2026-09-20T15:00:00Z', exp: '2026-09-20T16:00:00Z' };
  const now = new Date('2026-09-20T15:30:00Z');
  const check = (token: string, over = {}) => verifyAuditorToken(token, { publicKey, mandate_id: 'm1', server_ip: '1.2.3.4', now, ...over });

  it('accepts a matching token', () => assert.equal(check(signAuditorToken(claims, privateKey)).ok, true));
  it('rejects another mandate, another server, and expiry', () => {
    const t = signAuditorToken(claims, privateKey);
    assert.equal((check(t, { mandate_id: 'm2' }) as { code: string }).code, 'AUDITOR_WRONG_MANDATE');
    assert.equal((check(t, { server_ip: '9.9.9.9' }) as { code: string }).code, 'AUDITOR_WRONG_SERVER');
    assert.equal((check(t, { now: new Date('2026-09-20T17:00:00Z') }) as { code: string }).code, 'AUDITOR_EXPIRED');
  });
  it('rejects a non-PASS verdict and a foreign key', () => {
    const fail = signAuditorToken({ ...claims, verdict: 'FAIL' as 'PASS' }, privateKey);
    assert.equal((check(fail) as { code: string }).code, 'AUDITOR_NOT_PASS');
    const other = generateKeyPairSync('ed25519');
    assert.equal((check(signAuditorToken(claims, other.privateKey)) as { code: string }).code, 'AUDITOR_BAD_SIGNATURE');
  });
});

describe('config', () => {
  it('lists every missing required variable at once', () => {
    assert.throws(() => loadConfig({}), /GATEWAY_BEARER_TOKEN.*VAULT_KEY.*HETZNER_TOKEN.*HETZNER_SSH_KEYS.*MANDATE_PUBLIC_KEY_FILE/);
  });

  it('rejects a weak bearer token and a non-integer firewall id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cfg-'));
    await writeFile(join(dir, 'm.pem'), 'pem');
    const base = { GATEWAY_BEARER_TOKEN: 'x'.repeat(40), VAULT_KEY: KEY, HETZNER_TOKEN: 't', HETZNER_SSH_KEYS: 'a, b', MANDATE_PUBLIC_KEY_FILE: join(dir, 'm.pem') };
    assert.throws(() => loadConfig({ ...base, GATEWAY_BEARER_TOKEN: 'short' }), /32 characters/);
    assert.throws(() => loadConfig({ ...base, HETZNER_FIREWALL_ID: 'abc' }), /integer/);
    const cfg = loadConfig({ ...base, HETZNER_FIREWALL_ID: '42' });
    assert.deepEqual(cfg.hetznerSshKeys, ['a', 'b']);
    assert.equal(cfg.hetznerFirewallId, 42);
    assert.equal(cfg.allowInsecureCoolifyHttp, false, 'insecure mode must be opt-in');
  });
});
