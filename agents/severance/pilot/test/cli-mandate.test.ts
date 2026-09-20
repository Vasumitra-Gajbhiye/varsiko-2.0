import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { UsageError } from '../src/cli/io.ts';
import { mandateCommand, normalizeRepo } from '../src/cli/mandate.ts';
import { sha256Hex } from '../src/gateway/cloudinit.ts';
import { authorize } from '../src/pilot/guard.ts';
import { verifyMandate, type HetznerProvision, type Mandate } from '../src/pilot/mandate.ts';
import { captureIo } from './helpers/cli.ts';

const NOW = new Date('2026-09-20T15:00:00Z');

describe('mandate command', () => {
  let dir: string;
  let publicKey: string;
  let base: string[];
  let out: string;
  let n = 0;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mandate-'));
    const kp = generateKeyPairSync('ed25519');
    publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    await writeFile(join(dir, 'mandate.key.pem'), kp.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    base = [
      '--server-type', 'cpx31', '--location', 'nbg1', '--repo', 'owner/name', '--branch', 'main',
      '--domain', 'app.example.com', '--vercel-project', 'prj_abc', '--max-monthly', '30',
      '--ttl-minutes', '10', '--run-window', '60', '--approved-by', 'you@example.com',
      '--key', join(dir, 'mandate.key.pem'),
    ];
  });
  beforeEach(() => {
    out = join(dir, `out${++n}`); // a fresh directory per test
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const run = (args: string[], confirm = true) => {
    const cap = captureIo({ confirm });
    return { cap, done: mandateCommand([...base, '--out-dir', out, ...args], cap.io, { now: () => NOW }) };
  };
  const written = async (): Promise<{ mandate: Mandate; token: string }> => {
    const files = await readdir(out);
    assert.equal(files.length, 1, 'exactly one mandate file expected');
    return JSON.parse(await readFile(join(out, files[0]!), 'utf8'));
  };

  it('issues a mandate whose token verifies, with a computed template hash', async () => {
    const { cap, done } = run(['--prediction-sha256', 'abc123']);
    assert.equal(await done, 0);

    const { mandate, token } = await written();
    const v = verifyMandate(token, { publicKey, now: NOW });
    assert.equal(v.ok, true);
    assert.deepEqual(v.ok && v.mandate, mandate);

    const template = await readFile('cloud-init/coolify.yaml', 'utf8');
    assert.equal(mandate.provision.cloud_init_sha256, sha256Hex(template), 'hash is computed, never typed');
    assert.equal(mandate.provision.count, 1);
    assert.equal((mandate.provision as HetznerProvision).server_type, 'cpx31');
    assert.match(mandate.mandate_id, /^mdt_\d+$/);
    assert.match(mandate.nonce, /^[0-9a-f]{32}$/);
    assert.equal(mandate.exp, '2026-09-20T15:10:00.000Z');
    assert.equal(mandate.run_window_minutes, 60);
    assert.equal(mandate.migration.git_repository, 'https://github.com/owner/name');
    assert.equal(mandate.surveyor_prediction_sha256, 'abc123');
    assert.ok(mandate.scope.includes('cloudflare:dns.upsert'));

    const text = cap.text();
    assert.match(text, /This authorises buying 1 x cpx31 in nbg1, capped at \$30\/mo, valid 10 min, deploying owner\/name@main/);
    assert.match(text, /pinned price checked\s+\$15\.5\/mo/);
    assert.ok(!text.includes(token), 'the token must not be printed');
    assert.match(text, /written to .*mdt_\d+\.json/);
  });

  it('the issued mandate is accepted by the gateway guard', async () => {
    await run(['--prediction-sha256', 'abc']).done;
    const { mandate } = await written();
    const d = authorize(mandate, 'hetzner:server.create', { ...mandate.provision });
    assert.equal(d.allow, true);
  });

  it('warns when no prediction hash is given', async () => {
    const { cap, done } = run([]);
    assert.equal(await done, 0);
    assert.match(cap.text(), /WARNING: no --prediction-sha256/);
    assert.equal((await written()).mandate.surveyor_prediction_sha256, sha256Hex('manual-test'));
  });

  it('--no-dns drops cloudflare from scope, and needs no domain', async () => {
    const args = base.filter((_, i) => base[i] !== '--domain' && base[i - 1] !== '--domain');
    const cap = captureIo({ confirm: true });
    assert.equal(await mandateCommand([...args, '--no-dns', '--out-dir', out], cap.io, { now: () => NOW }), 0);
    const { mandate } = await written();
    assert.ok(!mandate.scope.some((s) => s.startsWith('cloudflare:')));
    assert.match(cap.text(), /DNS\s+DISABLED/);
    assert.equal(authorize(mandate, 'cloudflare:dns.upsert', { name: mandate.migration.domain }, { auditorPassToken: 'x' }).allow, false);
  });

  it('refuses an unknown server type', async () => {
    await assert.rejects(run(['--server-type', 'ccx99']).done, (e) => e instanceof UsageError && /no pinned price for server type "ccx99"/.test(e.message));
  });

  it('refuses a budget below the pinned price', async () => {
    await assert.rejects(run(['--max-monthly', '10']).done, (e) => e instanceof UsageError && /below the pinned price \$15\.5/.test(e.message));
  });

  it('writes nothing when the operator does not confirm', async () => {
    const { cap, done } = run([], false);
    assert.equal(await done, 2);
    assert.match(cap.text(), /nothing was written/);
    await assert.rejects(readdir(out), /ENOENT/);
  });

  it('skips the prompt with --yes', async () => {
    const { cap, done } = run(['--yes'], false);
    assert.equal(await done, 0);
    assert.equal(cap.prompts.length, 0);
  });

  it('rejects bad inputs', async () => {
    await assert.rejects(run(['--repo', 'not a repo']).done, UsageError);
    await assert.rejects(run(['--ttl-minutes', '0']).done, UsageError);
    await assert.rejects(run(['--domain', 'not_a_host']).done, UsageError);
    await assert.rejects(run(['--key', join(dir, 'missing.pem')]).done, /cannot read mandate key/);
    await assert.rejects(mandateCommand(['--server-type', 'cpx31'], captureIo().io), /--location is required/);
  });

  it('normalizes repositories', () => {
    assert.equal(normalizeRepo('a/b'), 'https://github.com/a/b');
    assert.equal(normalizeRepo('https://gitlab.com/a/b'), 'https://gitlab.com/a/b');
    assert.throws(() => normalizeRepo('http://github.com/a/b'), UsageError);
  });
});
