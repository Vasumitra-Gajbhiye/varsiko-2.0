import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnakinClient } from '../../src/gateway/clients/anakin.ts';
import { CloudflareClient } from '../../src/gateway/clients/cloudflare.ts';
import { CoolifyClient } from '../../src/gateway/clients/coolify.ts';
import { HetznerClient } from '../../src/gateway/clients/hetzner.ts';
import { VercelClient } from '../../src/gateway/clients/vercel.ts';
import { sha256Hex } from '../../src/gateway/cloudinit.ts';
import type { GatewayConfig } from '../../src/gateway/config.ts';
import { createGatewayServer } from '../../src/gateway/server.ts';
import type { GatewayDeps } from '../../src/gateway/tools.ts';
import { Vault } from '../../src/gateway/vault.ts';
import { signAuditorToken } from '../../src/pilot/auditor.ts';
import { devMandate } from '../../src/pilot/demo.ts';
import { MemoryLedger, type Ledger } from '../../src/pilot/ledger.ts';
import { signMandate, type HandoffProvision, type Mandate } from '../../src/pilot/mandate.ts';
import { NasikoGateway, nasikoProviders } from '../../src/pilot/providers.ts';
import type { RunContext } from '../../src/pilot/runbook.ts';
import { FakeInternet, SERVER_IP, type FakeInternetOptions } from './fake-internet.ts';
import { handoffMandate } from './handoff.ts';

const PREFIX = 'vmg__';
const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};
const listen = (s: Server) =>
  new Promise<number>((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
type Rule = { pattern: string; stance: 'allow' | 'ask' | 'block' };

/** Assumption (Nasiko does not document it): the most specific matching rule wins. */
export function stanceFor(rules: Rule[], name: string): Rule['stance'] {
  const hits = rules.filter((r) => new RegExp('^' + r.pattern.split('*').map(escapeRe).join('.*') + '$').test(name));
  hits.sort((a, b) => b.pattern.length - a.pattern.length);
  return hits[0]?.stance ?? 'allow'; // platform default is allow
}

/**
 * Stand-in for Nasiko's control plane. It authenticates the delegation token, namespaces
 * tools, enforces the SHIPPED tool-rules.json stances (allow/ask/block), and forwards to
 * the gateway with the connector's static bearer, exactly as the real control plane sits
 * between an agent and an MCP server.
 */
async function startFakeNasiko(gatewayUrl: string, gatewayBearer: string) {
  const rules = (JSON.parse(readFileSync('tool-rules.json', 'utf8')) as {
    'varsiko-mandate-gateway': { tool_rules: Rule[] };
  })['varsiko-mandate-gateway'].tool_rules;

  const state = {
    token: { current: 'tok_fresh' },
    approved: new Set<string>(),
    /** What the AGENT sees coming back. The leak scan runs over this. */
    traffic: [] as string[],
    calls: [] as { tool: string; args: Record<string, unknown> }[],
  };

  const server = createServer(async (req, res) => {
    const rpc = JSON.parse(await read(req)) as { id: string; method: string; params?: Record<string, any> };
    const reply = (o: unknown) => {
      const t = JSON.stringify(o);
      state.traffic.push(t);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(t);
    };
    const err = (code: number, message: string) => reply({ jsonrpc: '2.0', id: rpc.id, error: { code, message } });

    if (req.headers['x-nasiko-agent-token'] !== state.token.current) return err(-32602, 'invalid delegation token');

    const forward = async (body: unknown) =>
      (await (
        await fetch(gatewayUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${gatewayBearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as any;

    if (rpc.method === 'tools/list') {
      const out = await forward(rpc);
      out.result.tools = out.result.tools.map((t: any) => ({ ...t, name: PREFIX + t.name }));
      return reply(out);
    }
    if (rpc.method === 'tools/call') {
      const name = String(rpc.params?.name);
      const stance = stanceFor(rules, name);
      if (stance === 'block') return err(-32000, `tool ${name} is blocked by permission rules`);
      const base = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
      if (stance === 'ask' && !state.approved.has(base)) return err(-32001, `tool ${name} needs human approval`);
      state.calls.push({ tool: base, args: rpc.params?.arguments ?? {} });
      return reply(await forward({ ...rpc, params: { ...rpc.params, name: base } }));
    }
    return reply(await forward(rpc));
  });
  const port = await listen(server);
  return { ...state, url: `http://127.0.0.1:${port}/api/mcp`, close: () => close(server) };
}

export async function makeHarness(o: { net?: FakeInternetOptions } = {}) {
  const net = new FakeInternet(o.net);
  const mandateKeys = generateKeyPairSync('ed25519');
  const auditorKeys = generateKeyPairSync('ed25519');
  const template = readFileSync('cloud-init/coolify.yaml', 'utf8');
  const dir = await mkdtemp(join(tmpdir(), 'pilot-e2e-'));
  const clock = { t: new Date('2026-09-20T15:00:00Z') };
  const pem = (k: { export(o: object): string | Buffer }) => k.export({ type: 'spki', format: 'pem' }) as string;

  const cfg: GatewayConfig = {
    port: 0,
    bearerToken: 'g'.repeat(40),
    operatorToken: 'o'.repeat(40),
    dataDir: dir,
    vaultKey: 'ab'.repeat(32),
    mandatePublicKey: pem(mandateKeys.publicKey),
    auditorPublicKey: pem(auditorKeys.publicKey),
    hetznerToken: 'hz-token',
    hetznerSshKeys: ['ops-key'],
    hetznerFirewallId: 42,
    allowInsecureCoolifyHttp: false,
    appPort: '3000',
    cloudInitTemplatePath: 'cloud-init/coolify.yaml',
  };
  const deps: GatewayDeps = {
    cfg,
    ledger: new MemoryLedger(() => clock.t),
    vault: new Vault(join(dir, 'vault'), cfg.vaultKey),
    hetzner: new HetznerClient('hz-token', { fetch: net.fetch }),
    coolify: (ip, token) => new CoolifyClient(ip, token, { fetch: net.fetch }),
    cloudflare: new CloudflareClient('cf-token', { fetch: net.fetch }),
    vercel: new VercelClient('vc-token', { fetch: net.fetch }),
    anakin: new AnakinClient('ak-key', { fetch: net.fetch }),
    cloudInitTemplate: template,
    now: () => clock.t,
  };

  /** Every audit-log entry the gateway wrote. Must never contain a secret or cloud-init content. */
  const audit: Record<string, unknown>[] = [];
  const gatewayServer = createGatewayServer(deps, { bearerToken: cfg.bearerToken, operatorToken: cfg.operatorToken, log: (e) => audit.push(e) });
  const gwPort = await listen(gatewayServer);
  const gatewayUrl = `http://127.0.0.1:${gwPort}/mcp`;
  const nasiko = await startFakeNasiko(gatewayUrl, cfg.bearerToken);

  return {
    net,
    deps,
    cfg,
    clock,
    nasiko,
    audit,
    gatewayUrl,
    template,
    keys: { mandate: mandateKeys, auditor: auditorKeys },

    issue(over: Partial<Mandate> = {}) {
      const base = devMandate();
      const mandate: Mandate = {
        ...base,
        provision: { ...base.provision, cloud_init_sha256: sha256Hex(template) },
        ...over,
      };
      return { mandate, token: signMandate(mandate, mandateKeys.privateKey) };
    },

    auditor(mandate: Mandate, serverIp = SERVER_IP) {
      return signAuditorToken(
        { mandate_id: mandate.mandate_id, server_ip: serverIp, verdict: 'PASS', iat: '2026-09-20T15:00:00Z', exp: '2026-09-20T16:00:00Z' },
        auditorKeys.privateKey,
      );
    },

    /** A handoff mandate (a human buys the server), signed, pinned to this gateway's template. */
    issueHandoff(over: Partial<Mandate> = {}, prov: Partial<HandoffProvision> = {}) {
      const mandate = handoffMandate({ ...over }, { cloud_init_sha256: sha256Hex(template), ...prov });
      return { mandate, token: signMandate(mandate, mandateKeys.privateKey) };
    },

    /** Calls a gateway tool DIRECTLY with the given credential ('agent' or 'operator'), bypassing Nasiko. */
    async direct(role: 'agent' | 'operator', tool: string, args: Record<string, unknown>) {
      const res = await fetch(gatewayUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${role === 'agent' ? cfg.bearerToken : cfg.operatorToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
      });
      const body = (await res.json()) as { result?: { isError: boolean; content: { text: string }[] }; error?: { message: string } };
      const text = body.result?.content[0]?.text ?? '';
      const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      return { isError: body.result?.isError ?? true, error: parsed.error as string | undefined, data: parsed, raw: text };
    },

    async listTools(role: 'agent' | 'operator'): Promise<string[]> {
      const res = await fetch(gatewayUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${role === 'agent' ? cfg.bearerToken : cfg.operatorToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name).sort();
    },

    /** A gateway client as an agent would hold it: fresh token, talking to Nasiko. */
    client() {
      return new NasikoGateway({ url: nasiko.url, token: nasiko.token.current });
    },

    pilot(token: string, runId: string, x: { ledger?: Ledger; auditor?: string } = {}): RunContext {
      return {
        mandateToken: token,
        publicKey: mandateKeys.publicKey,
        providers: nasikoProviders(this.client(), { mandate: token, runId, auditorToken: x.auditor }),
        ledger: x.ledger ?? new MemoryLedger(),
        auditorPassToken: x.auditor,
        now: () => clock.t,
      };
    },

    async close() {
      await nasiko.close();
      await close(gatewayServer);
    },
  };
}

export type Harness = Awaited<ReturnType<typeof makeHarness>>;

export async function withHarness(o: Parameters<typeof makeHarness>[0], fn: (h: Harness) => Promise<void>) {
  const h = await makeHarness(o);
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}
