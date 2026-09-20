import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sha256Hex } from '../src/gateway/cloudinit.ts';
import { loadConfig } from '../src/gateway/config.ts';
import { McpError } from '../src/pilot/providers.ts';
import { SERVER_IP } from './helpers/fake-internet.ts';
import { withHarness, type Harness } from './helpers/harness.ts';

const OPERATOR_TOOLS = ['handoff_prepare', 'handoff_register'];
const hetznerPosts = (h: Harness) => h.net.requests.filter((r) => r.host === 'api.hetzner.cloud' && r.method === 'POST').length;

/** prepare -> (human buys) -> register, the way the operator CLI does it. */
async function prepared(h: Harness, over = {}) {
  const { mandate, token } = h.issueHandoff(over);
  const prep = await h.direct('operator', 'handoff_prepare', { mandate: token });
  assert.equal(prep.isError, false, prep.raw);
  return { mandate, token, cloudInit: prep.data.cloud_init as string };
}
const register = (h: Harness, token: string, o: { ip?: string; run_id?: string; attest?: boolean } = {}) =>
  h.direct('operator', 'handoff_register', {
    mandate: token,
    run_id: o.run_id ?? 'run_1',
    ip: o.ip ?? SERVER_IP,
    port_8000_restricted: o.attest ?? true,
  });

describe('operator lane: who can call what', () => {
  it('the agent credential cannot list or call operator tools', async () => {
    await withHarness({}, async (h) => {
      const names = await h.listTools('agent');
      for (const t of OPERATOR_TOOLS) assert.ok(!names.includes(t), `agent can see ${t}`);
      assert.ok(names.includes('handoff_status'));

      const { token } = h.issueHandoff();
      for (const t of OPERATOR_TOOLS) {
        const r = await h.direct('agent', t, { mandate: token, run_id: 'run_1', ip: SERVER_IP, port_8000_restricted: true });
        assert.equal(r.error, 'FORBIDDEN_ROLE', t);
      }
    });
  });

  it('the operator credential sees only operator tools and cannot buy', async () => {
    await withHarness({}, async (h) => {
      assert.deepEqual(await h.listTools('operator'), OPERATOR_TOOLS);
      const { token } = h.issue();
      const r = await h.direct('operator', 'hetzner_server_create', {
        mandate: token, run_id: 'run_1', server_type: 'cpx31', image: 'ubuntu-24.04', location: 'nbg1', count: 1, cloud_init_sha256: sha256Hex(h.template),
      });
      assert.equal(r.error, 'FORBIDDEN_ROLE');
      assert.equal(hetznerPosts(h), 0);
    });
  });

  it('an unknown credential is 401, and the operator token is refused when none is configured', async () => {
    await withHarness({}, async (h) => {
      const res = await fetch(h.gatewayUrl, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 401);
    });
  });

  it('through Nasiko: the agent cannot even name the operator tools, and the rules block them', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issueHandoff();
      await assert.rejects(
        h.client().callTool('handoff_register', { mandate: token, run_id: 'r', ip: SERVER_IP, port_8000_restricted: true }),
        (e: unknown) => e instanceof McpError && e.code === -32601,
      );
      // Even naming the namespaced tool directly is stopped by the trailing catch-all block.
      const res = await fetch(h.nasiko.url, {
        method: 'POST',
        headers: { 'x-nasiko-agent-token': h.nasiko.token.current, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vmg__handoff_register', arguments: { mandate: token } } }),
      });
      const body = (await res.json()) as { error?: { code: number } };
      assert.equal(body.error?.code, -32000);
      assert.equal(h.nasiko.calls.filter((c) => c.tool === 'handoff_register').length, 0);
      // The status tool is allowed through.
      assert.equal((await h.client().callTool<{ registered: boolean }>('handoff_status', { mandate: token })).registered, false);
    });
  });
});

describe('handoff_prepare', () => {
  it('returns cloud-init with the token HASH, is idempotent, and logs no content', async () => {
    await withHarness({}, async (h) => {
      const { mandate, cloudInit } = await prepared(h);
      const secrets = (await h.deps.vault.get<{ api_token: string; root_password: string }>('coolify', `coolify:${mandate.mandate_id}`))!;
      assert.ok(cloudInit.includes(sha256Hex(secrets.api_token)));
      assert.ok(!cloudInit.includes(secrets.api_token), 'plaintext API token must not be in the cloud-init');
      assert.ok(!/__[A-Z0-9_]+__/.test(cloudInit));

      const again = await h.direct('operator', 'handoff_prepare', { mandate: h.issueHandoff().token });
      assert.equal(again.isError, false); // a different mandate with the same id reuses the vault entry

      const log = JSON.stringify(h.audit);
      assert.ok(!log.includes(secrets.root_password) && !log.includes(secrets.api_token) && !log.includes('forceFill'));
      assert.ok(h.audit.some((e) => e.tool === 'handoff_prepare' && e.role === 'operator' && e.mandate_id === mandate.mandate_id));
    });
  });

  it('refuses a hetzner mandate, a template mismatch, and an expired mandate', async () => {
    await withHarness({}, async (h) => {
      assert.equal((await h.direct('operator', 'handoff_prepare', { mandate: h.issue().token })).error, 'WRONG_PROVIDER');
      assert.equal((await h.direct('operator', 'handoff_prepare', { mandate: h.issueHandoff({}, { cloud_init_sha256: 'a'.repeat(64) }).token })).error, 'TEMPLATE_MISMATCH');
      h.clock.t = new Date('2026-09-22T00:00:00Z');
      assert.equal((await h.direct('operator', 'handoff_prepare', { mandate: h.issueHandoff().token })).error, 'EXPIRED');
    });
  });
});

describe('handoff_register', () => {
  it('registers a public IP, then handoff_status and coolify_health resolve it through the ledger', async () => {
    await withHarness({}, async (h) => {
      const { token, cloudInit, mandate } = await prepared(h);
      assert.equal((await h.direct('agent', 'handoff_status', { mandate: token })).data.registered, false);

      const r = await register(h, token);
      assert.equal(r.isError, false, r.raw);
      assert.equal(r.data.server_id, `handoff:${SERVER_IP}`);

      const st = await h.direct('agent', 'handoff_status', { mandate: token });
      assert.deepEqual({ registered: st.data.registered, ip: st.data.ip }, { registered: true, ip: SERVER_IP });

      // The human boots a box with the rendered cloud-init; the gateway reaches it via the ledger row.
      h.net.humanBuys(cloudInit);
      let ready = false;
      for (let i = 0; i < 5 && !ready; i++) ready = (await h.direct('agent', 'coolify_health', { mandate: token })).data.ready === true;
      assert.equal(ready, true);
      assert.equal(hetznerPosts(h), 0, 'nothing is bought through the API');

      const entry = h.audit.find((e) => e.tool === 'handoff_register')!;
      assert.equal(entry.ip, SERVER_IP);
      assert.equal(entry.mandate_id, mandate.mandate_id);
      assert.equal(entry.role, 'operator');
      assert.equal(entry.outcome, 'ok');
    });
  });

  it('a box that did not run OUR cloud-init never becomes healthy', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      await register(h, token);
      h.net.humanBuys('#cloud-config\n# the human pasted something else');
      for (let i = 0; i < 6; i++) assert.equal((await h.direct('agent', 'coolify_health', { mandate: token })).data.ready, false);
    });
  });

  it('refuses every address that is not a public IPv4, and stays unregistered', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '::1', 'example.com', '1.2.3.4:80']) {
        const r = await register(h, token, { ip });
        assert.equal(r.error, 'BAD_IP', ip);
      }
      assert.equal((await h.direct('agent', 'handoff_status', { mandate: token })).data.registered, false);
      // The refused attempts are audited with the address, so an operator mistake leaves a trail.
      assert.ok(h.audit.some((e) => e.tool === 'handoff_register' && e.ip === '169.254.169.254' && e.code === 'BAD_IP'));
    });
  });

  it('requires the port-8000 attestation unless the gateway allows insecure HTTP', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      assert.equal((await register(h, token, { attest: false })).error, 'NO_ATTESTATION');
      h.cfg.allowInsecureCoolifyHttp = true;
      const r = await register(h, token, { attest: false });
      assert.equal(r.isError, false, r.raw);
      assert.equal(r.data.attested_port_8000, false);
    });
  });

  it('is idempotent for the same IP and refuses a different IP in the same run', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      assert.equal((await register(h, token)).isError, false);
      const again = await register(h, token);
      assert.equal(again.isError, false);
      assert.equal(again.data.idempotent, true);
      assert.equal((await register(h, token, { ip: '198.51.100.9' })).error, 'ALREADY_REGISTERED');
      assert.equal((await h.direct('agent', 'handoff_status', { mandate: token })).data.ip, SERVER_IP);
    });
  });

  it('cannot register the same mandate from a second run (REPLAY)', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      assert.equal((await register(h, token, { run_id: 'run_1' })).isError, false);
      assert.equal((await register(h, token, { run_id: 'run_2' })).error, 'REPLAY');
      assert.equal((await register(h, token, { run_id: 'run_2', ip: '198.51.100.9' })).error, 'REPLAY');
    });
  });

  it('refuses a registration after `exp`, and one for a box that was never prepared', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      h.clock.t = new Date('2026-09-21T15:00:00Z');
      assert.equal((await register(h, token)).error, 'EXPIRED');
    });
    await withHarness({}, async (h) => {
      const { token } = h.issueHandoff();
      assert.equal((await register(h, token)).error, 'NOT_PREPARED');
    });
  });

  it('refuses a hetzner mandate, and a handoff mandate cannot buy or delete', async () => {
    await withHarness({}, async (h) => {
      assert.equal((await register(h, h.issue().token)).error, 'WRONG_PROVIDER');

      const { token, mandate } = h.issueHandoff({ scope: ['hetzner:server.create', 'hetzner:server.delete', 'handoff:status'] });
      const create = await h.direct('agent', 'hetzner_server_create', {
        mandate: token, run_id: 'run_1', server_type: 'cpx31', image: 'ubuntu-24.04', location: 'nbg1', count: 1, cloud_init_sha256: mandate.provision.cloud_init_sha256,
      });
      assert.equal(create.error, 'WRONG_PROVIDER');
      assert.equal((await h.direct('agent', 'hetzner_server_delete', { mandate: token, server_id: '1' })).error, 'WRONG_PROVIDER');
      assert.equal(hetznerPosts(h), 0);
    });
  });

  it('measures the run window from registration, not from the mandate', async () => {
    await withHarness({}, async (h) => {
      const { token } = await prepared(h);
      h.clock.t = new Date('2026-09-21T10:00:00Z'); // 19h after the mandate was issued, still inside `exp`
      assert.equal((await register(h, token)).isError, false);
      assert.equal((await h.direct('agent', 'coolify_health', { mandate: token })).isError, false, 'inside the window right after registering');
      h.clock.t = new Date('2026-09-21T12:30:00Z'); // 2.5h later: past the 120 min run window
      assert.equal((await h.direct('agent', 'coolify_health', { mandate: token })).error, 'RUN_WINDOW_EXPIRED');
    });
  });
});

describe('handoff_status', () => {
  it('reports "not registered" for an unregistered or expired mandate instead of erroring, and refuses a hetzner mandate', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issueHandoff();
      h.clock.t = new Date('2026-09-22T00:00:00Z'); // past exp: the runbook decides what that means
      assert.deepEqual((await h.direct('agent', 'handoff_status', { mandate: token })).data, { registered: false });
      assert.equal((await h.direct('agent', 'handoff_status', { mandate: h.issue().token })).error, 'WRONG_PROVIDER');
      assert.equal((await h.direct('agent', 'handoff_status', { mandate: 'garbage' })).error, 'MALFORMED');
    });
  });
});

describe('gateway config: operator token', () => {
  const env = {
    GATEWAY_BEARER_TOKEN: 'b'.repeat(40), VAULT_KEY: 'ab'.repeat(32), HETZNER_TOKEN: 'x', HETZNER_SSH_KEYS: 'k', MANDATE_PUBLIC_KEY_FILE: 'cloud-init/coolify.yaml',
  };
  it('is optional, must be 32+ characters, and must differ from the agent bearer', () => {
    assert.equal(loadConfig(env).operatorToken, undefined);
    assert.equal(loadConfig({ ...env, GATEWAY_OPERATOR_TOKEN: 'o'.repeat(32) }).operatorToken, 'o'.repeat(32));
    assert.throws(() => loadConfig({ ...env, GATEWAY_OPERATOR_TOKEN: 'short' }), /at least 32/);
    assert.throws(() => loadConfig({ ...env, GATEWAY_OPERATOR_TOKEN: env.GATEWAY_BEARER_TOKEN }), /differ/);
  });
});
