import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sha256Hex } from '../src/gateway/cloudinit.ts';
import { MemoryLedger } from '../src/pilot/ledger.ts';
import { McpError, ToolRefusal } from '../src/pilot/providers.ts';
import { advance, newRun, run, type RunState } from '../src/pilot/runbook.ts';
import { COOLIFY_HOST, SERVER_IP } from './helpers/fake-internet.ts';
import { withHarness, type Harness } from './helpers/harness.ts';

const dump = (s: RunState) => `${s.status} ${s.error ?? ''}\n${s.log.join('\n')}`;
const posts = (h: Harness, path: string) => h.net.requests.filter((r) => r.method === 'POST' && r.path === path).length;

async function deploy(h: Harness, runId = 'run_1', over = {}) {
  const { mandate, token } = h.issue(over);
  const ledger = new MemoryLedger();
  const state = await run(newRun(runId), h.pilot(token, runId, { ledger }), 300);
  return { mandate, token, ledger, state };
}

describe('the eight steps, end to end (real runbook -> MCP -> gateway -> fake internet)', () => {
  it('runs steps 1-8 and stops before DNS', async () => {
    await withHarness({}, async (h) => {
      const { mandate, state: s } = await deploy(h);
      assert.equal(s.status, 'DEPLOYED', dump(s));
      assert.equal(s.next_owner, 'Auditor');

      const log = s.log.join('\n');
      assert.match(log, /verified mandate/); // 1
      assert.match(log, /price VERIFIED/); // 2
      assert.match(log, /bought cpx31\/nbg1/); // 3
      assert.match(log, /coolify healthy/); // 4
      assert.match(log, /project prj-1, app app-1/); // 5
      assert.match(log, /moved 2 env vars/); // 6
      assert.match(log, /deployment succeeded/); // 7/8

      assert.equal(h.net.servers.size, 1);
      assert.equal(h.net.dns.size, 0, 'DNS must be untouched until the Auditor passes');
      const server = [...h.net.servers.values()][0]!;
      assert.deepEqual(server.labels, { managed_by: 'varsiko-pilot', mandate_id: mandate.mandate_id, run_id: 'run_1' });
      assert.equal(h.net.appBodies[0]?.git_repository, mandate.migration.git_repository);
      assert.equal(h.net.appBodies[0]?.git_branch, mandate.migration.git_branch);
      assert.equal(h.net.appBodies[0]?.environment_name, 'production');
    });
  });

  it('moves only production, non-sensitive vars, and names what it could not move', async () => {
    await withHarness({}, async (h) => {
      const { state: s } = await deploy(h);
      assert.deepEqual(h.net.envsReceived.map((e) => e.key).sort(), ['DATABASE_URL', 'NEXT_PUBLIC_SITE']);
      assert.deepEqual(s.env_skipped, ['STRIPE_SECRET_KEY']);
      assert.match(s.log.join('\n'), /NOT moved, re-enter by hand: STRIPE_SECRET_KEY/);
    });
  });

  it('cloud-init carries the token HASH, never the token, and keeps the pinned template', async () => {
    await withHarness({}, async (h) => {
      const { mandate } = await deploy(h);
      const secrets = await h.deps.vault.get<{ api_token: string; root_password: string }>('coolify', `coolify:${mandate.mandate_id}`);
      assert.ok(secrets);
      const userData = [...h.net.servers.values()][0]!.user_data;
      assert.ok(userData.includes(sha256Hex(secrets.api_token)));
      assert.ok(!userData.includes(secrets.api_token), 'plaintext API token must not be in user_data');
      assert.ok(userData.includes(secrets.root_password), 'the installer needs the root password');
      assert.equal(sha256Hex(h.template), mandate.provision.cloud_init_sha256);
      assert.ok(!/__[A-Z0-9_]+__/.test(userData), 'no unsubstituted placeholders');
    });
  });

  it('never lets a secret reach the agent', async () => {
    await withHarness({}, async (h) => {
      const { mandate, state: s } = await deploy(h);
      const secrets = (await h.deps.vault.get<{ api_token: string; root_password: string }>('coolify', `coolify:${mandate.mandate_id}`))!;
      const seenByAgent = h.nasiko.traffic.join('\n') + JSON.stringify(s) + s.log.join('\n');
      for (const secret of ['s3cr3t-db-pass', secrets.api_token, secrets.root_password, 'hz-token', 'vc-token', 'ak-key', 'cf-token']) {
        assert.ok(!seenByAgent.includes(secret), `leaked: ${secret.slice(0, 6)}...`);
      }
    });
  });

  it('gives the agent no argument that can redirect the gateway to another host', async () => {
    await withHarness({}, async (h) => {
      await deploy(h);
      const coolifyCalls = h.nasiko.calls.filter((c) => c.tool.startsWith('coolify_') || c.tool.startsWith('cloudflare_'));
      assert.ok(coolifyCalls.length > 0);
      for (const c of coolifyCalls) {
        assert.ok(!('ip' in c.args) && !('host' in c.args) && !('url' in c.args), `${c.tool} accepted a target`);
      }
      const hosts = new Set(h.net.requests.map((r) => r.host));
      assert.deepEqual([...hosts].sort(), ['api.anakin.io', 'api.hetzner.cloud', 'api.vercel.com', COOLIFY_HOST].sort());
    });
  });
});

describe('cutover (DNS)', () => {
  it('points the domain at the bought server once approved and audited', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      h.nasiko.approved.add('cloudflare_dns_upsert');
      const ctx = h.pilot(token, 'run_1', { ledger, auditor: h.auditor(mandate) });
      const s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, ctx);
      assert.equal(s.status, 'CUTOVER', dump(s));
      assert.equal(h.net.dns.get(mandate.migration.domain)?.content, SERVER_IP);
      assert.equal(h.net.dns.get(mandate.migration.domain)?.ttl, 60);
    });
  });

  it('waits for human approval without touching the server or DNS, then completes when approved', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      const ctx = h.pilot(token, 'run_1', { ledger, auditor: h.auditor(mandate) });
      let s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, ctx);
      assert.equal(s.status, 'NEEDS_APPROVAL', dump(s));
      assert.equal(h.net.servers.size, 1, 'a pending approval must never destroy the server');
      assert.equal(h.net.dns.size, 0);

      h.nasiko.approved.add('cloudflare_dns_upsert');
      s = await advance(s, ctx);
      assert.equal(s.status, 'CUTOVER', dump(s));
    });
  });

  it('refuses an Auditor PASS that was issued for a different server', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      h.nasiko.approved.add('cloudflare_dns_upsert');
      const ctx = h.pilot(token, 'run_1', { ledger, auditor: h.auditor(mandate, '198.51.100.7') });
      const s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, ctx);
      assert.equal(s.status, 'FAILED');
      assert.match(s.error ?? '', /AUDITOR_WRONG_SERVER/);
      assert.equal(h.net.servers.size, 1, 'a failed cutover must leave the healthy server running');
      assert.equal(h.net.dns.size, 0);
    });
  });

  it('refuses an Auditor PASS signed with the wrong key', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      h.nasiko.approved.add('cloudflare_dns_upsert');
      const forged = h.auditor(mandate).split('.')[0] + '.' + Buffer.from('not a signature').toString('base64url');
      const s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, h.pilot(token, 'run_1', { ledger, auditor: forged }));
      assert.match(s.error ?? '', /AUDITOR_BAD_SIGNATURE/);
      assert.equal(h.net.dns.size, 0);
    });
  });

  it('rolls DNS back to the previous record', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      h.net.dns.set(mandate.migration.domain, { id: 'rec-old', content: '192.0.2.10', ttl: 300, proxied: false });
      h.nasiko.approved.add('cloudflare_dns_upsert');
      const s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, h.pilot(token, 'run_1', { ledger, auditor: h.auditor(mandate) }));
      assert.equal(s.status, 'CUTOVER', dump(s));
      assert.equal(h.net.dns.get(mandate.migration.domain)?.content, SERVER_IP);

      await h.client().callTool('cloudflare_dns_rollback', { mandate: token, record_id: s.artifacts.dns_record_id });
      assert.equal(h.net.dns.get(mandate.migration.domain)?.content, '192.0.2.10');
      assert.equal(h.net.dns.get(mandate.migration.domain)?.ttl, 300);
    });
  });
});

describe('failure handling', () => {
  it('a lost purchase response is reconciled, not repeated (exactly one server)', async () => {
    await withHarness({ net: { hetznerLoseResponse: true } }, async (h) => {
      const { token } = h.issue();
      const first = await run(newRun('run_r'), h.pilot(token, 'run_r'), 300);
      assert.equal(first.status, 'FAILED');
      assert.match(first.error ?? '', /outcome unknown/);
      assert.equal(h.net.servers.size, 1, 'the purchase did happen; only the response was lost');

      // Recovery: a fresh Pilot with an empty agent-side ledger. The gateway's ledger is the authority.
      const second = await run(newRun('run_r'), h.pilot(token, 'run_r'), 300);
      assert.equal(second.status, 'DEPLOYED', dump(second));
      assert.equal(h.net.servers.size, 1);
      assert.equal(posts(h, '/v1/servers'), 1, 'Hetzner must have been asked to create exactly once');
    });
  });

  it('a captured mandate cannot be replayed by another run', async () => {
    await withHarness({}, async (h) => {
      const { token } = await deploy(h, 'run_1');
      const replay = await run(newRun('run_2'), h.pilot(token, 'run_2'), 300);
      assert.equal(replay.status, 'FAILED');
      assert.match(replay.error ?? '', /REPLAY/);
      assert.equal(h.net.servers.size, 1);
    });
  });

  it('a failed deployment destroys the server and leaves DNS alone', async () => {
    await withHarness({ net: { deployFails: true } }, async (h) => {
      const { state: s } = await deploy(h);
      assert.equal(s.status, 'ROLLED_BACK', dump(s));
      assert.equal(s.cost_committed_usd, 0);
      assert.equal(h.net.servers.size, 0);
      assert.equal(h.net.dns.size, 0);
    });
  });

  it('a network blip while polling does not destroy a healthy server', async () => {
    await withHarness({ net: { deployStatusBlips: 3 } }, async (h) => {
      const { state: s } = await deploy(h);
      assert.equal(s.status, 'DEPLOYED', dump(s));
      assert.equal(h.net.servers.size, 1);
      assert.match(s.log.join('\n'), /WARN status check error/);
    });
  });

  it('after the run window closes: no more setup or cutover, but cleanup still works', async () => {
    await withHarness({}, async (h) => {
      const { mandate, token, ledger, state } = await deploy(h);
      h.clock.t = new Date(h.clock.t.getTime() + 3 * 3_600_000); // > the 120 min default window
      h.nasiko.approved.add('cloudflare_dns_upsert');

      const s = await advance({ ...state, step: 'P8_CUTOVER', status: 'RUNNING' }, h.pilot(token, 'run_1', { ledger, auditor: h.auditor(mandate) }));
      assert.equal(s.status, 'FAILED');
      assert.match(s.error ?? '', /RUN_WINDOW_EXPIRED/);
      assert.equal(h.net.servers.size, 1);

      await h.client().callTool('hetzner_server_delete', { mandate: token, server_id: state.artifacts.server_id });
      assert.equal(h.net.servers.size, 0, 'rollback must remain possible after the window');
    });
  });
});

describe('the gateway refuses on its own, even if Pilot is compromised', () => {
  const args = (over: Record<string, unknown>, mandate: string, h: Harness) => ({
    mandate,
    run_id: 'x',
    server_type: 'cpx31',
    image: 'ubuntu-24.04',
    location: 'nbg1',
    count: 1,
    cloud_init_sha256: sha256Hex(h.template),
    ...over,
  });
  const refusal = (code: string) => (e: unknown) => e instanceof ToolRefusal && e.code === code;

  it('rejects a bigger server, a higher count, and a swapped cloud-init', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issue();
      const gw = h.client();
      await assert.rejects(gw.callTool('hetzner_server_create', args({ server_type: 'cpx51' }, token, h)), refusal('PARAM_SUBSTITUTION'));
      await assert.rejects(gw.callTool('hetzner_server_create', args({ count: 50 }, token, h)), refusal('PARAM_SUBSTITUTION'));
      await assert.rejects(gw.callTool('hetzner_server_create', args({ cloud_init_sha256: 'deadbeef' }, token, h)), refusal('PARAM_SUBSTITUTION'));
      assert.equal(h.net.servers.size, 0);
    });
  });

  it('rejects a mandate whose pinned template is not the one the gateway holds', async () => {
    await withHarness({}, async (h) => {
      const { token, mandate } = h.issue({ provision: { ...h.issue().mandate.provision, cloud_init_sha256: 'a'.repeat(64) } });
      await assert.rejects(
        h.client().callTool('hetzner_server_create', args({ cloud_init_sha256: mandate.provision.cloud_init_sha256 }, token, h)),
        refusal('TEMPLATE_MISMATCH'),
      );
      assert.equal(h.net.servers.size, 0);
    });
  });

  it('rejects a tampered or expired mandate', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issue();
      const [p, sig] = token.split('.') as [string, string];
      const evil = JSON.parse(Buffer.from(p, 'base64url').toString()) as { budget: { max_monthly_usd: number } };
      evil.budget.max_monthly_usd = 9999;
      const forged = `${Buffer.from(JSON.stringify(evil)).toString('base64url')}.${sig}`;
      await assert.rejects(h.client().callTool('hetzner_server_create', args({}, forged, h)), (e: unknown) => e instanceof ToolRefusal && /BAD_SIGNATURE|NON_CANONICAL/.test(e.code));

      h.clock.t = new Date('2026-09-20T15:30:00Z');
      await assert.rejects(h.client().callTool('hetzner_server_create', args({}, token, h)), refusal('EXPIRED'));
      assert.equal(h.net.servers.size, 0);
    });
  });

  it('pins the repo and branch that will run on the box holding the secrets', async () => {
    await withHarness({}, async (h) => {
      const { token, state } = await deploy(h);
      await assert.rejects(
        h.client().callTool('coolify_application_create', {
          mandate: token, run_id: 'run_1', project_uuid: state.artifacts.project_uuid, git_repository: 'evil/repo', git_branch: 'main', build_pack: 'nixpacks',
        }),
        refusal('PARAM_SUBSTITUTION'),
      );
    });
  });

  it('refuses to delete a server this mandate did not create', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issue();
      const foreign = h.net.plant('someone-elses', { managed_by: 'varsiko-pilot', mandate_id: 'mdt_other' });
      const unlabelled = h.net.plant('production-db', {});
      await assert.rejects(h.client().callTool('hetzner_server_delete', { mandate: token, server_id: String(foreign) }), refusal('FORBIDDEN'));
      await assert.rejects(h.client().callTool('hetzner_server_delete', { mandate: token, server_id: String(unlabelled) }), refusal('FORBIDDEN'));
      assert.equal(h.net.servers.size, 2);
    });
  });

  it('refuses another mandate’s sealed env blob', async () => {
    await withHarness({}, async (h) => {
      const { token, state } = await deploy(h);
      await assert.rejects(
        h.client().callTool('coolify_envs_bulk_update', { mandate: token, app_uuid: state.artifacts.app_uuid, sealed_ref: 'sealed:env:mdt_other' }),
        refusal('BAD_REF'),
      );
    });
  });

  it('refuses to scrape any URL except the pricing page', async () => {
    await withHarness({}, async (h) => {
      const { token } = h.issue();
      await assert.rejects(
        h.client().callTool('anakin_scrape_submit', { mandate: token, url: 'http://169.254.169.254/latest/meta-data' }),
        refusal('URL_NOT_ALLOWED'),
      );
    });
  });

  it('refuses to provision without a firewall unless the operator opts in', async () => {
    await withHarness({}, async (h) => {
      h.cfg.hetznerFirewallId = undefined;
      const { token } = h.issue();
      await assert.rejects(h.client().callTool('hetzner_server_create', args({}, token, h)), refusal('NO_FIREWALL'));
      assert.equal(h.net.servers.size, 0);
    });
  });
});

describe('Nasiko boundary', () => {
  it('rejects a stale delegation token', async () => {
    await withHarness({}, async (h) => {
      const gw = h.client();
      h.nasiko.token.current = 'rotated';
      await assert.rejects(gw.callTool('coolify_health', { mandate: 'x' }), (e: unknown) => e instanceof McpError && e.code === -32602);
    });
  });

  it('blocks any tool that is not in the rules (default-deny via the catch-all)', async () => {
    await withHarness({}, async (h) => {
      await assert.rejects(h.client().call('vmg__shell_exec', {}), (e: unknown) => e instanceof McpError && e.blocked);
    });
  });

  it('the gateway itself rejects callers without the connector bearer', async () => {
    await withHarness({}, async (h) => {
      const bad = await fetch(h.gatewayUrl, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
      assert.equal(bad.status, 401);
      const none = await fetch(h.gatewayUrl, { method: 'POST', body: '{}' });
      assert.equal(none.status, 401);
    });
  });

  it('exposes exactly the tools Pilot needs and nothing that can run commands', async () => {
    await withHarness({}, async (h) => {
      const r = await fetch(h.gatewayUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.cfg.bearerToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const names = ((await r.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        'anakin_scrape_status', 'anakin_scrape_submit', 'cloudflare_dns_rollback', 'cloudflare_dns_upsert',
        'coolify_application_create', 'coolify_application_deploy', 'coolify_deployment_status', 'coolify_envs_bulk_update',
        'coolify_health', 'coolify_project_create', 'hetzner_server_create', 'hetzner_server_delete', 'vercel_env_export',
      ]);
      assert.ok(!names.some((n) => /exec|shell|ssh|run_command/.test(n)));
    });
  });
});
