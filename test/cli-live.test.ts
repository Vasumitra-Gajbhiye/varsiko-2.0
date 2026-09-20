import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { UsageError } from '../src/cli/io.ts';
import { liveCommand, type LiveDeps } from '../src/cli/live.ts';
import type { RunState } from '../src/pilot/runbook.ts';
import { captureIo } from './helpers/cli.ts';
import { SERVER_IP, type FakeInternetOptions } from './helpers/fake-internet.ts';
import { makeHarness, type Harness } from './helpers/harness.ts';

const HETZNER_TOKEN = 'hz-secret-live-token-1234';
const VERCEL_SECRET_VALUE = 's3cr3t-db-pass';

interface Rig {
  h: Harness;
  dir: string;
  local: string;
  mandateFile: string;
  token: string;
  env: Record<string, string>;
  live(args: string[], o?: { confirm?: boolean; deps?: LiveDeps; env?: Record<string, string> }): Promise<{ code: number; text: string }>;
  state(id: string): Promise<RunState>;
  posts(path: string): number;
  /** Every secret that must never appear in output or saved state. */
  secrets(): Promise<string[]>;
}

async function withRig(o: { net?: FakeInternetOptions }, fn: (r: Rig) => Promise<void>) {
  const h = await makeHarness({ net: o.net });
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  try {
    const pubFile = join(dir, 'm.pub');
    await writeFile(pubFile, h.keys.mandate.publicKey.export({ type: 'spki', format: 'pem' }) as string);
    const issued = h.issue();
    const mandateFile = join(dir, 'mandate.json');
    await writeFile(mandateFile, JSON.stringify(issued));
    const local = join(dir, 'local');
    const env = {
      GATEWAY_BEARER_TOKEN: h.cfg.bearerToken,
      MANDATE_PUBLIC_KEY_FILE: pubFile,
      GATEWAY_URL: h.gatewayUrl,
      HETZNER_TOKEN,
      VAULT_KEY: h.cfg.vaultKey,
    };
    const rig: Rig = {
      h, dir, local, mandateFile, token: issued.token, env,
      async live(args, x = {}) {
        const cap = captureIo({ env: { ...env, ...x.env }, confirm: x.confirm ?? false });
        const code = await liveCommand(
          [...args, '--mandate', mandateFile, '--local-dir', local, '--poll-seconds', '0'],
          cap.io,
          { now: () => h.clock.t, sleep: async () => {}, hetznerFetch: h.net.fetch, ...x.deps },
        );
        return { code, text: cap.text() };
      },
      state: async (id) => JSON.parse(await readFile(join(local, 'runs', `${id}.json`), 'utf8')) as RunState,
      posts: (path) => h.net.requests.filter((q) => q.method === 'POST' && q.path === path).length,
      async secrets() {
        const vault = await h.deps.vault.get<{ api_token: string; root_password: string }>('coolify', `coolify:${issued.mandate.mandate_id}`);
        return [h.cfg.bearerToken, issued.token, h.cfg.vaultKey, HETZNER_TOKEN, VERCEL_SECRET_VALUE, ...(vault ? [vault.api_token, vault.root_password] : [])];
      },
    };
    await fn(rig);
  } finally {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const noSecrets = async (r: Rig, ...texts: string[]) => {
  for (const s of await r.secrets()) for (const t of texts) assert.ok(!t.includes(s), `a secret leaked: ${s.slice(0, 6)}...`);
};
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('live driver (real runbook -> real gateway over HTTP -> fake internet, no Nasiko)', () => {
  it('runs a full migration, banner first, prints each log line once, leaks nothing', async () => {
    await withRig({}, async (r) => {
      const { code, text } = await r.live(['--run-id', 'run_1', '--yes']);
      assert.equal(code, 0, text);
      assert.match(text, /DIRECT MODE: Nasiko is bypassed, so no Nasiko approval or audit applies/);
      assert.match(text, /1 x cpx31 in nbg1\s+cap \$60\/mo\s+\(~\$0\.021\/hour/);
      assert.match(text, /DNS\s+ENABLED for app\.example\.com \(only via --cutover\)/);
      assert.ok(text.indexOf('DIRECT MODE') < text.indexOf('bought cpx31'), 'the banner must come before any step');
      assert.match(text, /DEPLOYED\s+step=DONE\s+servers_bought=1\s+dns_writes=0\s+committed=\$15\.5\/mo\s+next=Auditor/);
      assert.match(text, /re-enter by hand: STRIPE_SECRET_KEY/);
      assert.equal(count(text, 'bought cpx31'), 1, 'each log line is printed once');

      assert.equal(r.h.net.servers.size, 1);
      assert.equal((await r.state('run_1')).status, 'DEPLOYED');
      await noSecrets(r, text, await readFile(join(r.local, 'runs', 'run_1.json'), 'utf8'), await readFile(join(r.local, 'pilot-ledger.jsonl'), 'utf8'));
    });
  });

  it('does nothing unless the operator confirms', async () => {
    await withRig({}, async (r) => {
      const { code, text } = await r.live(['--run-id', 'run_1'], { confirm: false });
      assert.equal(code, 2);
      assert.match(text, /Not confirmed; nothing was done/);
      assert.equal(r.h.net.servers.size, 0);
      assert.equal(r.h.net.requests.filter((q) => q.method !== 'GET').length, 0, 'no provider call before confirmation');
    });
  });

  it('sizes the poll budget to a real Coolify install (about 15 minutes), not the runbook default of 20 polls', async () => {
    await withRig({}, async (r) => {
      const cap = captureIo({ env: r.env, confirm: false });
      await liveCommand(['--mandate', r.mandateFile, '--local-dir', r.local, '--poll-seconds', '10', '--run-id', 'run_1'], cap.io, { now: () => r.h.clock.t });
      assert.match(cap.text(), /gives up after 90 polls \(~15 min\)/);
    });
  });

  it('--stop-after boot stops with the box healthy, then --resume finishes with still one server', async () => {
    await withRig({}, async (r) => {
      const first = await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
      assert.equal(first.code, 0, first.text);
      assert.match(first.text, /coolify healthy/);
      assert.match(first.text, /Stopped after boot as requested/);
      assert.match(first.text, new RegExp(`Coolify: http://${SERVER_IP.replace(/\./g, '\\.')}:8000`));
      assert.match(first.text, /npm run live -- --mandate \S+ --run-id run_1 --resume/);
      assert.match(first.text, /npm run live -- --mandate \S+ --run-id run_1 --cleanup/);
      assert.equal((await r.state('run_1')).step, 'P4_PROJECT');
      assert.equal(r.h.net.servers.size, 1);

      const second = await r.live(['--run-id', 'run_1', '--yes', '--resume']);
      assert.equal(second.code, 0, second.text);
      assert.match(second.text, /Resuming run_1 at P4_PROJECT/);
      assert.ok(!second.text.includes('bought cpx31'), 'a resume must not replay old log lines');
      assert.equal(r.posts('/v1/servers'), 1);
      assert.equal((await r.state('run_1')).status, 'DEPLOYED');
    });
  });

  it('Ctrl-C mid-boot prints the resume and cleanup commands, deletes nothing, and --resume completes', async () => {
    await withRig({}, async (r) => {
      const ac = new AbortController();
      const first = await r.live(['--run-id', 'run_1', '--yes'], {
        deps: {
          signal: ac.signal,
          sleep: async () => {
            if (r.h.net.servers.size > 0) ac.abort(); // the operator presses Ctrl-C once the box exists
          },
        },
      });
      assert.equal(first.code, 130, first.text);
      assert.match(first.text, /Interrupted at P3_BOOT\. Nothing was deleted\./);
      assert.match(first.text, /Continue:\s+npm run live -- --mandate \S+ --run-id run_1 --resume/);
      assert.match(first.text, /Clean up:\s+npm run live -- --mandate \S+ --run-id run_1 --cleanup/);
      assert.equal(r.h.net.requests.filter((q) => q.method === 'DELETE').length, 0);
      assert.equal(r.h.net.servers.size, 1);

      const second = await r.live(['--run-id', 'run_1', '--yes', '--resume']);
      assert.equal(second.code, 0, second.text);
      assert.equal(r.posts('/v1/servers'), 1, 'exactly one purchase across the interruption');
    });
  });

  it('a purchase whose response was lost is reconciled on --resume: exactly one server, never two', async () => {
    await withRig({ net: { hetznerLoseResponse: true } }, async (r) => {
      const first = await r.live(['--run-id', 'run_1', '--yes']);
      assert.equal(first.code, 1, first.text);
      assert.match(first.text, /provision outcome unknown/);
      assert.equal(r.h.net.servers.size, 1, 'the purchase happened; only the response was lost');

      const second = await r.live(['--run-id', 'run_1', '--yes', '--resume']);
      assert.equal(second.code, 0, second.text);
      assert.match(second.text, /released this run's open purchase INTENT/);
      assert.equal(r.posts('/v1/servers'), 1, 'Hetzner was asked to create exactly once');
      assert.equal(r.h.net.servers.size, 1);
      assert.equal((await r.state('run_1')).status, 'DEPLOYED');
    });
  });

  it('a failed deployment ends ROLLED_BACK with the server destroyed and $0 committed (exit 1)', async () => {
    await withRig({ net: { deployFails: true } }, async (r) => {
      const { code, text } = await r.live(['--run-id', 'run_1', '--yes']);
      assert.equal(code, 1, text);
      assert.match(text, /ROLLED_BACK\s+step=P7_VERIFY\s+servers_bought=1\s+dns_writes=0\s+committed=\$0\/mo/);
      assert.equal(r.h.net.servers.size, 0);
    });
  });

  it('refuses to replay a mandate under a new run id', async () => {
    await withRig({}, async (r) => {
      assert.equal((await r.live(['--run-id', 'run_1', '--yes'])).code, 0);
      const replay = await r.live(['--run-id', 'run_2', '--yes']);
      assert.equal(replay.code, 1);
      assert.match(replay.text, /REPLAY/);
      assert.equal(r.h.net.servers.size, 1);
      assert.equal(r.posts('/v1/servers'), 1);
    });
  });

  describe('--cleanup', () => {
    it('destroys the run\'s server, marks it ROLLED_BACK, and lists what remains without touching foreign servers', async () => {
      await withRig({}, async (r) => {
        await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
        const foreign = r.h.net.plant('varsiko-mdt-other', { managed_by: 'varsiko-pilot', mandate_id: 'mdt_other' });

        const { code, text } = await r.live(['--cleanup', '--run-id', 'run_1', '--yes']);
        assert.equal(code, 0, text);
        assert.match(text, /destroyed server \d+/);
        assert.match(text, /1 server\(s\) labelled managed_by=varsiko-pilot still exist/);
        assert.match(text, new RegExp(`id ${foreign}\\s+varsiko-mdt-other\\s+mandate mdt_other`));
        assert.deepEqual([...r.h.net.servers.keys()], [foreign], 'only this run\'s server may be deleted');
        const s = await r.state('run_1');
        assert.equal(s.status, 'ROLLED_BACK');
        assert.equal(s.cost_committed_usd, 0);
        await noSecrets(r, text);
      });
    });

    it('asks first, and does nothing if declined', async () => {
      await withRig({}, async (r) => {
        await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
        const { code, text } = await r.live(['--cleanup', '--run-id', 'run_1'], { confirm: false });
        assert.equal(code, 2);
        assert.match(text, /will delete\s+server \d+/);
        assert.equal(r.h.net.servers.size, 1);
      });
    });

    it('cleanup for an unknown run id says there is no saved state', async () => {
      await withRig({}, async (r) => {
        await r.live(['--run-id', 'run_1'], { confirm: false }); // declined: no state saved
        await assert.rejects(r.live(['--cleanup', '--run-id', 'run_1', '--yes']), /no saved state for run_1/);
      });
    });

    it('tolerates a server that is already gone', async () => {
      await withRig({}, async (r) => {
        await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
        r.h.net.servers.clear(); // deleted by hand in the console
        const { code, text } = await r.live(['--cleanup', '--run-id', 'run_1', '--yes']);
        assert.equal(code, 0, text);
        assert.match(text, /already gone \(404\)/);
        assert.equal((await r.state('run_1')).status, 'ROLLED_BACK');
      });
    });
  });

  describe('--cutover', () => {
    const deployed = async (r: Rig) => {
      assert.equal((await r.live(['--run-id', 'run_1', '--yes'])).code, 0);
      return r.h.issue().mandate; // same fixed mandate_id/domain as the one on disk
    };

    it('points the domain at the server with an Auditor PASS, and --cleanup reverts the DNS record then the server', async () => {
      await withRig({}, async (r) => {
        const mandate = await deployed(r);
        const tokenFile = join(r.dir, 'auditor.token');
        await writeFile(tokenFile, r.h.auditor(mandate));

        const { code, text } = await r.live(['--cutover', '--run-id', 'run_1', '--auditor-token', tokenFile, '--yes']);
        assert.equal(code, 0, text);
        assert.match(text, /will point\s+app\.example\.com -> 203\.0\.113\.42/);
        assert.match(text, /CUTOVER\s+step=DONE\s+servers_bought=1\s+dns_writes=1/);
        const rec = r.h.net.dns.get('app.example.com');
        assert.equal(rec?.content, SERVER_IP);
        assert.equal(rec?.ttl, 60);
        await noSecrets(r, text);

        const cleanup = await r.live(['--cleanup', '--run-id', 'run_1', '--yes']);
        assert.equal(cleanup.code, 0, cleanup.text);
        assert.match(cleanup.text, /DNS record reverted/);
        assert.equal(r.h.net.dns.size, 0);
        assert.equal(r.h.net.servers.size, 0);
      });
    });

    it('refuses an Auditor token for a different server: DNS untouched, server left running, exit 1', async () => {
      await withRig({}, async (r) => {
        const mandate = await deployed(r);
        const tokenFile = join(r.dir, 'auditor.token');
        await writeFile(tokenFile, r.h.auditor(mandate, '198.51.100.1'));

        const { code, text } = await r.live(['--cutover', '--run-id', 'run_1', '--auditor-token', tokenFile, '--yes']);
        assert.equal(code, 1, text);
        assert.match(text, /AUDITOR_WRONG_SERVER/);
        assert.equal(r.h.net.dns.size, 0);
        assert.equal(r.h.net.servers.size, 1);
        assert.equal((await r.state('run_1')).step, 'P8_CUTOVER', 'a failed cutover can be retried');
      });
    });

    it('needs an Auditor token file, a run id, and a deployed run', async () => {
      await withRig({}, async (r) => {
        await assert.rejects(r.live(['--cutover', '--run-id', 'run_1', '--yes']), /--cutover needs --auditor-token/);
        await assert.rejects(r.live(['--cutover', '--auditor-token', 'x', '--yes']), /--cutover needs --run-id/);
        await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
        const tokenFile = join(r.dir, 'auditor.token');
        await writeFile(tokenFile, r.h.auditor(r.h.issue().mandate));
        await assert.rejects(r.live(['--cutover', '--run-id', 'run_1', '--auditor-token', tokenFile, '--yes']), /cutover needs a DEPLOYED run/);
      });
    });
  });

  describe('usage errors', () => {
    it('rejects a reused run id without --resume, and --resume without saved state', async () => {
      await withRig({}, async (r) => {
        await r.live(['--run-id', 'run_1', '--yes', '--stop-after', 'boot']);
        await assert.rejects(r.live(['--run-id', 'run_1', '--yes']), /already exists.*Use --resume/);
        await assert.rejects(r.live(['--run-id', 'nope', '--resume', '--yes']), /no saved state for nope/);
        await assert.rejects(r.live(['--resume', '--yes']), /--resume needs --run-id/);
      });
    });

    it('checks the gateway is reachable and accepts the bearer before doing anything', async () => {
      await withRig({}, async (r) => {
        await assert.rejects(r.live(['--run-id', 'a', '--yes'], { env: { GATEWAY_URL: 'http://127.0.0.1:1/mcp' } }), /cannot reach the gateway.*npm run gateway/);
        await assert.rejects(r.live(['--run-id', 'a', '--yes'], { env: { GATEWAY_BEARER_TOKEN: 'z'.repeat(40) } }), /rejected GATEWAY_BEARER_TOKEN/);
        assert.equal(r.h.net.servers.size, 0);
      });
    });

    it('rejects a mandate signed by a different key, and bad flags', async () => {
      await withRig({}, async (r) => {
        const otherPub = join(r.dir, 'other.pub');
        const { generateKeyPairSync } = await import('node:crypto');
        await writeFile(otherPub, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string);
        await assert.rejects(r.live(['--run-id', 'a', '--yes'], { env: { MANDATE_PUBLIC_KEY_FILE: otherPub } }), UsageError);
        await assert.rejects(r.live(['--run-id', 'a', '--yes', '--stop-after', 'never']), /--stop-after must be boot or deploy/);
        await assert.rejects(r.live(['--run-id', 'bad id!', '--yes']), /--run-id may only contain/);
        await assert.rejects(r.live(['--cutover', '--cleanup', '--run-id', 'a']), /separate modes/);
      });
    });
  });
});
