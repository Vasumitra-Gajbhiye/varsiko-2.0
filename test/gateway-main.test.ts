import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const BEARER = 'b'.repeat(48);
const VAULT_KEY = 'cd'.repeat(32);
const HETZNER_TOKEN = 'fake-hetzner-token-do-not-leak';

const EXPECTED_TOOLS = [
  'anakin_scrape_submit',
  'anakin_scrape_status',
  'hetzner_server_create',
  'hetzner_server_delete',
  'coolify_health',
  'handoff_status',
  'coolify_project_create',
  'coolify_application_create',
  'coolify_envs_bulk_update',
  'coolify_application_deploy',
  'coolify_deployment_status',
  'vercel_env_export',
  'cloudflare_dns_upsert',
  'cloudflare_dns_rollback',
].sort();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe('gateway main.ts as a real process', () => {
  let dir: string;
  let port: number;
  let child: ChildProcess;
  let out = '';
  let exited: Promise<void>;
  const base = () => `http://127.0.0.1:${port}`;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gw-main-'));
    const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;
    await writeFile(join(dir, 'mandate.pub.pem'), pub);
    port = await freePort();

    // Start from a clean slate: nothing from the developer's real environment may leak in.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of [
      'HETZNER_FIREWALL_ID', 'ALLOW_INSECURE_COOLIFY_HTTP', 'GATEWAY_EGRESS_IP', 'CLOUDFLARE_TOKEN',
      'VERCEL_TOKEN', 'VERCEL_TEAM_ID', 'ANAKIN_API_KEY', 'AUDITOR_PUBLIC_KEY_FILE', 'APP_PORT', 'CLOUD_INIT_TEMPLATE',
    ]) delete env[k];
    Object.assign(env, {
      GATEWAY_BEARER_TOKEN: BEARER,
      VAULT_KEY,
      HETZNER_TOKEN,
      HETZNER_SSH_KEYS: 'ops-key',
      MANDATE_PUBLIC_KEY_FILE: join(dir, 'mandate.pub.pem'),
      DATA_DIR: join(dir, 'data'),
      PORT: String(port),
    });

    child = spawn(process.execPath, ['src/gateway/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    exited = new Promise((resolve) => child.once('exit', () => resolve()));
    child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (out += d.toString()));

    const deadline = Date.now() + 15_000;
    while (!out.includes('listening') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`gateway exited early:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(out.includes('listening'), `gateway did not start:\n${out}`);
  });

  after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    await rm(dir, { recursive: true, force: true });
  });

  const rpc = (method: string, headers: Record<string, string> = {}) =>
    fetch(`${base()}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
    });

  it('answers GET /healthz with 200', async () => {
    const res = await fetch(`${base()}/healthz`);
    assert.equal(res.status, 200);
  });

  it('rejects POST /mcp without a Bearer token', async () => {
    assert.equal((await rpc('tools/list')).status, 401);
  });

  it('rejects POST /mcp with the wrong Bearer token', async () => {
    assert.equal((await rpc('tools/list', { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await rpc('tools/list', { authorization: BEARER })).status, 401, 'scheme is required');
  });

  it('lists exactly the 14 agent tools with the right Bearer', async () => {
    const res = await rpc('tools/list', { authorization: `Bearer ${BEARER}` });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(body.result.tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  });

  it('prints a note for each unset optional key', () => {
    for (const fragment of [
      'HETZNER_FIREWALL_ID',
      'CLOUDFLARE_TOKEN unset',
      'VERCEL_TOKEN unset',
      'ANAKIN_API_KEY unset',
      'AUDITOR_PUBLIC_KEY_FILE unset',
    ]) {
      assert.ok(out.includes(`note: `) && out.includes(fragment), `missing note about ${fragment}:\n${out}`);
    }
  });

  it('never prints a secret', async () => {
    await rpc('tools/list', { authorization: 'Bearer wrong-guess' }); // exercise the audit log too
    await rpc('tools/list', { authorization: `Bearer ${BEARER}` });
    for (const secret of [BEARER, VAULT_KEY, HETZNER_TOKEN, 'wrong-guess']) {
      assert.ok(!out.includes(secret), 'a secret appeared in gateway output');
    }
  });

  it('exits when killed', async () => {
    child.kill();
    await exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'process should have terminated');
  });
});

describe('gateway main.ts refuses a bad config', () => {
  it('lists every missing required variable and exits non-zero without a stack trace', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ['GATEWAY_BEARER_TOKEN', 'VAULT_KEY', 'HETZNER_TOKEN', 'HETZNER_SSH_KEYS', 'MANDATE_PUBLIC_KEY_FILE']) delete env[k];
    const p = spawn(process.execPath, ['src/gateway/main.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    p.stdout!.on('data', (d: Buffer) => (text += d.toString()));
    p.stderr!.on('data', (d: Buffer) => (text += d.toString()));
    const code = await new Promise<number | null>((resolve) => p.once('exit', resolve));
    assert.equal(code, 1);
    assert.match(text, /missing required env: GATEWAY_BEARER_TOKEN, VAULT_KEY, HETZNER_TOKEN, HETZNER_SSH_KEYS, MANDATE_PUBLIC_KEY_FILE/);
    assert.ok(!/\n\s+at /.test(text), 'no stack trace expected');
  });
});
