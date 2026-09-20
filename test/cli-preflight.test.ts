import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cidrCovers, preflight } from '../src/cli/preflight.ts';
import { sha256Hex } from '../src/gateway/cloudinit.ts';
import type { Mandate } from '../src/pilot/mandate.ts';
import { captureIo } from './helpers/cli.ts';
import type { FakeInternetOptions } from './helpers/fake-internet.ts';
import { makeHarness } from './helpers/harness.ts';

const TOKENS = {
  HETZNER_TOKEN: 'hz-secret-token-AAAA1111',
  CLOUDFLARE_TOKEN: 'cf-secret-token-BBBB2222',
  VERCEL_TOKEN: 'vc-secret-token-CCCC3333',
  ANAKIN_API_KEY: 'ak-secret-key-DDDD4444',
};
const VERCEL_SECRET_VALUE = 's3cr3t-db-pass'; // the fake Vercel returns this; preflight must never surface it

interface Setup {
  net?: FakeInternetOptions;
  env?: Record<string, string>;
  args?: string[] | ((file: (name: string) => string) => string[]);
  mandate?: Partial<Mandate>;
  plant?: (net: import('./helpers/fake-internet.ts').FakeInternet) => void;
}

async function runPreflight(o: Setup = {}) {
  const h = await makeHarness({ net: o.net });
  const dir = await mkdtemp(join(tmpdir(), 'preflight-'));
  try {
    const pem = (k: { export(o: object): string | Buffer }, type: 'spki' | 'pkcs8') => k.export({ type, format: 'pem' }) as string;
    const f = (n: string) => join(dir, n);
    await writeFile(f('m.pub'), pem(h.keys.mandate.publicKey, 'spki'));
    await writeFile(f('m.key'), pem(h.keys.mandate.privateKey, 'pkcs8'));
    await writeFile(f('a.pub'), pem(h.keys.auditor.publicKey, 'spki'));
    await writeFile(f('a.key'), pem(h.keys.auditor.privateKey, 'pkcs8'));
    const issued = h.issue(o.mandate ?? {});
    await writeFile(f('mandate.json'), JSON.stringify(issued));
    o.plant?.(h.net);

    const env: Record<string, string> = {
      ...TOKENS,
      GATEWAY_BEARER_TOKEN: h.cfg.bearerToken,
      VAULT_KEY: h.cfg.vaultKey,
      HETZNER_SSH_KEYS: 'ops-key',
      MANDATE_PUBLIC_KEY_FILE: f('m.pub'),
      AUDITOR_PUBLIC_KEY_FILE: f('a.pub'),
      HETZNER_FIREWALL_ID: '42',
      GATEWAY_EGRESS_IP: '198.51.100.7',
      GATEWAY_URL: h.gatewayUrl,
      ...o.env,
    };
    const cap = captureIo({ env });
    const given = typeof o.args === 'function' ? o.args(f) : o.args;
    const args = given ?? ['--mandate', f('mandate.json'), '--mandate-key', f('m.key'), '--auditor-key', f('a.key')];
    const code = await preflight(args, cap.io, { fetch: h.net.fetch, now: () => h.clock.t, sleep: async () => {} });
    return { code, text: cap.text(), net: h.net, dir, files: f };
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const TEMPLATE_SHA = sha256Hex(await readFile('cloud-init/coolify.yaml', 'utf8'));
const provision = (over: Partial<Mandate['provision']>): Partial<Mandate> => ({
  provision: { provider: 'hetzner', server_type: 'cpx31', image: 'ubuntu-24.04', location: 'nbg1', count: 1, cloud_init_sha256: TEMPLATE_SHA, ...over },
});

const row = (text: string, check: string) =>
  new RegExp(`^(PASS|WARN|FAIL|SKIP)\\s+${check}\\s{2}(.*)$`, 'm').exec(text)?.slice(1) as [string, string] | undefined;
const status = (text: string, check: string) => row(text, check)?.[0];
const noSecrets = (text: string) => {
  for (const s of [...Object.values(TOKENS), 'g'.repeat(40), 'ab'.repeat(32), VERCEL_SECRET_VALUE]) {
    assert.ok(!text.includes(s), `a secret leaked into preflight output: ${s.slice(0, 6)}...`);
  }
};

describe('preflight', () => {
  it('an all-green setup has no FAIL, exits 0, and explains the warnings it does raise', async () => {
    const r = await runPreflight();
    assert.equal(r.code, 0, r.text);
    for (const c of ['Config', 'Mandate keys', 'Auditor key', 'Mandate', 'Template', 'Hetzner token', 'Hetzner SSH keys', 'Hetzner firewall', 'Egress IP', 'Server type', 'Location', 'Orphans', 'Cloudflare', 'Gateway']) {
      assert.equal(status(r.text, c), 'PASS', `${c}\n${r.text}`);
    }
    assert.match(row(r.text, 'Hetzner write access')![1], /write permission cannot be verified without buying/);
    assert.equal(status(r.text, 'Hetzner write access'), 'WARN');
    // The fake project has one Sensitive var; only its NAME may be shown.
    assert.equal(status(r.text, 'Vercel'), 'WARN');
    assert.match(r.text, /re-enter by hand: STRIPE_SECRET_KEY/);
    assert.equal(status(r.text, 'Anakin'), 'SKIP');
    noSecrets(r.text);
  });

  it('is read-only: no Hetzner write, no scrape unless asked, no Vercel decrypt', async () => {
    const r = await runPreflight();
    const writes = r.net.requests.filter((q) => q.method !== 'GET');
    assert.deepEqual(writes, [], 'preflight issued a non-GET request');
    assert.equal(r.net.servers.size, 0);
    assert.ok(!r.net.requests.some((q) => q.host === 'api.anakin.io'));
    const vercel = r.net.requests.filter((q) => q.host === 'api.vercel.com');
    assert.ok(vercel.length > 0, 'the Vercel check should have run');
    assert.ok(vercel.every((q) => !/decrypt/i.test(q.search)), 'preflight must not ask Vercel to decrypt');
  });

  it('FAILs on a rejected Hetzner token and skips what depends on it', async () => {
    const r = await runPreflight({ net: { hetznerUnauthorized: true } });
    assert.equal(r.code, 1);
    assert.equal(status(r.text, 'Hetzner token'), 'FAIL');
    assert.match(row(r.text, 'Hetzner token')![1], /token rejected \(401\)/);
    for (const c of ['Hetzner firewall', 'Server type', 'Location', 'Orphans']) assert.equal(status(r.text, c), 'SKIP', c);
    noSecrets(r.text);
  });

  it('FAILs when a configured SSH key does not exist', async () => {
    const r = await runPreflight({ env: { HETZNER_SSH_KEYS: 'ops-key,ghost-key' } });
    assert.equal(r.code, 1);
    assert.match(row(r.text, 'Hetzner SSH keys')![1], /not found in this Hetzner project: ghost-key/);
  });

  it('FAILs when the mandate server type is not listed', async () => {
    const r = await runPreflight({ net: { serverTypes: ['cpx21'] } });
    assert.equal(r.code, 1);
    assert.equal(status(r.text, 'Server type'), 'FAIL');
  });

  it('WARNs on a deprecated type, and when the pinned price is below the listed price', async () => {
    const dep = await runPreflight({ net: { deprecatedServerTypes: ['cpx31'] } });
    assert.equal(status(dep.text, 'Server type'), 'WARN');
    assert.match(row(dep.text, 'Server type')![1], /deprecated/);

    // cpx21 is pinned at $8.5 but the fake lists EUR 13.00 (~$14.30).
    const low = await runPreflight({ mandate: provision({ server_type: 'cpx21' }) });
    assert.equal(status(low.text, 'Server type'), 'WARN');
    assert.match(row(low.text, 'Server type')![1], /pinned price is BELOW the listed price/);
  });

  it('FAILs on an unknown location', async () => {
    const r = await runPreflight({ mandate: provision({ location: 'mars1' }) });
    assert.equal(status(r.text, 'Location'), 'FAIL');
  });

  it('WARNs (not FAILs) about existing orphans, listing id, mandate and age', async () => {
    const r = await runPreflight({ plant: (net) => net.plant('varsiko-mdt-old', { managed_by: 'varsiko-pilot', mandate_id: 'mdt_old' }) });
    assert.equal(r.code, 0);
    assert.equal(status(r.text, 'Orphans'), 'WARN');
    assert.match(r.text, /id \d+\s+varsiko-mdt-old\s+mandate mdt_old\s+age 3 h/);
  });

  it('WARNs when the firewall is open to the world, lacks a :8000 rule, or excludes the egress IP', async () => {
    const open = await runPreflight({ net: { firewallSources: ['0.0.0.0/0'] } });
    assert.equal(status(open.text, 'Hetzner firewall'), 'WARN');
    assert.match(row(open.text, 'Hetzner firewall')![1], /open to 0\.0\.0\.0\/0/);

    const none = await runPreflight({ net: { firewallSources: [] } });
    assert.match(row(none.text, 'Hetzner firewall')![1], /no inbound tcp\/8000 rule/);

    const wrongIp = await runPreflight({ env: { GATEWAY_EGRESS_IP: '203.0.113.9' } });
    assert.equal(status(wrongIp.text, 'Egress IP'), 'WARN');
    assert.equal(status(wrongIp.text, 'Hetzner firewall'), 'PASS');
  });

  it('FAILs when the mandate pins a different template than the gateway holds', async () => {
    const r = await runPreflight({ mandate: provision({ cloud_init_sha256: 'deadbeef'.repeat(8) }) });
    assert.equal(status(r.text, 'Template'), 'FAIL');
    assert.match(row(r.text, 'Template')![1], /TEMPLATE_MISMATCH/);
  });

  it('FAILs on an inactive Cloudflare token', async () => {
    const r = await runPreflight({ net: { cloudflareInactive: true } });
    assert.equal(status(r.text, 'Cloudflare'), 'FAIL');
    noSecrets(r.text);
  });

  it('FAILs when the private key does not match the configured public key', async () => {
    const r = await runPreflight({ args: (f) => ['--mandate', f('mandate.json'), '--mandate-key', f('a.key'), '--auditor-key', f('m.key')] });
    assert.equal(r.code, 1);
    assert.match(row(r.text, 'Mandate keys')![1], /does not match/);
    assert.match(row(r.text, 'Auditor key')![1], /does not match/);
    assert.ok(!r.text.includes('PRIVATE KEY'));
  });

  it('without --mandate, mandate-dependent checks SKIP instead of failing', async () => {
    const r = await runPreflight({ args: (f) => ['--mandate-key', f('m.key')] });
    assert.equal(status(r.text, 'Mandate keys'), 'PASS');
    assert.equal(status(r.text, 'Mandate'), 'SKIP');
    assert.equal(status(r.text, 'Server type'), 'SKIP');
    assert.equal(status(r.text, 'Location'), 'SKIP');
  });

  it('with no configuration at all: clear FAILs, no crash, exit 1', async () => {
    const cap = captureIo({ env: {} });
    const code = await preflight([], cap.io, { fetch: async () => { throw new Error('no network expected'); }, gatewayFetch: async () => { throw new TypeError('down'); } });
    assert.equal(code, 1);
    assert.match(cap.text(), /FAIL\s+Config\s+missing required env: GATEWAY_BEARER_TOKEN, VAULT_KEY, HETZNER_TOKEN, HETZNER_SSH_KEYS, MANDATE_PUBLIC_KEY_FILE/);
    assert.equal(status(cap.text(), 'Hetzner token'), 'SKIP');
    assert.equal(status(cap.text(), 'Gateway'), 'WARN');
  });

  it('WARNs (not FAILs) when the gateway is simply not running, and FAILs on a rejected bearer', async () => {
    const down = await runPreflight({ env: { GATEWAY_URL: 'http://127.0.0.1:1/mcp' } });
    assert.equal(status(down.text, 'Gateway'), 'WARN');
    assert.match(row(down.text, 'Gateway')![1], /npm run gateway/);

    const badBearer = await runPreflight({ env: { GATEWAY_BEARER_TOKEN: 'x'.repeat(40) } });
    assert.equal(status(badBearer.text, 'Gateway'), 'FAIL');
    assert.match(row(badBearer.text, 'Gateway')![1], /rejects GATEWAY_BEARER_TOKEN/);
  });

  it('--spend-anakin submits one scrape, checks extraction, and saves the markdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anakin-md-'));
    try {
      const out = join(dir, 'pricing.md');
      const r = await runPreflight({ args: ['--spend-anakin', '--save-markdown', out] });
      assert.equal(status(r.text, 'Anakin'), 'PASS', r.text);
      assert.match(row(r.text, 'Anakin')![1], /cpx31 priced at USD 15/);
      assert.match(await readFile(out, 'utf8'), /CPX31/);
      assert.equal(r.net.requests.filter((q) => q.host === 'api.anakin.io' && q.method === 'POST').length, 1, 'exactly one scrape submitted');
      noSecrets(r.text);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('--spend-anakin WARNs when the page has no price row for the type', async () => {
    const r = await runPreflight({ args: ['--spend-anakin'], net: { priceMarkdown: '# Pricing\nnothing useful' } });
    assert.equal(status(r.text, 'Anakin'), 'WARN');
    assert.match(row(r.text, 'Anakin')![1], /no monthly price row found/);
  });
});

describe('cidrCovers', () => {
  it('matches CIDR ranges and exact addresses', () => {
    assert.equal(cidrCovers('198.51.100.7/32', '198.51.100.7'), true);
    assert.equal(cidrCovers('198.51.100.7/32', '198.51.100.8'), false);
    assert.equal(cidrCovers('198.51.100.0/24', '198.51.100.200'), true);
    assert.equal(cidrCovers('10.0.0.0/8', '11.0.0.1'), false);
    assert.equal(cidrCovers('0.0.0.0/0', '203.0.113.9'), true);
    assert.equal(cidrCovers('2001:db8::/32', '203.0.113.9'), false);
  });
});
